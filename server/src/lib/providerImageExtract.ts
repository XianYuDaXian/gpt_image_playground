export type GeneratedImageResult = {
  buffer: Buffer
  mimeType: string
}

export type ExtractedProviderImage = GeneratedImageResult & {
  source: 'images' | 'responses' | 'fallback'
}

function normalizeBase64Image(value: string): GeneratedImageResult {
  const match = value.match(/^data:([^;]+);base64,(.+)$/s)
  if (match) {
    return {
      mimeType: match[1] || 'image/png',
      buffer: Buffer.from(match[2] || '', 'base64'),
    }
  }

  return {
    mimeType: 'image/png',
    buffer: Buffer.from(value, 'base64'),
  }
}

/** 是否像仅支持 Images API 的模型（例如 gpt-image-2） */
export function isImagesOnlyModel(model: string | null | undefined) {
  const value = String(model ?? '').trim().toLowerCase()
  if (!value) return false
  return value.includes('gpt-image')
    || value.includes('dall-e')
    || value.includes('dalle')
    || /^imagen/i.test(value)
}

function looksLikeBase64Image(value: string) {
  const text = value.trim()
  if (!text) return false
  if (/^data:image\//i.test(text)) return true
  // 常见 PNG/JPEG/WebP base64 前缀
  if (/^(iVBORw0KGgo|\/9j\/|UklGR)/.test(text)) return true
  // 反代返回的长 base64：长度足够且字符集合法
  if (text.length >= 256 && /^[A-Za-z0-9+/\r\n]+=*$/.test(text)) return true
  return false
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim())
}

function pushUniqueImage(images: ExtractedProviderImage[], image: ExtractedProviderImage) {
  if (!image.buffer.length) return
  const exists = images.some((item) => item.buffer.equals(image.buffer))
  if (!exists) images.push(image)
}

