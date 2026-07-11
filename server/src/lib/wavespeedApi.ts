import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { ProviderProfileRecord } from './db.js'
import type { GeneratedImageResult, TaskExecutionPayload, ExecuteImageTaskOptions } from './imageApi.js'
import { fetchWithProviderProxy } from './upstreamFetch.js'

type AspectRatio =
  | '1:1'
  | '4:3'
  | '3:4'
  | '16:9'
  | '9:16'
  | '2:3'
  | '3:2'

type WaveSpeedResolution = '1k' | '2k' | '4k'

interface WaveSpeedSubmitData {
  id?: string
  status?: string
  outputs?: string[]
  urls?: { get?: string }
  error?: string
  code?: number
  message?: string
}

interface WaveSpeedEnvelope {
  code?: number
  message?: string
  data?: WaveSpeedSubmitData
}

function buildHeaders(apiKey: string, contentType?: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
}

function normalizeBase(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, pathPart: string) {
  return `${normalizeBase(baseUrl)}/${pathPart.replace(/^\/+/, '')}`
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSeconds: number, provider?: ProviderProfileRecord) {
  if (provider) {
    return fetchWithProviderProxy(provider, url, init, timeoutSeconds)
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), Math.max(10, timeoutSeconds) * 1000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

function isTransientHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function isTransientError(error: unknown) {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('http 408')
    || message.includes('http 425')
    || message.includes('http 429')
    || message.includes('http 500')
    || message.includes('http 502')
    || message.includes('http 503')
    || message.includes('http 504')
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('timeout')
    || message.includes('aborted')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('socket hang up')
  )
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  provider?: ProviderProfileRecord,
  attempts = 4,
) {
  let lastError: unknown
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutSeconds, provider)
      if (!response.ok && isTransientHttpStatus(response.status) && i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * i))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (i >= attempts || !isTransientError(error)) {
        throw error instanceof Error ? error : new Error(String(error))
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * i))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function readErrorMessage(response: Response) {
  const statusPrefix = `HTTP ${response.status}`
  try {
    const payload = await response.json() as Record<string, unknown>
    const message = payload.message ?? payload.msg ?? payload.error
    if (typeof message === 'string' && message.trim()) return `${statusPrefix} - ${message.trim()}`
    return `${statusPrefix} - ${JSON.stringify(payload)}`
  } catch {
    try {
      const text = (await response.text()).trim()
      if (text) return `${statusPrefix} - ${text}`
    } catch {
      /* ignore */
    }
  }
  return statusPrefix
}

function parseImageSize(size: string) {
  const match = size.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

const ASPECT_RATIOS: AspectRatio[] = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2']

function nearestAspectRatio(width: number, height: number): AspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1:1'
  const actual = width / height
  return ASPECT_RATIOS
    .map((item) => {
      const [w, h] = item.split(':').map(Number)
      const ratio = w / h
      return { value: item, delta: Math.abs(actual - ratio) / ratio }
    })
    .sort((a, b) => a.delta - b.delta)[0]?.value ?? '1:1'
}

function pickResolution(longEdge: number, allowHighResolution: boolean): WaveSpeedResolution {
  if (!allowHighResolution) return '1k'
  if (longEdge >= 3000) return '4k'
  if (longEdge >= 1500) return '2k'
  return '1k'
}

async function readLocalImageSize(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(filePath, { animated: false }).metadata()
    if (!metadata.width || !metadata.height) return null
    return { width: metadata.width, height: metadata.height }
  } catch {
    return null
  }
}

async function mapSizeToAspectAndResolution(
  size: string,
  allowHighResolution: boolean,
  referenceImagePath?: string | null,
  autoAspectFromReference = true,
): Promise<{ aspectRatio: AspectRatio; resolution: WaveSpeedResolution }> {
  const parsed = parseImageSize(size)
  if (parsed) {
    return {
      aspectRatio: nearestAspectRatio(parsed.width, parsed.height),
      resolution: pickResolution(Math.max(parsed.width, parsed.height), allowHighResolution),
    }
  }

  // size=auto 时：有参考图则按参考图比例，否则回退 1:1
  if (autoAspectFromReference && referenceImagePath) {
    const imageSize = await readLocalImageSize(referenceImagePath)
    if (imageSize) {
      return {
        aspectRatio: nearestAspectRatio(imageSize.width, imageSize.height),
        resolution: pickResolution(Math.max(imageSize.width, imageSize.height), allowHighResolution),
      }
    }
  }

  return { aspectRatio: '1:1', resolution: '1k' }
}

