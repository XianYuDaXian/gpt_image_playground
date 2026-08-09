import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { ProviderProfileRecord } from './db.js'
import type { GeneratedImageResult, TaskExecutionPayload, ExecuteImageTaskOptions } from './imageApi.js'
import { fetchWithProviderProxy } from './upstreamFetch.js'
import { resolveAdminGatedKieQuality } from './specialProviderQuality.js'
import { resolveEffectiveMaxReferenceImages } from './maxReferenceImages.js'

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

function isTransientHttpStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** 展开 undici/Node 网络错误链，避免只剩裸 "fetch failed"。 */
export function formatNetworkError(error: unknown, fallback = '网络请求失败') {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  let depth = 0
  while (current != null && depth < 6 && !seen.has(current)) {
    seen.add(current)
    depth += 1
    if (current instanceof Error) {
      const message = current.message?.trim()
      if (message) parts.push(message)
      const code = (current as Error & { code?: unknown }).code
      if (typeof code === 'string' && code.trim()) parts.push(code.trim())
      current = (current as Error & { cause?: unknown }).cause
      continue
    }
    if (typeof current === 'string' && current.trim()) {
      parts.push(current.trim())
      break
    }
    break
  }
  const unique = Array.from(new Set(parts.map((item) => item.trim()).filter(Boolean)))
  return unique.join(' | ') || fallback
}

export function isTransientNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const message = formatNetworkError(error).toLowerCase()
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
    || message.includes('enotfound')
    || message.includes('eai_again')
    || message.includes('socket hang up')
    || message.includes('und_err')
  )
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
      const response = await fetchWithTimeout(url, init, timeoutSeconds, provider)
      if (!response.ok && isTransientHttpStatus(response.status) && i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * i))
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (i >= attempts || !isTransientNetworkError(error)) {
        throw error instanceof Error
          ? new Error(formatNetworkError(error), { cause: error })
          : new Error(formatNetworkError(error))
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * i))
    }
  }
  throw lastError instanceof Error
    ? new Error(formatNetworkError(lastError), { cause: lastError })
    : new Error(formatNetworkError(lastError))
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

function closestAspectRatio(width: number, height: number): AspectRatio {
  const value = width / height
  const candidates: Array<{ ratio: AspectRatio; value: number }> = [
    { ratio: '1:1', value: 1 },
    { ratio: '4:3', value: 4 / 3 },
    { ratio: '3:4', value: 3 / 4 },
    { ratio: '16:9', value: 16 / 9 },
    { ratio: '9:16', value: 9 / 16 },
    { ratio: '2:3', value: 2 / 3 },
    { ratio: '3:2', value: 3 / 2 },
  ]
  let best = candidates[0]
  let bestDelta = Math.abs(value - best.value)
  for (const item of candidates.slice(1)) {
    const delta = Math.abs(value - item.value)
    if (delta < bestDelta) {
      best = item
      bestDelta = delta
    }
  }
  return best.ratio
}

async function mapSizeToAspectRatio(
  size: string,
  referenceImagePath?: string,
  autoFromReference = true,
): Promise<AspectRatio> {
  const normalized = size.trim().toLowerCase()
  if (normalized === 'auto') {
    if (autoFromReference && referenceImagePath) {
      try {
        const meta = await sharp(referenceImagePath).metadata()
        if (meta.width && meta.height) return closestAspectRatio(meta.width, meta.height)
      } catch {
        /* ignore */
      }
    }
    return '1:1'
  }
  const parsed = parseImageSize(size)
  if (!parsed) return '1:1'
  return closestAspectRatio(parsed.width, parsed.height)
}

function mapOutputFormat(format: string) {
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

export function parseKieResultUrls(resultJson?: string | null) {
  if (!resultJson?.trim()) return [] as string[]
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown }
    return Array.isArray(parsed.resultUrls)
      ? parsed.resultUrls.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []
  } catch {
    throw new Error('Kie resultJson 解析失败')
  }
}

