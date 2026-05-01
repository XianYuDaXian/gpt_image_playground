import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AppDatabase, ProviderProfileRecord } from './db.js'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

export interface RuntimeSettingsRecord {
  codexCli?: boolean
}

export interface TaskImageInput {
  filePath: string
  mimeType: string
}

export interface TaskExecutionPayload {
  prompt: string
  params: {
    size: string
    quality: 'auto' | 'low' | 'medium' | 'high'
    output_format: 'png' | 'jpeg' | 'webp'
    output_compression: number | null
    moderation: 'auto' | 'low'
    n: number
  }
  provider: ProviderProfileRecord
  runtime: RuntimeSettingsRecord | null
  inputImages: TaskImageInput[]
  maskImage?: TaskImageInput | null
}

export interface GeneratedImageResult {
  buffer: Buffer
  mimeType: string
}

export interface ExecuteImageTaskOptions {
  onImageComplete?: (completed: number, total: number) => void
  onImagesReady?: (
    images: GeneratedImageResult[],
    state: { completed: number; total: number },
  ) => Promise<void> | void
}

function normalizeBase64Image(value: string) {
  const match = value.match(/^data:([^;]+);base64,(.+)$/)
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
    if (payload.error?.message) message = payload.error.message
    else if (payload.message) message = payload.message
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

function createResponsesInput(prompt: string, inputImageDataUrls: string[]) {
  const text = addPromptRewriteGuard(prompt)
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function createResponsesImageTool(payload: TaskExecutionPayload): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: payload.inputImages.length > 0 ? 'edit' : 'generate',
    size: payload.params.size,
    output_format: payload.params.output_format,
  }

  if (!payload.runtime?.codexCli) {
    tool.quality = payload.params.quality
  }

  if (payload.params.output_format !== 'png' && payload.params.output_compression != null) {
    tool.output_compression = payload.params.output_compression
  }

  if (payload.maskImage) {
    tool.input_image_mask = {
      image_url: '',
    }
  }

  return tool
}

