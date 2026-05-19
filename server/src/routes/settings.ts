import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import {
  createPlainUsageCode,
  getAllowedProviderProfileIds,
  hashSecret,
  requireAdmin,
  requireAuth,
} from '../lib/auth.js'
import { decryptText, encryptText, maskSecret } from '../lib/crypto.js'
import { loadSerializedTask } from '../lib/taskDto.js'
import type { ProviderProfileRecord, UsageCodeStatsRecord } from '../lib/db.js'

const providerProfileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  isDefault: z.boolean().default(false),
}).refine((value) => !(value.codexCli && value.grokApiCompat), {
  message: 'Codex CLI 模式与 Grok API 兼容不能同时启用',
  path: ['grokApiCompat'],
})

const runtimeSettingsSchemaBase = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  clearInputAfterSubmit: z.boolean().default(false),
  persistInputOnRestart: z.boolean().default(true),
  reuseTaskApiProfileTemporarily: z.boolean().default(false),
  alwaysShowRetryButton: z.boolean().default(false),
})

const runtimeSettingsSchema = runtimeSettingsSchemaBase.refine((value) => !(value.codexCli && value.grokApiCompat), {
  message: 'Codex CLI 模式与 Grok API 兼容不能同时启用',
  path: ['grokApiCompat'],
})

