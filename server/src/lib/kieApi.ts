import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { ProviderProfileRecord } from './db.js'
import type { GeneratedImageResult, TaskExecutionPayload, ExecuteImageTaskOptions } from './imageApi.js'
import { fetchWithProviderProxy } from './upstreamFetch.js'
import { resolveAdminGatedKieQuality } from './specialProviderQuality.js'

type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '2:3' | '3:2'
type KieTaskKind = 'generate' | 'edit' | 'multi-edit'

const KIE_UPLOAD_BASE_URL = 'https://kieai.redpandaai.co'

interface KieCreateResponse {
  code?: number
  msg?: string
  message?: string
  data?: { taskId?: string; recordId?: string }
}

interface KieRecordData {
  taskId?: string
  model?: string
  state?: string
  resultJson?: string
  failCode?: string | null
  failMsg?: string | null
  costTime?: number | null
}

interface KieRecordResponse {
  code?: number
  msg?: string
  message?: string
  data?: KieRecordData
}

interface KieUploadResponse {
  success?: boolean
  code?: number
  msg?: string
  message?: string
  data?: {
    fileName?: string
    filePath?: string
    downloadUrl?: string
    fileUrl?: string
    fileSize?: number
    mimeType?: string
  }
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  provider?: ProviderProfileRecord,
) {
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
      return await fetchWithTimeout(url, init, timeoutSeconds, provider)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * i))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function readErrorMessage(response: Response) {
  const statusPrefix = `HTTP ${response.status}`
  try {
    const payload = await response.json() as Record<string, unknown>
    const message = payload.msg ?? payload.message ?? payload.error
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

async function readLocalImageSize(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(filePath, { animated: false }).metadata()
    if (!metadata.width || !metadata.height) return null
    return { width: metadata.width, height: metadata.height }
  } catch {
    return null
  }
}

async function mapSizeToAspectRatio(
  size: string,
  referenceImagePath?: string | null,
  autoAspectFromReference = true,
): Promise<AspectRatio> {
  const parsed = parseImageSize(size)
  if (parsed) return nearestAspectRatio(parsed.width, parsed.height)

  // size=auto 时：有参考图则按参考图比例，否则回退 1:1
  if (autoAspectFromReference && referenceImagePath) {
    const imageSize = await readLocalImageSize(referenceImagePath)
    if (imageSize) return nearestAspectRatio(imageSize.width, imageSize.height)
  }

  return '1:1'
}


function mapOutputFormat(format: TaskExecutionPayload['params']['output_format']): 'png' | 'jpeg' {
  return format === 'jpeg' ? 'jpeg' : 'png'
}

function guessExtension(mimeType: string, filePath: string) {
  const fromPath = path.extname(filePath).replace('.', '').toLowerCase()
  if (fromPath) return fromPath
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  return 'png'
}

function pickKieModel(provider: ProviderProfileRecord, kind: KieTaskKind) {
  const options = provider.modelOptions ?? []
  const generateModel = (options[1] || provider.model || 'seedream/5-pro-text-to-image').trim()
  const editModel = (options[2] || 'seedream/5-pro-image-to-image').trim()
  const multiEditModel = (options[3] || editModel || 'seedream/5-pro-image-to-image').trim()
  if (kind === 'generate') return generateModel
  if (kind === 'multi-edit') return multiEditModel
  return editModel
}

function assertKieCapability(provider: ProviderProfileRecord, kind: KieTaskKind) {
  if (kind === 'generate' && provider.veniceGenerateEnabled === 0) {
    throw new Error('当前 Kie 配置已禁用文生图')
  }
  if (kind === 'edit' && provider.veniceEditEnabled === 0) {
    throw new Error('当前 Kie 配置已禁用单图编辑')
  }
  if (kind === 'multi-edit' && provider.veniceMultiEditEnabled === 0) {
    throw new Error('当前 Kie 配置已禁用多图编辑')
  }
}

function resolveTaskKind(imageCount: number): KieTaskKind {
  if (imageCount <= 0) return 'generate'
  if (imageCount === 1) return 'edit'
  return 'multi-edit'
}

async function createTask(provider: ProviderProfileRecord, apiKey: string, body: Record<string, unknown>) {
  const response = await fetchWithRetry(
    joinUrl(provider.baseUrl, 'jobs/createTask'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey, 'application/json'),
      body: JSON.stringify(body),
    },
    provider.timeoutSeconds,
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload = await response.json() as KieCreateResponse
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.msg || payload.message || `Kie 提交失败 code=${payload.code}`)
  }
  const taskId = payload.data?.taskId
  if (!taskId) throw new Error('Kie 未返回 taskId')
  return taskId
}