async function fileToDataUrl(filePath: string, mimeType: string) {
  const buffer = await fs.readFile(filePath)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

async function fetchRemoteImage(url: string) {
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

function buildApiUrl(baseUrl: string, pathName: string) {
  const normalizedBaseUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/v1`
  return `${normalizedBaseUrl}/${pathName.replace(/^\/+/, '')}`
}

function addPromptRewriteGuard(prompt: string) {
  return `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
}

function buildPrompt(prompt: string, codexCli: boolean) {
  return codexCli
    ? addPromptRewriteGuard(prompt)
    : prompt
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function extractImageResults(result: Array<{ b64_json?: string; url?: string }> | undefined) {
  if (!Array.isArray(result) || result.length === 0) {
    throw new Error('接口未返回图片数据')
  }

  const images: GeneratedImageResult[] = []
  for (const item of result) {
    if (item.b64_json) {
      images.push(normalizeBase64Image(item.b64_json))
    } else if (item.url) {
      images.push(await fetchRemoteImage(item.url))
    }
  }

  if (!images.length) {
    throw new Error('接口未返回可用图片数据')
  }

  return images
}

async function runConcurrentSingles(
  total: number,
  runner: () => Promise<GeneratedImageResult[]>,
  options: ExecuteImageTaskOptions,
) {
  let completed = 0

  const settled = await Promise.allSettled(
    Array.from({ length: total }).map(async () => {
      const images = await runner()
      completed += 1
      await options.onImagesReady?.(images, { completed, total })
      options.onImageComplete?.(completed, total)
      return images
    }),
  )

  const rejected = settled.find((item) => item.status === 'rejected')
  if (rejected?.status === 'rejected') {
    throw rejected.reason
  }

  return settled.flatMap((item) => item.status === 'fulfilled' ? item.value : [])
}

async function callImagesApi(
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
): Promise<GeneratedImageResult[]> {
  const prompt = buildPrompt(payload.prompt, Boolean(payload.runtime?.codexCli))
  const shouldUseConcurrentSingles = payload.params.n > 1

  const runSingleEdit = async () => {
    const formData = new FormData()
    formData.append('model', payload.provider.model)
    formData.append('prompt', prompt)
    formData.append('size', payload.params.size)
    formData.append('output_format', payload.params.output_format)
    formData.append('moderation', payload.params.moderation)

    if (!payload.runtime?.codexCli) {
      formData.append('quality', payload.params.quality)
    }
    if (payload.params.output_format !== 'png' && payload.params.output_compression != null) {
      formData.append('output_compression', String(payload.params.output_compression))
    }
    if (!shouldUseConcurrentSingles && payload.params.n > 1) {
      formData.append('n', String(payload.params.n))
    }

    for (let index = 0; index < payload.inputImages.length; index += 1) {
      const inputImage = payload.inputImages[index]
      const buffer = await fs.readFile(inputImage.filePath)
      const ext = inputImage.mimeType.split('/')[1] || 'png'
      formData.append('image[]', new Blob([buffer], { type: inputImage.mimeType }), `input-${index + 1}.${ext}`)
    }

    if (payload.maskImage) {
      const maskBuffer = await fs.readFile(payload.maskImage.filePath)
      formData.append('mask', new Blob([maskBuffer], { type: payload.maskImage.mimeType }), 'mask.png')
    }

    const response = await fetchWithTimeout(
      buildApiUrl(payload.provider.baseUrl, 'images/edits'),
      {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: formData,
      },
      payload.provider.timeoutSeconds,
    )

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const result = await response.json() as {
      data?: Array<{ b64_json?: string; url?: string }>
    }

    return extractImageResults(result.data)
  }

  const runSingleGeneration = async () => {
    const response = await fetchWithTimeout(
      buildApiUrl(payload.provider.baseUrl, 'images/generations'),
      {
        method: 'POST',
        headers: {
          ...buildHeaders(apiKey),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: payload.provider.model,
          prompt,
          size: payload.params.size,
          output_format: payload.params.output_format,
          moderation: payload.params.moderation,
          ...(payload.runtime?.codexCli ? {} : { quality: payload.params.quality }),
          ...(payload.params.output_format !== 'png'
            && payload.params.output_compression != null
            ? { output_compression: payload.params.output_compression }
            : {}),
          ...(!shouldUseConcurrentSingles && payload.params.n > 1 ? { n: payload.params.n } : {}),
        }),
      },
      payload.provider.timeoutSeconds,
    )

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const result = await response.json() as {
      data?: Array<{ b64_json?: string; url?: string }>
    }

    return extractImageResults(result.data)
  }

  if (payload.inputImages.length > 0) {
    return shouldUseConcurrentSingles
      ? runConcurrentSingles(payload.params.n, runSingleEdit, options)
      : runSingleEdit()
  }

  return shouldUseConcurrentSingles
    ? runConcurrentSingles(payload.params.n, runSingleGeneration, options)
    : runSingleGeneration()
}

async function callResponsesApi(
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
): Promise<GeneratedImageResult[]> {
  const inputImageDataUrls = await Promise.all(
    payload.inputImages.map((image) => fileToDataUrl(image.filePath, image.mimeType)),
  )
  const maskDataUrl = payload.maskImage
    ? await fileToDataUrl(payload.maskImage.filePath, payload.maskImage.mimeType)
    : null

  const body = {
    model: payload.provider.model,
    input: createResponsesInput(payload.prompt, inputImageDataUrls),
    tools: [
      {
        ...createResponsesImageTool(payload),
        ...(maskDataUrl
          ? {
              input_image_mask: {
                image_url: maskDataUrl,
              },
            }
          : {}),
      },
    ],
    tool_choice: 'required',
  }

  const runSingle = async () => {
    const response = await fetchWithTimeout(
      buildApiUrl(payload.provider.baseUrl, 'responses'),
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

    if (!response.ok) {
      throw new Error(await readErrorMessage(response))
    }

    const result = await response.json() as {
      output?: Array<{ type?: string; result?: string }>
    }
    const output = result.output ?? []
    const images: GeneratedImageResult[] = []
    for (const item of output) {
      if (item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.trim()) {
        images.push(normalizeBase64Image(item.result))
      }
    }

    if (!images.length) {
      throw new Error('接口未返回图片数据')
    }

    return images
  }

  if (payload.params.n === 1) {
    return runSingle()
  }

  return runConcurrentSingles(payload.params.n, runSingle, options)
}

export async function executeImageTask(
  db: AppDatabase,
  payload: TaskExecutionPayload,
  apiKey: string,
  options: ExecuteImageTaskOptions = {},
) {
  void db
  return payload.provider.apiMode === 'responses'
    ? callResponsesApi(payload, apiKey, options)
    : callImagesApi(payload, apiKey, options)
}

export async function writeOutputImage(outputDir: string, index: number, image: GeneratedImageResult) {
  const ext = image.mimeType.includes('jpeg')
    ? 'jpg'
    : image.mimeType.includes('webp')
      ? 'webp'
      : 'png'
  const filename = `output-${index + 1}.${ext}`
  const absolutePath = path.join(outputDir, filename)
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(absolutePath, image.buffer)
  const sha256 = crypto.createHash('sha256').update(image.buffer).digest('hex')

  return {
    fileName: filename,
    bytes: image.buffer.byteLength,
    mimeType: MIME_MAP[ext] || image.mimeType,
    sha256,
  }
}