function pickWaveSpeedModel(provider: ProviderProfileRecord, kind: 'generate' | 'edit' | 'multi-edit') {
  const options = provider.modelOptions ?? []
  const generateModel = (options[1] || options[0] || provider.model || '').trim()
  const editModel = (options[2] || '').trim() || (generateModel ? `${generateModel.replace(/\/edit$/, '')}/edit` : '')
  const multiEditModel = (options[3] || editModel || '').trim()
  if (kind === 'generate') return generateModel
  if (kind === 'multi-edit') return multiEditModel
  return editModel
}

function assertWaveSpeedCapability(provider: ProviderProfileRecord, kind: 'generate' | 'edit' | 'multi-edit') {
  if (kind === 'generate' && provider.veniceGenerateEnabled === 0) {
    throw new Error('当前 WaveSpeed 配置已禁用文生图')
  }
  if (kind === 'edit' && provider.veniceEditEnabled === 0) {
    throw new Error('当前 WaveSpeed 配置已禁用单图编辑')
  }
  if (kind === 'multi-edit' && provider.veniceMultiEditEnabled === 0) {
    throw new Error('当前 WaveSpeed 配置已禁用多图编辑')
  }
}

function guessMimeType(filePath: string, fallback?: string) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.png') return 'image/png'
  return fallback || 'application/octet-stream'
}

async function uploadBinary(
  provider: ProviderProfileRecord,
  apiKey: string,
  filePath: string,
  mimeType: string,
) {
  const buffer = await fs.readFile(filePath)
  const form = new FormData()
  const fileName = path.basename(filePath) || 'input.png'
  form.append('file', new Blob([Uint8Array.from(buffer)], { type: mimeType || guessMimeType(filePath, mimeType) }), fileName)

  const response = await fetchWithTimeout(
    joinUrl(provider.baseUrl, 'media/upload/binary'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: form,
    },
    provider.timeoutSeconds,
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload = await response.json() as {
    code?: number
    message?: string
    data?: { download_url?: string; url?: string }
    download_url?: string
    url?: string
  }
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.message || 'WaveSpeed 上传失败')
  }
  const url = payload.data?.download_url || payload.data?.url || payload.download_url || payload.url
  if (!url) throw new Error('WaveSpeed 上传未返回 download_url')
  return url
}

async function submitPrediction(
  provider: ProviderProfileRecord,
  apiKey: string,
  modelPath: string,
  body: Record<string, unknown>,
) {
  const response = await fetchWithTimeout(
    joinUrl(provider.baseUrl, modelPath),
    {
      method: 'POST',
      headers: buildHeaders(apiKey, 'application/json'),
      body: JSON.stringify(body),
    },
    provider.timeoutSeconds,
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload = await response.json() as WaveSpeedEnvelope
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.message || `WaveSpeed 提交失败 code=${payload.code}`)
  }
  const id = payload.data?.id
  if (!id) throw new Error('WaveSpeed 未返回 prediction id')
  return id
}

async function pollPrediction(
  provider: ProviderProfileRecord,
  apiKey: string,
  predictionId: string,
) {
  const response = await fetchWithRetry(
    joinUrl(provider.baseUrl, `predictions/${encodeURIComponent(predictionId)}/result`),
    {
      method: 'GET',
      headers: buildHeaders(apiKey),
    },
    Math.min(60, provider.timeoutSeconds),
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload = await response.json() as WaveSpeedEnvelope
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.message || `WaveSpeed 查询失败 code=${payload.code}`)
  }
  return payload.data ?? {}
}

