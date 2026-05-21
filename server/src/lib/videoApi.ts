import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ProviderProfileRecord } from './db.js'

export interface VideoTaskParams {
  aspect_ratio?: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  resolution: '480p' | '720p'
  duration: 6 | 10 | 15
}

export interface VideoGenerationPayload {
  prompt: string
  params: VideoTaskParams
  provider: ProviderProfileRecord
  inputImages: Array<{ filePath: string; mimeType: string }>
}

export interface VideoPollResult {
  status: string
  progress: number
  model?: string | null
  error?: { message?: string }
  usage?: unknown
  video?: {
    url?: string | null
    duration?: number
    respect_moderation?: boolean
  }
}

function buildApiUrl(baseUrl: string, pathPart: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathPart.replace(/^\/+/, '')}`
}

function buildHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Cache-Control': 'no-store, no-cache, max-age=0',
    Pragma: 'no-cache',
  }
}

async function readErrorMessage(response: Response) {
  let message = `HTTP ${response.status}`
  try {
    const payload = await response.json() as { error?: { message?: string }; message?: string }
    message = payload.error?.message ?? payload.message ?? message
  } catch {
    try {
      const text = await response.text()
      if (text) message = text
    } catch {
      /* ignore */
    }
  }
  return message
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSeconds: number) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fileToDataUrl(filePath: string, mimeType: string) {
  const buffer = await fs.readFile(filePath)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function submitVideoGeneration(payload: VideoGenerationPayload, apiKey: string) {
  const inputImageDataUrls = await Promise.all(
    payload.inputImages.map((image) => fileToDataUrl(image.filePath, image.mimeType)),
  )
  const body: Record<string, unknown> = {
    model: payload.provider.model,
    prompt: payload.prompt,
    duration: payload.params.duration,
    resolution: payload.params.resolution,
  }

  if (inputImageDataUrls.length === 0 && payload.params.aspect_ratio && payload.params.aspect_ratio !== 'auto') {
    body.aspect_ratio = payload.params.aspect_ratio
  }
  if (inputImageDataUrls[0]) {
    body.image = { url: inputImageDataUrls[0] }
  }
  if (inputImageDataUrls.length > 1) {
    body.reference_images = inputImageDataUrls.slice(1).map((url) => ({ url }))
  }

  const response = await fetchWithTimeout(
    buildApiUrl(payload.provider.baseUrl, 'videos/generations'),
    {
      method: 'POST',
      headers: {
        ...buildHeaders(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    payload.provider.timeoutSeconds,
  )

  if (!response.ok) throw new Error(await readErrorMessage(response))
  const result = await response.json() as { request_id?: string }
  if (!result.request_id) throw new Error('视频接口未返回 request_id')
  return result.request_id
}

export async function pollVideoGeneration(provider: ProviderProfileRecord, apiKey: string, requestId: string) {
  const response = await fetchWithTimeout(
    buildApiUrl(provider.baseUrl, `videos/${encodeURIComponent(requestId)}`),
    {
      method: 'GET',
      headers: buildHeaders(apiKey),
    },
    provider.timeoutSeconds,
  )
  if (!response.ok) throw new Error(await readErrorMessage(response))
  return response.json() as Promise<VideoPollResult>
}

export async function downloadVideoOutput(outputDir: string, videoUrl: string, duration?: number | null) {
  const response = await fetch(videoUrl, { headers: { 'Cache-Control': 'no-store' } })
  if (!response.ok) throw new Error(await readErrorMessage(response))
  const buffer = Buffer.from(await response.arrayBuffer())
  const filename = 'output-1.mp4'
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(path.join(outputDir, filename), buffer)
  return {
    fileName: filename,
    bytes: buffer.byteLength,
    mimeType: 'video/mp4',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    metadataJson: JSON.stringify({ duration: duration ?? null }),
  }
}
