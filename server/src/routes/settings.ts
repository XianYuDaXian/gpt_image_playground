import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import { decryptText, encryptText, maskSecret } from '../lib/crypto.js'
import { loadSerializedTask } from '../lib/taskDto.js'

const providerProfileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  isDefault: z.boolean().default(false),
})

const runtimeSettingsSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
})

const backupTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  params: z.object({
    size: z.string(),
    quality: z.enum(['auto', 'low', 'medium', 'high']),
    output_format: z.enum(['png', 'jpeg', 'webp']),
    output_compression: z.number().int().min(0).max(100).nullable(),
    moderation: z.enum(['auto', 'low']),
    n: z.number().int().positive().max(16),
  }),
  inputImageIds: z.array(z.string()),
  outputImages: z.array(z.string()),
  maskImageId: z.string().nullable().optional(),
  status: z.enum(['running', 'done', 'error']),
  serverStatus: z.string().optional(),
  currentStep: z.string().optional(),
  progressPercent: z.number().int().min(0).max(100).optional(),
  error: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
  updatedAt: z.number().optional(),
})

const backupImageSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  dataUrl: z.string().min(1),
})

const backupImageManifestSchema = backupImageSchema.omit({
  dataUrl: true,
})

const backupManifestSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.string().min(1),
  runtimeSettings: runtimeSettingsSchema,
  tasks: z.array(backupTaskSchema),
  images: z.array(backupImageManifestSchema),
})

const backupImportSchema = z.object({
  runtimeSettings: runtimeSettingsSchema,
  tasks: z.array(backupTaskSchema),
  images: z.array(backupImageSchema),
})

const resetRemoteDataSchema = z.object({
  mode: z.enum(['tasks', 'all']),
})

function getCodexCliSetting(app: Parameters<FastifyPluginAsync>[0]) {
  const runtime = app.db.getAppSetting<{ codexCli?: boolean }>('runtime')
  return Boolean(runtime?.codexCli)
}

function toIsoTimestamp(value: number | null | undefined, fallback: string) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString()
  }
  return fallback
}

function toServerStatus(status: 'running' | 'done' | 'error', serverStatus?: string) {
  if (status === 'done') return serverStatus === 'succeeded' ? serverStatus : 'succeeded'
  if (status === 'error') return serverStatus === 'failed' ? serverStatus : 'failed'
  return serverStatus || 'processing'
}

function inferImageKind(task: z.infer<typeof backupTaskSchema>, imageId: string) {
  if (task.maskImageId === imageId) return 'mask' as const
  if (task.outputImages.includes(imageId)) return 'output' as const
  return 'input' as const
}

function dataUrlToBytes(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
  const mimeType = match?.[1] ?? 'image/png'
  const base64 = match?.[2] ?? dataUrl.replace(/^data:[^;]+;base64,/, '')
  return {
    mimeType,
    bytes: Buffer.from(base64, 'base64'),
  }
}