function collectBase64Candidates(value: unknown, out: string[], depth = 0) {
  if (value == null || depth > 8) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (looksLikeBase64Image(text)) out.push(text)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBase64Candidates(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const preferredKeys = [
    'b64_json',
    'b64',
    'base64',
    'image_base64',
    'imageBase64',
    'result',
    'image',
    'data',
  ]
  for (const key of preferredKeys) {
    if (key in record) collectBase64Candidates(record[key], out, depth + 1)
  }
  for (const [key, item] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue
    if (key === 'content' || key === 'message' || key === 'output' || key === 'images') {
      collectBase64Candidates(item, out, depth + 1)
    }
  }
}

function collectUrlCandidates(value: unknown, out: string[], depth = 0) {
  if (value == null || depth > 8) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (isHttpUrl(text)) out.push(text)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlCandidates(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  const preferredKeys = ['url', 'image_url', 'imageUrl', 'file_url', 'fileUrl', 'output_url', 'outputUrl']
  for (const key of preferredKeys) {
    if (key in record) collectUrlCandidates(record[key], out, depth + 1)
  }
  for (const [key, item] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue
    if (key === 'data' || key === 'output' || key === 'images' || key === 'result' || key === 'content') {
      collectUrlCandidates(item, out, depth + 1)
    }
  }
}

export function summarizeResponseForError(json: unknown) {
  if (json == null) return '空响应'
  if (typeof json !== 'object') return `响应类型=${typeof json}`
  const record = json as Record<string, unknown>
  const keys = Object.keys(record).slice(0, 12).join(',')
  const status = record.status != null ? String(record.status) : ''
  const output = Array.isArray(record.output)
    ? record.output
      .map((item) => (item && typeof item === 'object' ? String((item as { type?: string }).type || 'unknown') : typeof item))
      .slice(0, 8)
      .join('|')
    : ''
  const dataLen = Array.isArray(record.data) ? record.data.length : null
  const parts = [
    keys ? `keys=${keys}` : '',
    status ? `status=${status}` : '',
    output ? `output_types=${output}` : '',
    dataLen != null ? `data_len=${dataLen}` : '',
  ].filter(Boolean)
  return parts.join('; ') || '无法识别响应结构'
}

async function fetchRemoteImage(url: string): Promise<GeneratedImageResult> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`图片下载失败：HTTP ${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || 'image/png',
  }
}

/**
 * 统一从 Images / Responses / 反代变体响应中提取图片。
 * 成功条件：至少解析出一张可解码图片。
 */
export async function extractImagesFromProviderResponse(json: unknown): Promise<ExtractedProviderImage[]> {
  const images: ExtractedProviderImage[] = []

  if (json && typeof json === 'object') {
    // 1) 标准 Images API：data[].b64_json / data[].url
    const data = (json as { data?: unknown }).data
    if (Array.isArray(data)) {
      for (const item of data) {
        if (!item || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        const b64 = row.b64_json ?? row.b64 ?? row.base64 ?? row.image_base64
        if (typeof b64 === 'string' && b64.trim()) {
          pushUniqueImage(images, { ...normalizeBase64Image(b64), source: 'images' })
          continue
        }
        const url = row.url ?? row.image_url
        if (typeof url === 'string' && isHttpUrl(url)) {
          pushUniqueImage(images, { ...(await fetchRemoteImage(url)), source: 'images' })
        }
      }
    }

    // 2) 标准 Responses API：output[type=image_generation_call].result
    const output = (json as { output?: unknown }).output
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        const type = String(row.type ?? '')
        if (type === 'image_generation_call' || type === 'image_generation' || type.includes('image')) {
          const result = row.result ?? row.b64_json ?? row.image_base64 ?? row.base64
          if (typeof result === 'string' && result.trim()) {
            pushUniqueImage(images, { ...normalizeBase64Image(result), source: 'responses' })
          }
          const url = row.url ?? row.image_url
          if (typeof url === 'string' && isHttpUrl(url)) {
            pushUniqueImage(images, { ...(await fetchRemoteImage(url)), source: 'responses' })
          }
        }

        // message.content 中的图片块
        if (type === 'message' && Array.isArray(row.content)) {
          for (const part of row.content) {
            if (!part || typeof part !== 'object') continue
            const content = part as Record<string, unknown>
            const partType = String(content.type ?? '')
            if (partType.includes('image') || partType === 'output_image') {
              const b64 = content.result ?? content.b64_json ?? content.image_base64 ?? content.base64
              if (typeof b64 === 'string' && b64.trim()) {
                pushUniqueImage(images, { ...normalizeBase64Image(b64), source: 'responses' })
              }
              const imageUrl = content.image_url
              if (typeof imageUrl === 'string' && isHttpUrl(imageUrl)) {
                pushUniqueImage(images, { ...(await fetchRemoteImage(imageUrl)), source: 'responses' })
              } else if (imageUrl && typeof imageUrl === 'object') {
                const nestedUrl = (imageUrl as { url?: string }).url
                if (typeof nestedUrl === 'string' && isHttpUrl(nestedUrl)) {
                  pushUniqueImage(images, { ...(await fetchRemoteImage(nestedUrl)), source: 'responses' })
                }
              }
            }
          }
        }
      }
    }
  }

  if (images.length > 0) return images

  // 3) 兜底：递归收集 base64 / url
  const b64List: string[] = []
  collectBase64Candidates(json, b64List)
  for (const item of b64List) {
    try {
      pushUniqueImage(images, { ...normalizeBase64Image(item), source: 'fallback' })
    } catch {
      // 忽略无效 base64
    }
  }
  if (images.length > 0) return images

  const urlList: string[] = []
  collectUrlCandidates(json, urlList)
  for (const url of Array.from(new Set(urlList))) {
    try {
      pushUniqueImage(images, { ...(await fetchRemoteImage(url)), source: 'fallback' })
    } catch {
      // 忽略下载失败的 URL
    }
  }

  return images
}

export async function parseProviderImageJsonResponse(response: Response, context: string) {
  const rawText = await response.text()
  if (!rawText.trim()) {
    throw new Error(`${context}：接口返回空响应体`)
  }

  let json: unknown
  try {
    json = JSON.parse(rawText) as unknown
  } catch {
    if (looksLikeBase64Image(rawText)) {
      return [normalizeBase64Image(rawText)]
    }
    const preview = rawText.slice(0, 180).replace(/\s+/g, ' ')
    throw new Error(`${context}：响应不是合法 JSON（可能被截断）。预览=${preview}`)
  }

  if (json && typeof json === 'object' && 'error' in (json as object)) {
    const err = (json as { error?: unknown }).error
    const message = typeof err === 'string'
      ? err
      : (err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message ?? '')
          : JSON.stringify(err))
    const lower = message.toLowerCase()
    if (
      lower.includes('only supported on /v1/images/generations')
      || lower.includes('only supported on /v1/images')
    ) {
      throw new Error(`模型不支持当前接口：${message}。请改用 Images 模式（/v1/images/generations）`)
    }
    throw new Error(message || `${context}：上游返回 error 字段`)
  }

  const images = await extractImagesFromProviderResponse(json)
  if (!images.length) {
    throw new Error(`接口未返回图片数据：响应中缺少 b64_json/result（${context}；${summarizeResponseForError(json)}）`)
  }
  return images.map(({ buffer, mimeType }) => ({ buffer, mimeType }))
}