async function waitForTask(provider: ProviderProfileRecord, apiKey: string, taskId: string) {
  const startedAt = Date.now()
  const timeoutMs = Math.max(30, provider.timeoutSeconds) * 1000
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const data = await queryTask(provider, apiKey, taskId)
      const state = String(data.state || '').toLowerCase()
      if (state === 'success') {
        const urls = parseKieResultUrls(data.resultJson)
        if (!urls.length) throw new Error('Kie 任务成功但未返回 resultUrls')
        return urls
      }
      if (state === 'fail' || state === 'failed' || state === 'error') {
        throw new Error(data.failMsg || data.failCode || 'Kie 任务失败')
      }
    } catch (error) {
      // 轮询偶发网络抖动时继续等，避免上游已完成后被本地误判失败
      if (!isTransientNetworkError(error)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  throw new Error('Kie 任务超时')
}

async function downloadRemoteImage(url: string): Promise<GeneratedImageResult> {
  // 结果 CDN 偶发超时/断连，下载阶段单独加重试
  let response: Response
  try {
    response = await fetchWithRetry(
      url,
      { headers: { 'Cache-Control': 'no-store' } },
      120,
      undefined,
      6,
    )
  } catch (error) {
    throw new Error(`远端图片下载失败：${formatNetworkError(error)}`, { cause: error instanceof Error ? error : undefined })
  }
  if (!response.ok) throw new Error(`远端图片下载失败：${await readErrorMessage(response)}`)
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

async function downloadResultImages(urls: string[]) {
  const images: GeneratedImageResult[] = []
  // 串行下载，避免并发把弱网打满后全部失败
  for (const url of urls) {
    images.push(await downloadRemoteImage(url))
  }
  return images
}

async function materializeKieOutputs(
  provider: ProviderProfileRecord,
  apiKey: string,
  taskId: string,
  urls: string[],
) {
  try {
    return await downloadResultImages(urls)
  } catch (firstError) {
    // 上游已成功时，再查一次结果 URL 后重下，降低 CDN 短时失效概率
    let freshUrls = urls
    try {
      const data = await queryTask(provider, apiKey, taskId)
      if (String(data.state || '').toLowerCase() === 'success') {
        const nextUrls = parseKieResultUrls(data.resultJson)
        if (nextUrls.length > 0) freshUrls = nextUrls
      }
    } catch {
      /* 使用首轮 URL */
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return await downloadResultImages(freshUrls)
    } catch (secondError) {
      throw new Error(
        `远端已出图但本地下载失败：${formatNetworkError(secondError, formatNetworkError(firstError))}`,
        { cause: secondError instanceof Error ? secondError : firstError instanceof Error ? firstError : undefined },
      )
    }
  }
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
  options: ExecuteImageTaskOptions = {},
): Promise<GeneratedImageResult[]> {
  if (payload.maskImage) {
    throw new Error('Kie 模式暂不支持遮罩编辑')
  }

  const imageCount = payload.inputImages.length
  const maxImages = resolveEffectiveMaxReferenceImages(payload.provider)
  if (imageCount > maxImages) {
    throw new Error(`当前 Kie 配置最多支持 ${maxImages} 张参考图`)
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
  options.onUpstreamRequestId?.(taskId)

  const urls = await waitForTask(payload.provider, apiKey, taskId)
  return materializeKieOutputs(payload.provider, apiKey, taskId, urls)
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

/** 按上游 taskId 再查详情并下载结果图（用于本地下载失败后的恢复）。 */
export async function recoverKieTaskOutputs(
  provider: ProviderProfileRecord,
  apiKey: string,
  upstreamTaskId: string,
): Promise<GeneratedImageResult[]> {
  const taskId = String(upstreamTaskId || "").trim();
  if (!taskId) throw new Error("缺少上游 taskId，无法恢复结果");

  const data = await queryTask(provider, apiKey, taskId);
  const state = String(data.state || "").toLowerCase();
  if (state === "fail" || state === "failed" || state === "error") {
    throw new Error(data.failMsg || data.failCode || "Kie 任务失败");
  }
  if (state !== "success") {
    // 仍在生成中时继续等到完成或超时
    const urls = await waitForTask(provider, apiKey, taskId);
    return materializeKieOutputs(provider, apiKey, taskId, urls);
  }

  const urls = parseKieResultUrls(data.resultJson);
  if (!urls.length) throw new Error("Kie 任务成功但未返回 resultUrls");
  return materializeKieOutputs(provider, apiKey, taskId, urls);
}

export async function executeKieImageTask(
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
) {
  if (payload.params.n <= 1) {
    return runSingleKie(payload, apiKey, options)
  }
  return runSerialSingles(payload.params.n, () => runSingleKie(payload, apiKey, options), options)
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