const runtimePreferencesSchema = z.object({
  clearInputAfterSubmit: z.boolean().default(false),
  persistInputOnRestart: z.boolean().default(true),
  reuseTaskApiProfileTemporarily: z.boolean().default(false),
  alwaysShowRetryButton: z.boolean().default(false),
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
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
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

const distributionSettingsSchema = z.object({
  enabled: z.boolean(),
  maxConcurrentTasks: z.coerce.number().int().positive().max(50).default(2),
})

const usageCodeCreateSchema = z.object({
  name: z.string().min(1).optional(),
  imageQuota: z.number().int().positive().nullable().optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
})

const usageCodePatchSchema = z.object({
  name: z.string().min(1).optional(),
  isEnabled: z.boolean().optional(),
  imageQuota: z.number().int().positive().nullable().optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
}).refine((value) =>
  value.name !== undefined
    || value.isEnabled !== undefined
    || value.imageQuota !== undefined
    || value.allowedProviderProfileIds !== undefined,
  { message: '至少需要更新一个字段' },
)

function getRuntimePreferences(app: Parameters<FastifyPluginAsync>[0]) {
  const runtime = app.db.getAppSetting<Partial<z.infer<typeof runtimeSettingsSchema>>>('runtime')
  return {
    clearInputAfterSubmit: Boolean(runtime?.clearInputAfterSubmit),
    persistInputOnRestart: runtime?.persistInputOnRestart !== false,
    reuseTaskApiProfileTemporarily: Boolean(runtime?.reuseTaskApiProfileTemporarily),
    alwaysShowRetryButton: Boolean(runtime?.alwaysShowRetryButton),
  }
}

function serializeProfile(app: Parameters<FastifyPluginAsync>[0], profile: NonNullable<ReturnType<typeof app.db.getDefaultProviderProfile>>, includeApiKey = false) {
  let apiKey = ''
  let apiKeyConfigured = true
  let apiKeyMasked: string | null = null
  try {
    apiKey = decryptText(profile.apiKeyEncrypted, app.config.appSecret)
    apiKeyMasked = maskSecret(apiKey)
  } catch {
    apiKeyConfigured = false
    apiKeyMasked = '无法解密，请重新填写'
  }
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    apiKey: includeApiKey ? apiKey : '',
    apiKeyMasked,
    apiKeyConfigured,
    model: profile.model,
    apiMode: profile.apiMode,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    isDefault: Boolean(profile.isDefault),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function serializeProviderOption(profile: ProviderProfileRecord) {
  return {
    id: profile.id,
    name: profile.name,
    apiMode: profile.apiMode,
    model: profile.model,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    isDefault: Boolean(profile.isDefault),
  }
}

function serializeUsageCode(app: Parameters<FastifyPluginAsync>[0], code: UsageCodeStatsRecord) {
  const remainingImageCredits = code.imageQuota == null
    ? null
    : Math.max(0, code.imageQuota - code.usedImageCredits)
  let codePlain: string | null = null
  if (code.codeEncrypted) {
    try {
      codePlain = decryptText(code.codeEncrypted, app.config.appSecret)
    } catch {
      codePlain = null
    }
  }

  return {
    id: code.id,
    code: codePlain,
    codeRecoverable: Boolean(codePlain),
    name: code.name,
    isEnabled: Boolean(code.isEnabled),
    imageQuota: code.imageQuota,
    usedImageCredits: code.usedImageCredits,
    remainingImageCredits,
    taskCount: code.taskCount,
    outputImageCount: code.outputImageCount,
    allowedProviderProfileIds: code.allowedProviderProfileIds ?? null,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
    lastUsedAt: code.lastUsedAt,
  }
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
  app.get('/api/runtime-settings', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    reply.header('Cache-Control', 'no-store')
    const profile = app.db.getDefaultProviderProfile()
    if (!profile) {
      reply.code(404)
      return { message: '默认 provider profile 不存在' }
    }

    const preferences = getRuntimePreferences(app)
    if (auth.role === 'user') {
      return {
        id: profile.id,
        name: profile.name,
        baseUrl: '',
        apiKey: '',
        apiKeyMasked: null,
        apiKeyConfigured: true,
        model: profile.model,
        apiMode: profile.apiMode,
        timeoutSeconds: profile.timeoutSeconds,
        codexCli: Boolean(profile.codexCli),
        grokApiCompat: Boolean(profile.grokApiCompat),
        responseFormatB64Json: Boolean(profile.responseFormatB64Json),
        clearInputAfterSubmit: preferences.clearInputAfterSubmit,
        persistInputOnRestart: preferences.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: preferences.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: preferences.alwaysShowRetryButton,
        source: 'database',
      }
    }

    let apiKey = ''
    let apiKeyConfigured = true
    let apiKeyMasked: string | null = null
    try {
      apiKey = decryptText(profile.apiKeyEncrypted, app.config.appSecret)
      apiKeyMasked = maskSecret(apiKey)
    } catch {
      apiKeyConfigured = false
      apiKeyMasked = '无法解密，请重新填写'
    }

    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey,
      apiKeyMasked,
      apiKeyConfigured,
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      codexCli: Boolean(profile.codexCli),
      grokApiCompat: Boolean(profile.grokApiCompat),
      responseFormatB64Json: Boolean(profile.responseFormatB64Json),
      clearInputAfterSubmit: preferences.clearInputAfterSubmit,
      persistInputOnRestart: preferences.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: preferences.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: preferences.alwaysShowRetryButton,
      source: profile.id === 'env-default' ? 'env' : 'database',
    }
  })

  app.put('/api/runtime-settings', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = runtimeSettingsSchema.parse(request.body)
    const currentDefaultProfile = app.db.getDefaultProviderProfile()
    const profile = app.db.upsertProviderProfile({
      id: currentDefaultProfile?.id ?? 'default',
      name: currentDefaultProfile?.name ?? '默认节点',
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: encryptText(payload.apiKey, app.config.appSecret),
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      responseFormatB64Json: payload.responseFormatB64Json,
      isDefault: true,
    })

    app.db.setAppSetting('runtime', {
      clearInputAfterSubmit: payload.clearInputAfterSubmit,
      persistInputOnRestart: payload.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.alwaysShowRetryButton,
    })

    if (!profile) {
      throw new Error('保存运行设置失败')
    }

    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: payload.apiKey,
      apiKeyMasked: maskSecret(payload.apiKey),
      apiKeyConfigured: true,
      model: profile.model,
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      responseFormatB64Json: Boolean(profile.responseFormatB64Json),
      codexCli: Boolean(profile.codexCli),
      grokApiCompat: Boolean(profile.grokApiCompat),
      clearInputAfterSubmit: payload.clearInputAfterSubmit,
      persistInputOnRestart: payload.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.alwaysShowRetryButton,
      source: 'database',
    }
  })

  app.put('/api/runtime-preferences', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = runtimePreferencesSchema.parse(request.body)
    app.db.setAppSetting('runtime', payload)
    return getRuntimePreferences(app)
  })

  app.get('/api/provider-options', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const profiles = app.db.listProviderProfiles()
    const allowedProviderProfileIds = getAllowedProviderProfileIds(auth)
    return {
      items: profiles
        .filter((profile) => !allowedProviderProfileIds || allowedProviderProfileIds.includes(profile.id))
        .map((profile) => serializeProviderOption(profile)),
    }
  })

  app.get('/api/admin/provider-profiles', async (request, reply) => {
    await requireAdmin(app, request, reply)
    return app.db.listProviderProfiles().map((profile) => serializeProfile(app, profile))
  })

  app.get('/api/admin/provider-profiles/default', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const profile = app.db.getDefaultProviderProfile()
    if (!profile) {
      reply.code(404)
      return { message: '默认 provider profile 不存在' }
    }

    return serializeProfile(app, profile)
  })

  app.put('/api/admin/provider-profiles/default', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = providerProfileSchema.parse(request.body)
    const currentDefaultProfile = app.db.getDefaultProviderProfile()
    const currentProfile = payload.id ? app.db.getProviderProfile(payload.id) : currentDefaultProfile
    const apiKey = payload.apiKey?.trim()
    if (!apiKey && !currentProfile) {
      throw new Error('新建 API 配置需要填写 API Key')
    }
    const profile = app.db.upsertProviderProfile({
      id: payload.id ?? currentDefaultProfile?.id ?? crypto.randomUUID(),
      name: payload.name,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: apiKey
        ? encryptText(apiKey, app.config.appSecret)
        : currentProfile?.apiKeyEncrypted ?? '',
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      responseFormatB64Json: payload.responseFormatB64Json,
      isDefault: true,
    })

    if (!profile) {
      throw new Error('保存默认 provider profile 失败')
    }

    return serializeProfile(app, profile)
  })

  app.post('/api/admin/provider-profiles', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = providerProfileSchema.parse(request.body)
    const apiKey = payload.apiKey?.trim()
    if (!apiKey) throw new Error('新建 API 配置需要填写 API Key')
    const profile = app.db.upsertProviderProfile({
      id: payload.id ?? crypto.randomUUID(),
      name: payload.name,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: encryptText(apiKey, app.config.appSecret),
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      responseFormatB64Json: payload.responseFormatB64Json,
      isDefault: payload.isDefault,
    })
    if (!profile) throw new Error('创建 API 配置失败')
    return serializeProfile(app, profile)
  })

  app.put('/api/admin/provider-profiles/:profileId', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ profileId: z.string().min(1) }).parse(request.params)
    const payload = providerProfileSchema.parse(request.body)
    const currentProfile = app.db.getProviderProfile(params.profileId)
    if (!currentProfile) {
      reply.code(404)
      return { message: 'API 配置不存在' }
    }
    const apiKey = payload.apiKey?.trim()
    const profile = app.db.upsertProviderProfile({
      id: params.profileId,
      name: payload.name,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: apiKey
        ? encryptText(apiKey, app.config.appSecret)
        : currentProfile.apiKeyEncrypted,
      model: payload.model,
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      responseFormatB64Json: payload.responseFormatB64Json,
      isDefault: payload.isDefault,
    })
    if (!profile) throw new Error('保存 API 配置失败')
    return serializeProfile(app, profile)
  })

  app.delete('/api/admin/provider-profiles/:profileId', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ profileId: z.string().min(1) }).parse(request.params)
    const deleted = app.db.deleteProviderProfile(params.profileId)
    if (!deleted) {
      reply.code(404)
      return { message: 'API 配置不存在' }
    }
    return { ok: true }
  })

  app.get('/api/admin/distribution', async (request, reply) => {
    await requireAdmin(app, request, reply)
    return app.db.getDistributionSettings()
  })

  app.put('/api/admin/distribution', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = distributionSettingsSchema.parse(request.body)
    app.db.setDistributionSettings(payload)
    app.taskWorker.setMaxConcurrentTasks(payload.maxConcurrentTasks)
    return app.db.getDistributionSettings()
  })

  app.get('/api/admin/usage-codes', async (request, reply) => {
    await requireAdmin(app, request, reply)
    return {
      items: app.db.listUsageCodesWithStats().map((code) => serializeUsageCode(app, code)),
    }
  })

  app.post('/api/admin/usage-codes', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = usageCodeCreateSchema.parse(request.body)
    const code = createPlainUsageCode()
    const usageCode = app.db.createUsageCode({
      id: crypto.randomUUID(),
      codeHash: hashSecret(code, app.config.appSecret),
      codeEncrypted: encryptText(code, app.config.appSecret),
      name: payload.name?.trim() || '未命名使用码',
      imageQuota: payload.imageQuota ?? null,
      allowedProviderProfileIds: payload.allowedProviderProfileIds ?? null,
    })
    if (!usageCode) throw new Error('创建使用码失败')

    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === usageCode.id)
    return {
      code,
      item: stats ? serializeUsageCode(app, stats) : {
        ...usageCode,
        code,
        codeRecoverable: true,
        isEnabled: Boolean(usageCode.isEnabled),
        remainingImageCredits: usageCode.imageQuota,
        taskCount: 0,
        outputImageCount: 0,
      },
    }
  })

  app.patch('/api/admin/usage-codes/:codeId', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ codeId: z.string().min(1) }).parse(request.params)
    const payload = usageCodePatchSchema.parse(request.body)
    const updated = app.db.updateUsageCode({
      id: params.codeId,
      name: payload.name?.trim(),
      isEnabled: payload.isEnabled,
      imageQuota: payload.imageQuota,
      allowedProviderProfileIds: payload.allowedProviderProfileIds,
    })
    if (!updated) {
      reply.code(404)
      return { message: '使用码不存在' }
    }

    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === updated.id)
    return stats ? serializeUsageCode(app, stats) : updated
  })

  app.delete('/api/admin/usage-codes/:codeId', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ codeId: z.string().min(1) }).parse(request.params)
    const deleted = app.db.deleteUsageCode(params.codeId)
    if (!deleted) {
      reply.code(404)
      return { message: '使用码不存在' }
    }
    return { ok: true }
  })

  app.post('/api/admin/data/import', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = await parseBackupImportPayload(request)
    const importedProfile = app.db.upsertProviderProfile({
      id: 'imported-default',
      name: '导入的默认节点',
      baseUrl: payload.runtimeSettings.baseUrl,
      apiKeyEncrypted: encryptText(payload.runtimeSettings.apiKey, app.config.appSecret),
      model: payload.runtimeSettings.model,
      apiMode: payload.runtimeSettings.apiMode,
      timeoutSeconds: payload.runtimeSettings.timeoutSeconds,
      codexCli: payload.runtimeSettings.codexCli,
      grokApiCompat: payload.runtimeSettings.grokApiCompat,
      responseFormatB64Json: payload.runtimeSettings.responseFormatB64Json,
      isDefault: true,
    })

    app.db.setAppSetting('runtime', {
      clearInputAfterSubmit: payload.runtimeSettings.clearInputAfterSubmit,
      persistInputOnRestart: payload.runtimeSettings.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.runtimeSettings.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.runtimeSettings.alwaysShowRetryButton,
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
      isFavorite: task.isFavorite ?? false,
      isArchived: task.isArchived ?? false,
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

  app.get('/api/admin/data/export', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const profile = app.db.getDefaultProviderProfile()
    const runtime = profile
      ? {
          baseUrl: profile.baseUrl,
          apiKey: decryptText(profile.apiKeyEncrypted, app.config.appSecret),
          model: profile.model,
          apiMode: profile.apiMode,
          timeoutSeconds: profile.timeoutSeconds,
          codexCli: Boolean(profile.codexCli),
          grokApiCompat: Boolean(profile.grokApiCompat),
          responseFormatB64Json: Boolean(profile.responseFormatB64Json),
          ...getRuntimePreferences(app),
        }
      : null

    const tasks = app.db.listTasks(500).map((task) => loadSerializedTask(app.db, task.id, { appSecret: app.config.appSecret, exposeUsageCodeAlias: true })).filter(Boolean)

    return {
      runtimeSettings: runtime,
      tasks,
    }
  })

  app.post('/api/admin/data/reset', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = resetRemoteDataSchema.parse(request.body)
    const existingTasks = app.db.listTasks(200).map((task) => ({
      id: task.id,
      ownerUsageCodeId: task.ownerUsageCodeId,
      ownerKind: task.ownerKind,
    }))

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

    for (const task of existingTasks) {
      app.taskEvents.emitDeleted(task.id, {
        ownerUsageCodeId: task.ownerUsageCodeId,
        ownerKind: task.ownerKind,
      })
    }

    return {
      ok: true,
      mode: payload.mode,
    }
  })
}