async function queryTask(provider: ProviderProfileRecord, apiKey: string, taskId: string) {
  const response = await fetchWithRetry(
    `${joinUrl(provider.baseUrl, 'jobs/recordInfo')}?taskId=${encodeURIComponent(taskId)}`,
    {
      method: 'GET',
      headers: buildHeaders(apiKey),
    },
    Math.min(60, provider.timeoutSeconds),
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const payload = await response.json() as KieRecordResponse
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.msg || payload.message || `Kie 查询失败 code=${payload.code}`)
  }
  return payload.data ?? {}
}

async function waitForTask(provider: ProviderProfileRecord, apiKey: string, taskId: string) {
  const startedAt = Date.now()
  const timeoutMs = Math.max(30, provider.timeoutSeconds) * 1000
  while (Date.now() - startedAt <= timeoutMs) {
    const data = await queryTask(provider, apiKey, taskId)
    const state = String(data.state || '').toLowerCase()
    if (state === 'success') {
      let urls: string[] = []
      try {
        const parsed = JSON.parse(data.resultJson || '{}') as { resultUrls?: string[] }
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter(Boolean) : []
      } catch {
        throw new Error('Kie resultJson 解析失败')
      }
      if (!urls.length) throw new Error('Kie 任务成功但未返回 resultUrls')
      return urls
    }
    if (state === 'fail' || state === 'failed' || state === 'error') {
      throw new Error(data.failMsg || data.failCode || 'Kie 任务失败')
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  throw new Error('Kie 任务超时')
}

async function downloadRemoteImage(url: string): Promise<GeneratedImageResult> {
  const response = await fetchWithRetry(url, { headers: { 'Cache-Control': 'no-store' } }, 120, undefined, 3)
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('Kie 输出图片为空')
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

async function uploadLocalImage(
  provider: ProviderProfileRecord,
  apiKey: string,
  filePath: string,
  mimeType: string,
  index: number,
) {
  const buffer = await fs.readFile(filePath)
  const ext = guessExtension(mimeType, filePath)
  const fileName = `kie-input-${Date.now()}-${index + 1}.${ext}`
  const form = new FormData()
  form.append('file', new Blob([Uint8Array.from(buffer)], { type: mimeType || 'application/octet-stream' }), fileName)
  form.append('uploadPath', 'images/gpt-image-playground')
  form.append('fileName', fileName)

  const response = await fetchWithRetry(
    joinUrl(KIE_UPLOAD_BASE_URL, 'api/file-stream-upload'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: form,
    },
    Math.max(60, provider.timeoutSeconds),
    provider,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))

  const payload = await response.json() as KieUploadResponse
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.msg || payload.message || 'Kie 上传失败')
  }
  const url = payload.data?.downloadUrl || payload.data?.fileUrl
  if (!url) throw new Error('Kie 上传未返回 downloadUrl')
  return url
}

async function uploadInputImages(
  provider: ProviderProfileRecord,
  apiKey: string,
  inputImages: TaskExecutionPayload['inputImages'],
) {
  const urls: string[] = []
  for (let index = 0; index < inputImages.length; index += 1) {
    const image = inputImages[index]
    urls.push(await uploadLocalImage(provider, apiKey, image.filePath, image.mimeType, index))
  }
  return urls
}