async function waitForPrediction(
  provider: ProviderProfileRecord,
  apiKey: string,
  predictionId: string,
) {
  const startedAt = Date.now()
  const timeoutMs = Math.max(30, provider.timeoutSeconds) * 1000
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const data = await pollPrediction(provider, apiKey, predictionId)
      const status = String(data.status || '').toLowerCase()
      if (status === 'completed' || status === 'succeeded') {
        const outputs = Array.isArray(data.outputs) ? data.outputs.filter(Boolean) : []
        if (!outputs.length) throw new Error('WaveSpeed 任务完成但未返回 outputs')
        return outputs
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(data.error || data.message || 'WaveSpeed 任务失败')
      }
    } catch (error) {
      // 轮询偶发 504/网络错误时继续等待，避免上游已完成却被本地判失败
      if (!isTransientError(error)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  throw new Error('WaveSpeed 任务超时')
}

async function downloadRemoteImage(url: string): Promise<GeneratedImageResult> {
  // 结果 CDN 偶发 504，下载阶段单独加重试
  const response = await fetchWithRetry(
    url,
    { headers: { 'Cache-Control': 'no-store' } },
    120,
    undefined,
    5,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('WaveSpeed 输出图片为空')
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  const mimeType = contentType.startsWith('image/')
    ? contentType
    : url.toLowerCase().includes('.png')
      ? 'image/png'
      : url.toLowerCase().includes('.webp')
        ? 'image/webp'
        : 'image/jpeg'
  return { buffer, mimeType }
}

function looksLikeHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim())
}

function decodeBase64Output(value: string, outputFormatHint?: string): GeneratedImageResult {
  const trimmed = value.trim()
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i)
  const mimeFromDataUrl = dataUrlMatch?.[1]?.toLowerCase()
  const base64Body = (dataUrlMatch?.[2] || trimmed).replace(/\s+/g, '')
  let buffer: Buffer
  try {
    buffer = Buffer.from(base64Body, 'base64')
  } catch {
    throw new Error('WaveSpeed base64 输出解码失败')
  }
  if (!buffer.length) throw new Error('WaveSpeed base64 输出为空')

  const hint = outputFormatHint?.trim().toLowerCase()
  const mimeType = mimeFromDataUrl && mimeFromDataUrl.startsWith('image/')
    ? mimeFromDataUrl
    : hint === 'png'
      ? 'image/png'
      : hint === 'webp'
        ? 'image/webp'
        : 'image/jpeg'
  return { buffer, mimeType }
}

async function materializeWaveSpeedOutputs(
  outputs: string[],
  outputFormatHint?: string,
): Promise<GeneratedImageResult[]> {
  const images: GeneratedImageResult[] = []
  for (const item of outputs) {
    if (!item || typeof item !== 'string') continue
    if (looksLikeHttpUrl(item)) {
      images.push(await downloadRemoteImage(item))
      continue
    }
    // enable_base64_output=true 时 outputs 为 base64 / data URL
    images.push(decodeBase64Output(item, outputFormatHint))
  }
  if (!images.length) throw new Error('WaveSpeed 未返回可用图片数据')
  return images
}