async function parseBackupImportPayload(
  request: FastifyRequest,
) {
  const contentType = request.headers['content-type'] ?? ''

  if (contentType.includes('multipart/form-data')) {
    const file = await request.file()
    if (!file) {
      throw new Error('导入请求缺少备份文件')
    }

    const archiveBuffer = await file.toBuffer()
    const zipFiles = unzipSync(new Uint8Array(archiveBuffer))
    const manifestBytes = zipFiles['manifest.json']
    if (!manifestBytes) {
      throw new Error('备份文件缺少 manifest.json')
    }

    const manifest = backupManifestSchema.parse(JSON.parse(strFromU8(manifestBytes)))
    return {
      runtimeSettings: manifest.runtimeSettings,
      tasks: manifest.tasks,
      images: manifest.images.map((image) => {
        const bytes = zipFiles[image.filePath]
        if (!bytes) {
          throw new Error(`备份缺少图片文件：${image.filePath}`)
        }
        return {
          ...image,
          binary: Buffer.from(bytes),
        }
      }),
    }
  }

  const payload = backupImportSchema.parse(request.body)
  return {
    runtimeSettings: payload.runtimeSettings,
    tasks: payload.tasks,
    images: payload.images.map((image) => {
      const { bytes, mimeType } = dataUrlToBytes(image.dataUrl)
      return {
        ...image,
        mimeType: image.mimeType || mimeType,
        binary: bytes,
      }
    }),
  }
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/runtime-settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const profile = app.db.getDefaultProviderProfile()
    if (!profile) {
      reply.code(404)
      return { message: '默认 provider profile 不存在' }
    }

    const apiKey = decryptText(profile.apiKeyEncrypted, app.config.appSecret)

    return {
      baseUrl: profile.baseUrl,
      apiKey,
      apiKeyMasked: maskSecret(apiKey),
      apiKeyConfigured: true,
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      codexCli: getCodexCliSetting(app),
      source: profile.id === 'env-default' ? 'env' : 'database',
    }
  })

  app.put('/api/runtime-settings', async (request) => {
    const payload = runtimeSettingsSchema.parse(request.body)
    const profile = app.db.upsertProviderProfile({
      id: 'default',
      name: '默认节点',
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: encryptText(payload.apiKey, app.config.appSecret),
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      isDefault: true,
    })

    app.db.setAppSetting('runtime', {
      codexCli: payload.codexCli,
    })

    if (!profile) {
      throw new Error('保存运行设置失败')
    }

    return {
      baseUrl: profile.baseUrl,
      apiKey: payload.apiKey,
      apiKeyMasked: maskSecret(payload.apiKey),
      apiKeyConfigured: true,
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      codexCli: payload.codexCli,
      source: 'database',
    }
  })

  app.get('/api/admin/provider-profiles', async () => {
    return app.db.listProviderProfiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKeyMasked: maskSecret(decryptText(profile.apiKeyEncrypted, app.config.appSecret)),
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      isDefault: Boolean(profile.isDefault),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }))
  })

  app.get('/api/admin/provider-profiles/default', async (_request, reply) => {
    const profile = app.db.getDefaultProviderProfile()
    if (!profile) {
      reply.code(404)
      return { message: '默认 provider profile 不存在' }
    }

    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKeyMasked: maskSecret(decryptText(profile.apiKeyEncrypted, app.config.appSecret)),
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      isDefault: true,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
  })

  app.put('/api/admin/provider-profiles/default', async (request) => {
    const payload = providerProfileSchema.parse(request.body)
    const profile = app.db.upsertProviderProfile({
      id: payload.id ?? crypto.randomUUID(),
      name: payload.name,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: encryptText(payload.apiKey, app.config.appSecret),
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      isDefault: true,
    })

    if (!profile) {
      throw new Error('保存默认 provider profile 失败')
    }

    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKeyMasked: maskSecret(payload.apiKey),
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      isDefault: Boolean(profile.isDefault),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }
  })

  app.post('/api/admin/data/import', async (request) => {
    const payload = await parseBackupImportPayload(request)
    const importedProfile = app.db.upsertProviderProfile({
      id: 'imported-default',
      name: '导入的默认节点',
      baseUrl: payload.runtimeSettings.baseUrl,
      apiKeyEncrypted: encryptText(payload.runtimeSettings.apiKey, app.config.appSecret),
      model: payload.runtimeSettings.model,
      apiMode: payload.runtimeSettings.apiMode,
      timeoutSeconds: payload.runtimeSettings.timeoutSeconds,
      isDefault: true,
    })

    app.db.setAppSetting('runtime', {
      codexCli: payload.runtimeSettings.codexCli,
    })

    await fs.rm(app.config.mediaDir, { recursive: true, force: true })
    await fs.mkdir(app.config.mediaDir, { recursive: true })
    await fs.mkdir(app.config.uploadsDir, { recursive: true })
    await fs.mkdir(app.config.masksDir, { recursive: true })
    await fs.mkdir(app.config.outputsDir, { recursive: true })
    await fs.mkdir(app.config.thumbsDir, { recursive: true })

    for (const image of payload.images) {
      const absolutePath = path.join(app.config.mediaDir, image.filePath)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, image.binary)
    }

    const nowIso = new Date().toISOString()
    const importedTasks = payload.tasks.map((task) => ({
      id: task.id,
      prompt: task.prompt,
      status: toServerStatus(task.status, task.serverStatus),
      progressPercent: task.progressPercent ?? (task.status === 'done' ? 100 : task.status === 'error' ? 100 : 50),
      currentStep: task.currentStep ?? (task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'processing'),
      paramsJson: JSON.stringify(task.params),
      errorMessage: task.error ?? null,
      providerProfileId: importedProfile?.id ?? null,
      createdAt: toIsoTimestamp(task.createdAt, nowIso),
      updatedAt: toIsoTimestamp(task.updatedAt ?? task.finishedAt ?? task.createdAt, nowIso),
      finishedAt: task.finishedAt ? toIsoTimestamp(task.finishedAt, nowIso) : null,
    }))

    const imageMap = new Map(payload.images.map((image) => [image.id, image] as const))
    const importedTaskImages = payload.tasks.flatMap((task) => {
      const imageIds = [...task.inputImageIds, ...(task.maskImageId ? [task.maskImageId] : []), ...task.outputImages]
      return imageIds
        .filter((imageId, index) => imageIds.indexOf(imageId) === index)
        .map((imageId) => {
          const image = imageMap.get(imageId)
          if (!image) {
            throw new Error(`备份缺少图片文件：${imageId}`)
          }
          return {
            id: image.id,
            taskId: task.id,
            kind: inferImageKind(task, image.id),
            filePath: image.filePath,
            mimeType: image.mimeType,
            width: image.width ?? null,
            height: image.height ?? null,
            bytes: image.binary.byteLength,
            sha256: image.sha256,
            createdAt: toIsoTimestamp(image.createdAt, nowIso),
          }
        })
    })

    app.db.replaceImportedData({
      tasks: importedTasks,
      taskImages: importedTaskImages,
    })

    return {
      ok: true,
      importedTasks: payload.tasks.length,
      importedImages: payload.images.length,
      defaultProfileId: importedProfile?.id ?? null,
    }
  })

  app.get('/api/admin/data/export', async () => {
    const profile = app.db.getDefaultProviderProfile()
    const runtime = profile
      ? {
          baseUrl: profile.baseUrl,
          apiKey: decryptText(profile.apiKeyEncrypted, app.config.appSecret),
          model: profile.model,
          apiMode: profile.apiMode,
          timeoutSeconds: profile.timeoutSeconds,
          codexCli: getCodexCliSetting(app),
        }
      : null

    const tasks = app.db.listTasks(500).map((task) => loadSerializedTask(app.db, task.id)).filter(Boolean)

    return {
      runtimeSettings: runtime,
      tasks,
    }
  })

  app.post('/api/admin/data/reset', async (request) => {
    const payload = resetRemoteDataSchema.parse(request.body)

    await fs.rm(app.config.mediaDir, { recursive: true, force: true })
    await fs.mkdir(app.config.mediaDir, { recursive: true })
    await fs.mkdir(app.config.uploadsDir, { recursive: true })
    await fs.mkdir(app.config.masksDir, { recursive: true })
    await fs.mkdir(app.config.outputsDir, { recursive: true })
    await fs.mkdir(app.config.thumbsDir, { recursive: true })

    if (payload.mode === 'all') {
      app.db.clearRuntimeData()
    } else {
      app.db.clearTaskData()
    }

    return {
      ok: true,
      mode: payload.mode,
    }
  })
}