async function runSingleKie(
  payload: TaskExecutionPayload,
  apiKey: string,
): Promise<GeneratedImageResult[]> {
  if (payload.maskImage) {
    throw new Error('Kie 模式暂不支持遮罩编辑')
  }

  const imageCount = payload.inputImages.length
  if (imageCount > 3) {
    throw new Error('当前 Kie 配置最多支持 3 张参考图')
  }

  const kind = resolveTaskKind(imageCount)
  assertKieCapability(payload.provider, kind)

  const model = pickKieModel(payload.provider, kind)
  if (!model) throw new Error('Kie 缺少模型 ID')

  // 质量：管理员开关门控；仅 high 且开关开启时传 high，否则 basic
  // 审核：始终发送 nsfw_checker，值仅跟随管理员开关，忽略用户审核选项
  const input: Record<string, unknown> = {
    prompt: payload.prompt,
    aspect_ratio: await mapSizeToAspectRatio(
      payload.params.size,
      payload.inputImages[0]?.filePath,
      Number(payload.provider.autoAspectFromReference ?? 1) !== 0,
    ),
    quality: resolveAdminGatedKieQuality({
      adminHighEnabled: Boolean(payload.provider.xaiImage2kEnabled),
      userQuality: payload.params.quality,
    }),
    nsfw_checker: Number(payload.provider.nsfwChecker ?? 1) !== 0,
  }

  if (kind === 'generate') {
    // 文生图不需要 image_urls
  } else {
    // 图生图必须先上传本地文件，再传公网 URL
    const imageUrls = await uploadInputImages(payload.provider, apiKey, payload.inputImages)
    input.image_urls = imageUrls
    input.output_format = mapOutputFormat(payload.params.output_format)
  }

  const taskId = await createTask(payload.provider, apiKey, {
    model,
    input,
  })
  const urls = await waitForTask(payload.provider, apiKey, taskId)
  return Promise.all(urls.map((url) => downloadRemoteImage(url)))
}

async function runSerialSingles(
  total: number,
  runner: () => Promise<GeneratedImageResult[]>,
  options: ExecuteImageTaskOptions,
) {
  let completed = 0
  const images: GeneratedImageResult[] = []
  for (let index = 0; index < total; index += 1) {
    const batch = await runner()
    completed += 1
    await options.onImagesReady?.(batch, { completed, total })
    options.onImageComplete?.(completed, total)
    images.push(...batch)
  }
  return images
}

export async function executeKieImageTask(
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
) {
  if (payload.params.n <= 1) {
    return runSingleKie(payload, apiKey)
  }
  return runSerialSingles(payload.params.n, () => runSingleKie(payload, apiKey), options)
}

export type KieBalanceResult = {
  supported: true
  unit: 'credits'
  balance: number
  raw?: unknown
}

/** 查询 Kie 账户积分余额 */
export async function fetchKieBalance(
  provider: Pick<ProviderProfileRecord, 'baseUrl' | 'timeoutSeconds' | 'proxyEnabled' | 'proxyUrl'>,
  apiKey: string,
): Promise<KieBalanceResult> {
  const key = apiKey.trim()
  if (!key) throw new Error('缺少 API Key，无法查询余额')
  const baseUrl = provider.baseUrl?.trim()
  if (!baseUrl) throw new Error('缺少 API URL，无法查询余额')

  const response = await fetchWithTimeout(
    joinUrl(baseUrl, 'chat/credit'),
    {
      method: 'GET',
      headers: buildHeaders(key),
    },
    Math.min(Math.max(10, provider.timeoutSeconds || 30), 60),
    provider as ProviderProfileRecord,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))

  const payload = await response.json() as {
    code?: number
    msg?: string
    message?: string
    data?: number | { balance?: number; credit?: number; credits?: number }
  }
  if (payload.code != null && payload.code !== 200) {
    throw new Error(payload.msg || payload.message || 'Kie 余额查询失败')
  }

  let balance: number | null = null
  if (typeof payload.data === 'number') {
    balance = payload.data
  } else if (payload.data && typeof payload.data === 'object') {
    const candidate = payload.data.balance ?? payload.data.credit ?? payload.data.credits
    if (candidate != null) balance = Number(candidate)
  }
  if (balance == null || !Number.isFinite(balance)) {
    throw new Error('Kie 余额响应格式无效')
  }

  return {
    supported: true,
    unit: 'credits',
    balance,
    raw: payload,
  }
}