async function runSingleWaveSpeed(
  payload: TaskExecutionPayload,
  apiKey: string,
): Promise<GeneratedImageResult[]> {
  if (payload.maskImage) {
    throw new Error('WaveSpeed 模式暂不支持遮罩编辑')
  }

  const imageCount = payload.inputImages.length
  if (imageCount > 3) {
    throw new Error('当前 WaveSpeed 配置最多支持 3 张参考图')
  }
  const kind: 'generate' | 'edit' | 'multi-edit' = imageCount <= 0
    ? 'generate'
    : imageCount === 1
      ? 'edit'
      : 'multi-edit'
  assertWaveSpeedCapability(payload.provider, kind)
  const modelPath = pickWaveSpeedModel(payload.provider, kind)
  if (!modelPath) throw new Error('WaveSpeed 缺少模型 ID')

  const allowHighResolution = Boolean(payload.provider.xaiImage2kEnabled)
  const sizeParams = await mapSizeToAspectAndResolution(
    payload.params.size,
    allowHighResolution,
    payload.inputImages[0]?.filePath,
    Number(payload.provider.autoAspectFromReference ?? 1) !== 0,
  )
  const enableBase64 = Boolean(payload.provider.enableBase64Output) || Boolean(payload.provider.responseFormatB64Json)
  const enableSync = Boolean(payload.provider.enableSyncMode)

  const hasInputs = imageCount > 0

  let imageUrls: string[] = []
  if (hasInputs) {
    imageUrls = []
    for (const image of payload.inputImages) {
      imageUrls.push(await uploadBinary(payload.provider, apiKey, image.filePath, image.mimeType))
    }
  }

  const body: Record<string, unknown> = {
    prompt: payload.prompt,
    enable_base64_output: enableBase64,
    enable_sync_mode: enableSync,
    output_format: payload.params.output_format,
    resolution: sizeParams.resolution,
    aspect_ratio: sizeParams.aspectRatio,
  }

  if (hasInputs) {
    body.images = imageUrls
  }

  // 同步模式：直接拿结果；失败则回退异步
  if (enableSync) {
    const response = await fetchWithTimeout(
      joinUrl(payload.provider.baseUrl, modelPath),
      {
        method: 'POST',
        headers: buildHeaders(apiKey, 'application/json'),
        body: JSON.stringify(body),
      },
      payload.provider.timeoutSeconds,
        payload.provider,
      )
    if (!response.ok) throw new Error(await readErrorMessage(response))
    const payloadJson = await response.json() as WaveSpeedEnvelope
    if (payloadJson.code != null && payloadJson.code !== 200) {
      throw new Error(payloadJson.message || 'WaveSpeed 同步生成失败')
    }
    const outputs = payloadJson.data?.outputs ?? []
    if (outputs.length > 0) {
      return materializeWaveSpeedOutputs(outputs, payload.params.output_format)
    }
    // 同步未直接返回输出时，继续异步轮询
    const id = payloadJson.data?.id
    if (!id) throw new Error('WaveSpeed 同步模式未返回结果')
    const asyncOutputs = await waitForPrediction(payload.provider, apiKey, id)
    return materializeWaveSpeedOutputs(asyncOutputs, payload.params.output_format)
  }

  const predictionId = await submitPrediction(payload.provider, apiKey, modelPath, {
    ...body,
    enable_sync_mode: false,
  })
  const outputs = await waitForPrediction(payload.provider, apiKey, predictionId)
  return materializeWaveSpeedOutputs(outputs, payload.params.output_format)
}

async function runConcurrentSingles(
  total: number,
  runner: () => Promise<GeneratedImageResult[]>,
  options: ExecuteImageTaskOptions,
) {
  let completed = 0
  const images: GeneratedImageResult[] = []
  // WaveSpeed 套餐并发有限，串行更稳
  for (let index = 0; index < total; index += 1) {
    const batch = await runner()
    completed += 1
    await options.onImagesReady?.(batch, { completed, total })
    options.onImageComplete?.(completed, total)
    images.push(...batch)
  }
  return images
}

export async function executeWaveSpeedImageTask(
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
) {
  if (payload.params.n <= 1) {
    return runSingleWaveSpeed(payload, apiKey)
  }
  return runConcurrentSingles(payload.params.n, () => runSingleWaveSpeed(payload, apiKey), options)
}

export type WaveSpeedBalanceResult = {
  supported: true
  unit: 'USD'
  balance: number
  raw?: unknown
}

/** 查询 WaveSpeed 账户余额（美元） */
export async function fetchWaveSpeedBalance(
  provider: Pick<ProviderProfileRecord, 'baseUrl' | 'timeoutSeconds' | 'proxyEnabled' | 'proxyUrl'>,
  apiKey: string,
): Promise<WaveSpeedBalanceResult> {
  const key = apiKey.trim()
  if (!key) throw new Error('缺少 API Key，无法查询余额')
  const baseUrl = provider.baseUrl?.trim()
  if (!baseUrl) throw new Error('缺少 API URL，无法查询余额')

  const response = await fetchWithTimeout(
    joinUrl(baseUrl, 'balance'),
    {
      method: 'GET',
      headers: buildHeaders(key),
    },
    Math.min(Math.max(10, provider.timeoutSeconds || 30), 60),
    provider as ProviderProfileRecord,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))

  const payload = await response.json() as WaveSpeedEnvelope & { data?: { balance?: number } }
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.message || 'WaveSpeed 余额查询失败')
  }

  const balance = Number((payload.data as { balance?: number } | undefined)?.balance)
  if (!Number.isFinite(balance)) {
    throw new Error('WaveSpeed 余额响应格式无效')
  }

  return {
    supported: true,
    unit: 'USD',
    balance,
    raw: payload,
  }
}
