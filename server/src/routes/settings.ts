import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { zipSync } from 'fflate'
import type { CentralDirectory } from 'unzipper'
import unzipper from 'unzipper'
import { z } from 'zod'
import {
  createSession,
  createPlainUsageCode,
  getAllowedProviderProfileIds,
  getSessionToken,
  hashSecret,
  requireAdmin,
  requireAuth,
  setSessionCookie,
} from '../lib/auth.js'
import { decryptText, encryptText, maskSecret } from '../lib/crypto.js'
import type {
  AppSettingRecord,
  ProviderProfileRecord,
  TaskEventRowRecord,
  UsageCodeActivityRecord,
  UsageCodeRawRecord,
  UsageCodeStatsRecord,
  UsageQuotaEventRowRecord,
} from '../lib/db.js'

const providerProfileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses', 'videos']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  xaiImage2kEnabled: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  videoMaxResolution: z.enum(['480p', '720p']).default('480p'),
  videoMaxDuration: z.union([z.literal(6), z.literal(10), z.literal(15)]).default(6),
  isDefault: z.boolean().default(false),
}).refine((value) => !(value.codexCli && value.grokApiCompat), {
  message: 'Codex CLI 模式与 Grok API 兼容不能同时启用',
  path: ['grokApiCompat'],
})

const runtimeSettingsSchemaBase = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses', 'videos']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  xaiImage2kEnabled: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  videoMaxResolution: z.enum(['480p', '720p']).default('480p'),
  videoMaxDuration: z.union([z.literal(6), z.literal(10), z.literal(15)]).default(6),
  clearInputAfterSubmit: z.boolean().default(false),
  persistInputOnRestart: z.boolean().default(true),
  reuseTaskApiProfileTemporarily: z.boolean().default(false),
  alwaysShowRetryButton: z.boolean().default(false),
  showUsageCodeAliasOnTaskCard: z.boolean().default(false),
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
  showUsageCodeAliasOnTaskCard: z.boolean().default(false),
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

const fullBackupProviderProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tagColor: z.string().nullable().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses', 'videos']),
  timeoutSeconds: z.number().int().positive(),
  codexCli: z.boolean(),
  grokApiCompat: z.boolean(),
  xaiImage2kEnabled: z.boolean(),
  responseFormatB64Json: z.boolean(),
  videoMaxResolution: z.enum(['480p', '720p']),
  videoMaxDuration: z.union([z.literal(6), z.literal(10), z.literal(15)]),
  isDefault: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

const fullBackupAppSettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  updatedAt: z.string().min(1),
})

const fullBackupUsageCodeSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable(),
  isEnabled: z.boolean(),
  imageQuota: z.number().int().nullable(),
  providerImageQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable(),
  usedImageCredits: z.number().int().nonnegative(),
  providerUsedImageCredits: z.record(z.string().min(1), z.number().int().nonnegative()).nullable(),
  videoQuota: z.number().int().nullable(),
  providerVideoQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable(),
  usedVideoCredits: z.number().int().nonnegative(),
  providerUsedVideoCredits: z.record(z.string().min(1), z.number().int().nonnegative()).nullable(),
  outputImageCount: z.number().int().nonnegative(),
  outputVideoCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastUsedAt: z.string().nullable(),
})

const fullBackupTaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  taskType: z.enum(['image', 'video']),
  status: z.string().min(1),
  progressPercent: z.number().int(),
  currentStep: z.string().min(1),
  paramsJson: z.string(),
  errorMessage: z.string().nullable(),
  providerProfileId: z.string().nullable(),
  upstreamRequestId: z.string().nullable(),
  upstreamUsageJson: z.string().nullable(),
  ownerUsageCodeId: z.string().nullable(),
  ownerKind: z.enum(['admin', 'usage_code', 'legacy']),
  reservedImageCredits: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  isFavorite: z.boolean(),
  isArchived: z.boolean(),
})

const fullBackupTaskImageSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(['input', 'mask', 'output', 'thumb', 'video_input', 'video_output']),
  filePath: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  metadataJson: z.string().nullable(),
  createdAt: z.string().min(1),
})

const fullBackupTaskEventSchema = z.object({
  id: z.number().int().nonnegative(),
  taskId: z.string().min(1),
  status: z.string().min(1),
  step: z.string().min(1),
  percent: z.number().int(),
  message: z.string().nullable(),
  createdAt: z.string().min(1),
})

const fullBackupUsageQuotaEventSchema = z.object({
  id: z.number().int().nonnegative(),
  usageCodeId: z.string().min(1),
  taskId: z.string().nullable(),
  eventType: z.string().min(1),
  credits: z.number().int(),
  reason: z.string().nullable(),
  providerProfileId: z.string().nullable(),
  createdAt: z.string().min(1),
})

const fullBackupUsageCodeActivitySchema = z.object({
  id: z.number().int().nonnegative(),
  usageCodeId: z.string().min(1),
  taskId: z.string().nullable(),
  actorKind: z.enum(['admin', 'user', 'system']),
  eventType: z.string().min(1),
  message: z.string().min(1),
  createdAt: z.string().min(1),
})

const fullBackupManifestSchema = z.object({
  kind: z.literal('admin_full_backup'),
  version: z.literal(2),
  exportedAt: z.string().min(1),
  providerProfiles: z.array(fullBackupProviderProfileSchema),
  appSettings: z.array(fullBackupAppSettingSchema),
  usageCodes: z.array(fullBackupUsageCodeSchema),
  tasks: z.array(fullBackupTaskSchema),
  taskImages: z.array(fullBackupTaskImageSchema),
  taskEvents: z.array(fullBackupTaskEventSchema),
  usageQuotaEvents: z.array(fullBackupUsageQuotaEventSchema),
  usageCodeActivityLogs: z.array(fullBackupUsageCodeActivitySchema),
})

const resetRemoteDataSchema = z.object({
  mode: z.enum(['tasks', 'all', 'usage_code_tasks_only']),
})

const distributionSettingsSchema = z.object({
  enabled: z.boolean(),
  maxConcurrentTasks: z.coerce.number().int().positive().max(50).default(2),
})

const reminderTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式必须是 HH:mm')

const reminderItemSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(false),
  title: z.string().trim().max(80).default('数据备份提醒'),
  message: z.string().trim().max(5000).default(''),
  imageDataUrl: z.string().trim().nullable().optional().default(null),
  imageDataUrls: z.array(z.string().trim().min(1)).max(16).optional().default([]),
  maxDailyShows: z.coerce.number().int().min(1).max(24).default(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  startTime: reminderTimeSchema.default('09:00'),
  endTime: reminderTimeSchema.default('21:00'),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).refine((value) => value.message.length > 0, {
  message: '提醒事项必须填写正文',
  path: ['message'],
}).refine((value) => new Date(value.endAt).getTime() > new Date(value.startAt).getTime(), {
  message: '结束时间必须晚于开始时间',
  path: ['endAt'],
})

function normalizeReminderItem<T extends {
  imageDataUrl?: string | null
  imageDataUrls?: string[]
}>(item: T) {
  const imageDataUrls = Array.from(new Set([
    ...(item.imageDataUrls ?? []).map((value) => value.trim()).filter(Boolean),
    item.imageDataUrl?.trim() ?? '',
  ].filter(Boolean)))

  return {
    ...item,
    imageDataUrl: imageDataUrls[0] ?? null,
    imageDataUrls,
  }
}

const reminderListSchema = z.object({
  items: z.array(reminderItemSchema),
})

const usageCodeCreateSchema = z.object({
  name: z.string().min(1).optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
  providerImageQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
  providerVideoQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
})

const usageCodePatchSchema = z.object({
  name: z.string().min(1).optional(),
  isEnabled: z.boolean().optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
  providerImageQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
  providerVideoQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
}).refine((value) =>
  value.name !== undefined
    || value.isEnabled !== undefined
    || value.allowedProviderProfileIds !== undefined
    || value.providerImageQuotas !== undefined
    || value.providerVideoQuotas !== undefined,
  { message: '至少需要更新一个字段' },
)

const usageCodeAdjustSchema = z.object({
  action: z.enum(['increase', 'decrease']),
  credits: z.number().int().positive(),
  providerProfileId: z.string().min(1).nullable().optional(),
})

const RESTORED_ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const serverBackupImportSchema = z.object({
  archivePath: z.string().min(1),
})

function formatQuotaEventLabel(event: { eventType: string; reason?: string | null; providerProfileApiMode?: 'images' | 'responses' | 'videos' | null }) {
  const isVideoProvider = event.providerProfileApiMode === 'videos'
  if (event.reason === 'admin_adjust_total') {
    if (event.eventType === 'video_admin_increase' || event.eventType === 'video_admin_decrease') {
      return '管理员调整视频额度'
    }
    return '管理员调整图片额度'
  }
  if (event.reason === 'admin_adjust_provider') {
    if (event.eventType === 'video_admin_increase' || event.eventType === 'video_admin_decrease' || isVideoProvider) {
      return '管理员调整视频端点额度'
    }
    return '管理员调整图片端点额度'
  }
  if (event.eventType === 'reserve') return '使用码用户提交图片任务'
  if (event.eventType === 'refund') return '图片额度退回'
  if (event.eventType === 'video_reserve') return '使用码用户提交视频任务'
  if (event.eventType === 'video_refund') return '视频额度退回'
  if (event.eventType === 'video_admin_increase' || event.eventType === 'video_admin_decrease') return '管理员调整视频额度'
  if (event.eventType === 'admin_increase' || event.eventType === 'admin_decrease') return '管理员调整图片额度'
  return event.eventType
}

function formatUsageCodeAccessLabel(app: Parameters<FastifyPluginAsync>[0], providerIds: string[] | null | undefined) {
  if (!providerIds?.length) return '全部 API'
  const names = providerIds
    .map((id) => app.db.getProviderProfile(id)?.name ?? id)
    .filter(Boolean)
  return names.length ? names.join('、') : '未匹配 API'
}

function getRuntimePreferences(app: Parameters<FastifyPluginAsync>[0]) {
  const runtime = app.db.getAppSetting<Partial<z.infer<typeof runtimeSettingsSchema>>>('runtime')
  return {
    clearInputAfterSubmit: Boolean(runtime?.clearInputAfterSubmit),
    persistInputOnRestart: runtime?.persistInputOnRestart !== false,
    reuseTaskApiProfileTemporarily: Boolean(runtime?.reuseTaskApiProfileTemporarily),
    alwaysShowRetryButton: Boolean(runtime?.alwaysShowRetryButton),
    showUsageCodeAliasOnTaskCard: Boolean(runtime?.showUsageCodeAliasOnTaskCard),
  }
}

function getReminderItems(app: Parameters<FastifyPluginAsync>[0]) {
  const stored = app.db.getAppSetting('reminders')
  if (stored) {
    return reminderListSchema.parse(stored).items.map((item) => normalizeReminderItem(item))
  }

  const legacyAnnouncement = app.db.getAppSetting('announcement')
  if (legacyAnnouncement) {
    const parsedLegacy = reminderItemSchema.safeParse({
      id: crypto.randomUUID(),
      enabled: Boolean((legacyAnnouncement as { enabled?: boolean }).enabled),
      title: (legacyAnnouncement as { title?: string }).title ?? '数据备份提醒',
      message: (legacyAnnouncement as { message?: string }).message ?? '',
      imageDataUrl: (legacyAnnouncement as { imageDataUrl?: string | null }).imageDataUrl ?? null,
      imageDataUrls: (legacyAnnouncement as { imageDataUrls?: string[] | null }).imageDataUrls ?? [],
      maxDailyShows: (legacyAnnouncement as { maxDailyShows?: number }).maxDailyShows ?? 1,
      startAt: new Date().toISOString(),
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      startTime: (legacyAnnouncement as { startTime?: string }).startTime ?? '09:00',
      endTime: (legacyAnnouncement as { endTime?: string }).endTime ?? '21:00',
      createdAt: new Date().toISOString(),
      updatedAt: (legacyAnnouncement as { updatedAt?: string }).updatedAt ?? new Date().toISOString(),
    })
    if (parsedLegacy.success) {
      return [normalizeReminderItem(parsedLegacy.data)]
    }
  }

  return []
}

function isLanAddress(ip: string) {
  const normalizedIp = ip.trim().toLowerCase()
  if (!normalizedIp) return false
  if (normalizedIp === '127.0.0.1' || normalizedIp === '::1' || normalizedIp === 'localhost') return true

  const ipv4MappedMatch = normalizedIp.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  const effectiveIp = ipv4MappedMatch?.[1] ?? normalizedIp

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(effectiveIp)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(effectiveIp)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(effectiveIp)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(effectiveIp)) return true
  if (/^(fc|fd)[0-9a-f:]+$/.test(effectiveIp)) return true
  if (/^fe80:[0-9a-f:]+$/.test(effectiveIp)) return true
  return false
}

function requireLanForDataManagement(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = String(request.ip ?? '').trim()
  if (isLanAddress(clientIp)) return
  reply.code(403)
  throw new Error('数据管理操作仅允许在本机或局域网内进行')
}

function resolveBackupArchivePath(app: Parameters<FastifyPluginAsync>[0], archivePath: string) {
  const baseDir = path.resolve(app.config.backupsDir)
  const resolvedPath = path.resolve(archivePath)
  const relativePath = path.relative(baseDir, resolvedPath)
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('备份文件路径无效')
  }
  return resolvedPath
}

async function listBackupArchiveFiles(rootDir: string, currentDir = rootDir): Promise<Array<{
  filePath: string
  fileName: string
  bytes: number
  modifiedAt: string
}>> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
  const results: Array<{
    filePath: string
    fileName: string
    bytes: number
    modifiedAt: string
  }> = []

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      results.push(...await listBackupArchiveFiles(rootDir, absolutePath))
      continue
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue
    const stat = await fs.stat(absolutePath)
    results.push({
      filePath: absolutePath,
      fileName: path.relative(rootDir, absolutePath).replace(/\\/g, '/'),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  }

  return results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
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
    tagColor: profile.tagColor,
    baseUrl: profile.baseUrl,
    apiKey: includeApiKey ? apiKey : '',
    apiKeyMasked,
    apiKeyConfigured,
    model: profile.model,
    apiMode: profile.apiMode,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoMaxDuration: profile.videoMaxDuration,
    isDefault: Boolean(profile.isDefault),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function serializeProviderOption(profile: ProviderProfileRecord) {
  return {
    id: profile.id,
    name: profile.name,
    tagColor: profile.tagColor,
    apiMode: profile.apiMode,
    model: profile.model,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoMaxDuration: profile.videoMaxDuration,
    isDefault: Boolean(profile.isDefault),
  }
}

function serializeUsageCode(app: Parameters<FastifyPluginAsync>[0], code: UsageCodeStatsRecord) {
  const quotaEvents = app.db.listUsageQuotaEvents(code.id, 50)
  const activityLogs = app.db.listUsageCodeActivityLogs(code.id, 50)
  const reservedTaskIds = new Set(
    quotaEvents
      .filter((event) => event.eventType === 'reserve' || event.eventType === 'video_reserve')
      .map((event) => event.taskId)
      .filter((taskId): taskId is string => Boolean(taskId)),
  )
  const allowedProviderProfileIdSet = code.allowedProviderProfileIds?.length
    ? new Set(code.allowedProviderProfileIds)
    : null
  const providerRemainingImageCredits = Object.fromEntries(
    Object.entries(code.providerImageQuotas ?? {}).map(([providerProfileId, quota]) => [
      providerProfileId,
      Math.max(0, quota - (code.providerUsedImageCredits?.[providerProfileId] ?? 0)),
    ]),
  )
  const remainingImageCredits = Object.entries(providerRemainingImageCredits).reduce(
    (sum, [providerProfileId, remaining]) => {
      if (allowedProviderProfileIdSet && !allowedProviderProfileIdSet.has(providerProfileId)) return sum
      return sum + remaining
    },
    0,
  )
  const providerRemainingVideoCredits = Object.fromEntries(
    Object.entries(code.providerVideoQuotas ?? {}).map(([providerProfileId, quota]) => [
      providerProfileId,
      Math.max(0, quota - (code.providerUsedVideoCredits?.[providerProfileId] ?? 0)),
    ]),
  )
  const remainingVideoCredits = Object.entries(providerRemainingVideoCredits).reduce(
    (sum, [providerProfileId, remaining]) => {
      if (allowedProviderProfileIdSet && !allowedProviderProfileIdSet.has(providerProfileId)) return sum
      return sum + remaining
    },
    0,
  )
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
    providerImageQuotas: code.providerImageQuotas ?? null,
    providerUsedImageCredits: code.providerUsedImageCredits ?? null,
    providerRemainingImageCredits,
    videoQuota: code.videoQuota,
    usedVideoCredits: code.usedVideoCredits,
    remainingVideoCredits,
    providerVideoQuotas: code.providerVideoQuotas ?? null,
    providerUsedVideoCredits: code.providerUsedVideoCredits ?? null,
    providerRemainingVideoCredits,
    taskCount: code.taskCount,
    outputImageCount: code.outputImageCount,
    outputVideoCount: code.outputVideoCount,
    quotaEvents: quotaEvents.map((event) => ({
      ...event,
      label: formatQuotaEventLabel(event),
    })),
    activityEvents: [
      ...quotaEvents.map((event) => ({
        id: `quota-${event.id}`,
        taskId: event.taskId,
        createdAt: event.createdAt,
        label: formatQuotaEventLabel(event),
        eventType: event.eventType,
        credits: event.credits,
        providerProfileId: event.providerProfileId,
        providerProfileName: event.providerProfileName,
        providerProfileTagColor: event.providerProfileTagColor,
      })),
      ...activityLogs
        .filter((event) => {
          if (event.eventType !== 'image_task_submitted' && event.eventType !== 'video_task_submitted') {
            return true
          }
          if (!event.taskId) return true
          return !reservedTaskIds.has(event.taskId)
        })
        .map((event) => ({
        id: `activity-${event.id}`,
        taskId: event.taskId,
        createdAt: event.createdAt,
        label: event.message,
        eventType: event.eventType,
        credits: null,
        providerProfileId: null,
        providerProfileName: null,
        providerProfileTagColor: null,
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100),
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

function getUsageMediaArchiveEntries(
  app: Parameters<FastifyPluginAsync>[0],
  usageCodeIds: string[],
) {
  const tasks = app.db.listTasksForUsageCodes(usageCodeIds, 5000)
  const seenImageIds = new Set<string>()
  const entries: Array<{
    imageId: string
    taskId: string
    prompt: string
    kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
    filePath: string
    mimeType: string
    bytes: number
  }> = []

  for (const task of tasks) {
    const images = app.db.listTaskImages(task.id)
    for (const image of images) {
      if (image.kind !== 'output' && image.kind !== 'video_output') continue
      if (seenImageIds.has(image.id)) continue
      seenImageIds.add(image.id)
      entries.push({
        imageId: image.id,
        taskId: task.id,
        prompt: task.prompt,
        kind: image.kind,
        filePath: image.filePath,
        mimeType: image.mimeType,
        bytes: image.bytes,
      })
    }
  }

  return entries
}

function summarizeUsageMediaEntries(entries: Array<{
  kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
  bytes: number
}>) {
  return entries.reduce(
    (summary, entry) => {
      if (entry.kind === 'output') summary.imageCount += 1
      if (entry.kind === 'video_output') summary.videoCount += 1
      summary.totalBytes += entry.bytes
      return summary
    },
    { imageCount: 0, videoCount: 0, totalBytes: 0 },
  )
}

function getArchiveExtension(filePath: string, mimeType: string) {
  const ext = path.extname(filePath).trim()
  if (ext) return ext
  if (mimeType.includes('jpeg')) return '.jpg'
  if (mimeType.includes('webp')) return '.webp'
  if (mimeType.includes('gif')) return '.gif'
  if (mimeType.includes('mp4')) return '.mp4'
  if (mimeType.includes('quicktime')) return '.mov'
  if (mimeType.includes('webm')) return '.webm'
  return mimeType.startsWith('video/') ? '.mp4' : '.png'
}

function sanitizeArchiveNamePart(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function shortenPromptForArchive(prompt: string) {
  const normalized = sanitizeArchiveNamePart(prompt)
  const sliced = Array.from(normalized).slice(0, 20).join('')
  return sliced || '未命名任务'
}

function getArchiveLabelByKind(kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output') {
  if (kind === 'video_output') return '视频'
  return '图片'
}

function buildUsageMediaArchiveFileName(entry: {
  prompt: string
  kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
  filePath: string
  mimeType: string
}, index: number) {
  const extension = getArchiveExtension(entry.filePath, entry.mimeType)
  const label = getArchiveLabelByKind(entry.kind)
  const prompt = shortenPromptForArchive(entry.prompt)
  const suffix = index > 1 ? `（${index}）` : ''
  return `${label}-${prompt}${suffix}${extension}`
}

function formatBytesForDisplay(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`
}

async function removeTaskMediaFiles(
  app: Parameters<FastifyPluginAsync>[0],
  taskId: string,
) {
  const images = app.db.listTaskImages(taskId)
  for (const image of images) {
    try {
      await fs.rm(path.join(app.config.mediaDir, image.filePath), { force: true })
    } catch {
      /* ignore */
    }
  }
  return images
}

type LegacyBinaryImage = Omit<z.infer<typeof backupImageSchema>, 'dataUrl'> & { binary: Buffer }

type LegacyImportPayload = {
  runtimeSettings: z.infer<typeof runtimeSettingsSchema>
  tasks: z.infer<typeof backupTaskSchema>[]
  images: LegacyBinaryImage[]
}

type ParsedAdminBackupPayload = {
  providerProfiles: ProviderProfileRecord[]
  appSettings: AppSettingRecord[]
  usageCodes: UsageCodeRawRecord[]
  usageQuotaEvents: UsageQuotaEventRowRecord[]
  usageCodeActivityLogs: UsageCodeActivityRecord[]
  tasks: Array<{
    id: string
    prompt: string
    taskType?: 'image' | 'video'
    status: string
    progressPercent: number
    currentStep: string
    paramsJson: string
    errorMessage: string | null
    providerProfileId: string | null
    upstreamRequestId?: string | null
    upstreamUsageJson?: string | null
    ownerUsageCodeId?: string | null
    ownerKind?: 'admin' | 'usage_code' | 'legacy'
    reservedImageCredits?: number
    createdAt: string
    updatedAt: string
    finishedAt: string | null
    isFavorite?: boolean
    isArchived?: boolean
  }>
  taskImages: Array<{
    id: string
    taskId: string
    kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
    filePath: string
    mimeType: string
    width: number | null
    height: number | null
    bytes: number
    sha256: string
    metadataJson?: string | null
    createdAt: string
  }>
  taskEvents: TaskEventRowRecord[]
}

type ParsedAdminBackupImport = {
  kind: 'full' | 'legacy'
  archivePath: string | null
  payload: ParsedAdminBackupPayload
  tempDir: string
  files: Array<{ filePath: string; tempPath: string }>
}

function buildFullBackupManifest(app: Parameters<FastifyPluginAsync>[0]) {
  const providerProfiles = app.db.listProviderProfiles().map((profile) => ({
    id: profile.id,
    name: profile.name,
    tagColor: profile.tagColor,
    baseUrl: profile.baseUrl,
    apiKey: decryptText(profile.apiKeyEncrypted, app.config.appSecret),
    model: profile.model,
    apiMode: profile.apiMode,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoMaxDuration: profile.videoMaxDuration,
    isDefault: Boolean(profile.isDefault),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }))
  const appSettings = app.db.listAppSettings().map((setting) => ({
    key: setting.key,
    value: JSON.parse(setting.valueJson),
    updatedAt: setting.updatedAt,
  }))
  const usageCodes = app.db.listUsageCodes().map((code) => ({
    id: code.id,
    code: code.codeEncrypted ? decryptText(code.codeEncrypted, app.config.appSecret) : '',
    name: code.name,
    allowedProviderProfileIds: code.allowedProviderProfileIds ?? null,
    isEnabled: Boolean(code.isEnabled),
    imageQuota: code.imageQuota,
    providerImageQuotas: code.providerImageQuotas ?? null,
    usedImageCredits: code.usedImageCredits,
    providerUsedImageCredits: code.providerUsedImageCredits ?? null,
    videoQuota: code.videoQuota,
    providerVideoQuotas: code.providerVideoQuotas ?? null,
    usedVideoCredits: code.usedVideoCredits,
    providerUsedVideoCredits: code.providerUsedVideoCredits ?? null,
    outputImageCount: code.outputImageCount,
    outputVideoCount: code.outputVideoCount,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
    lastUsedAt: code.lastUsedAt,
  }))
  const tasks = app.db.listTasks(100000).map((task) => ({
    id: task.id,
    prompt: task.prompt,
    taskType: task.taskType,
    status: task.status,
    progressPercent: task.progressPercent,
    currentStep: task.currentStep,
    paramsJson: task.paramsJson,
    errorMessage: task.errorMessage,
    providerProfileId: task.providerProfileId,
    upstreamRequestId: task.upstreamRequestId,
    upstreamUsageJson: task.upstreamUsageJson,
    ownerUsageCodeId: task.ownerUsageCodeId,
    ownerKind: task.ownerKind,
    reservedImageCredits: task.reservedImageCredits,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    isFavorite: Boolean(task.isFavorite),
    isArchived: Boolean(task.isArchived),
  }))
  const taskImages = tasks.flatMap((task) => app.db.listTaskImages(task.id).map((image) => ({
    id: image.id,
    taskId: image.taskId,
    kind: image.kind,
    filePath: image.filePath,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
    sha256: image.sha256,
    metadataJson: image.metadataJson,
    createdAt: image.createdAt,
  })))
  const taskEvents = app.db.listAllTaskEvents()
  const usageQuotaEvents = app.db.listAllUsageQuotaEvents()
  const usageCodeActivityLogs = app.db.listAllUsageCodeActivityLogs()

  return {
    kind: 'admin_full_backup' as const,
    version: 2 as const,
    exportedAt: new Date().toISOString(),
    providerProfiles,
    appSettings,
    usageCodes,
    tasks,
    taskImages,
    taskEvents,
    usageQuotaEvents,
    usageCodeActivityLogs,
  }
}

function buildLegacyImportPayload(app: Parameters<FastifyPluginAsync>[0], payload: LegacyImportPayload): ParsedAdminBackupPayload {
  const nowIso = new Date().toISOString()
  const providerProfileId = 'imported-default'
  const providerProfiles: ProviderProfileRecord[] = [{
    id: providerProfileId,
    name: '导入的默认节点',
    tagColor: 'blue',
    baseUrl: payload.runtimeSettings.baseUrl,
    apiKeyEncrypted: encryptText(payload.runtimeSettings.apiKey, app.config.appSecret),
    model: payload.runtimeSettings.model,
    apiMode: payload.runtimeSettings.apiMode,
    timeoutSeconds: payload.runtimeSettings.timeoutSeconds,
    codexCli: payload.runtimeSettings.codexCli ? 1 : 0,
    grokApiCompat: payload.runtimeSettings.grokApiCompat ? 1 : 0,
    xaiImage2kEnabled: payload.runtimeSettings.xaiImage2kEnabled ? 1 : 0,
    responseFormatB64Json: payload.runtimeSettings.responseFormatB64Json ? 1 : 0,
    videoMaxResolution: payload.runtimeSettings.videoMaxResolution,
    videoMaxDuration: payload.runtimeSettings.videoMaxDuration,
    isDefault: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  }]
  const appSettings: AppSettingRecord[] = [{
    key: 'runtime',
    valueJson: JSON.stringify({
      clearInputAfterSubmit: payload.runtimeSettings.clearInputAfterSubmit,
      persistInputOnRestart: payload.runtimeSettings.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.runtimeSettings.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.runtimeSettings.alwaysShowRetryButton,
      showUsageCodeAliasOnTaskCard: payload.runtimeSettings.showUsageCodeAliasOnTaskCard,
    }),
    updatedAt: nowIso,
  }]
  const imageMap = new Map(payload.images.map((image) => [image.id, image] as const))
  const tasks = payload.tasks.map((task) => ({
    id: task.id,
    prompt: task.prompt,
    taskType: 'image' as const,
    status: toServerStatus(task.status, task.serverStatus),
    progressPercent: task.progressPercent ?? (task.status === 'done' ? 100 : task.status === 'error' ? 100 : 50),
    currentStep: task.currentStep ?? (task.status === 'done' ? 'completed' : task.status === 'error' ? 'failed' : 'processing'),
    paramsJson: JSON.stringify(task.params),
    errorMessage: task.error ?? null,
    providerProfileId,
    upstreamRequestId: null,
    upstreamUsageJson: null,
    ownerUsageCodeId: null,
    ownerKind: 'legacy' as const,
    reservedImageCredits: 0,
    createdAt: toIsoTimestamp(task.createdAt, nowIso),
    updatedAt: toIsoTimestamp(task.updatedAt ?? task.finishedAt ?? task.createdAt, nowIso),
    finishedAt: task.finishedAt ? toIsoTimestamp(task.finishedAt, nowIso) : null,
    isFavorite: task.isFavorite ?? false,
    isArchived: task.isArchived ?? false,
  }))
  const taskImages = payload.tasks.flatMap((task) => {
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
          metadataJson: null,
          createdAt: toIsoTimestamp(image.createdAt, nowIso),
        }
      })
  })

  return {
    providerProfiles,
    appSettings,
    usageCodes: [] as UsageCodeRawRecord[],
    usageQuotaEvents: [] as UsageQuotaEventRowRecord[],
    usageCodeActivityLogs: [] as UsageCodeActivityRecord[],
    tasks,
    taskImages,
    taskEvents: [] as TaskEventRowRecord[],
  }
}

function normalizeArchiveRelativePath(input: string) {
  const normalized = path.posix.normalize(String(input).replace(/\\/g, '/')).replace(/^\/+/, '')
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`备份包含非法路径：${input}`)
  }
  return normalized
}

async function extractArchiveEntriesToTempDir(
  directory: CentralDirectory,
  targetDir: string,
  requiredPaths: string[],
) {
  const normalizedPathMap = new Map(requiredPaths.map((item) => [normalizeArchiveRelativePath(item), item] as const))
  const extractedFiles: Array<{ filePath: string; tempPath: string }> = []

  for (const entry of directory.files) {
    const normalizedEntryPath = normalizeArchiveRelativePath(entry.path)
    if (normalizedEntryPath === 'manifest.json') continue
    if (!normalizedPathMap.has(normalizedEntryPath)) continue
    if (entry.type !== 'File') {
      throw new Error(`备份文件条目无效：${entry.path}`)
    }

    const destination = path.join(targetDir, normalizedEntryPath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await pipeline(entry.stream(), createWriteStream(destination))
    extractedFiles.push({
      filePath: normalizedEntryPath,
      tempPath: destination,
    })
  }

  for (const expectedPath of normalizedPathMap.keys()) {
    const matched = extractedFiles.some((file) => file.filePath === expectedPath)
    if (!matched) {
      throw new Error(`备份缺少媒体文件：${expectedPath}`)
    }
  }

  return extractedFiles
}

async function parseBackupArchiveFile(
  app: Parameters<FastifyPluginAsync>[0],
  archivePath: string,
): Promise<ParsedAdminBackupImport> {
  const tempDir = await fs.mkdtemp(path.join(app.config.dataDir, 'backup-import-'))
  const directory = await unzipper.Open.file(archivePath)
  const manifestEntry = directory.files.find((entry) => normalizeArchiveRelativePath(entry.path) === 'manifest.json')
  if (!manifestEntry || manifestEntry.type !== 'File') {
    throw new Error('备份文件缺少 manifest.json')
  }

  const parsedManifest = JSON.parse((await manifestEntry.buffer()).toString('utf-8'))
  if (parsedManifest?.kind === 'admin_full_backup' && parsedManifest?.version === 2) {
    const manifest = fullBackupManifestSchema.parse(parsedManifest)
    const extractedFiles = await extractArchiveEntriesToTempDir(
      directory,
      path.join(tempDir, 'files'),
      manifest.taskImages.map((image) => image.filePath),
    )
    return {
      kind: 'full' as const,
      archivePath,
      tempDir,
      payload: {
          providerProfiles: manifest.providerProfiles.map((profile) => ({
            id: profile.id,
            name: profile.name,
            tagColor: profile.tagColor ?? null,
            baseUrl: profile.baseUrl,
            apiKeyEncrypted: encryptText(profile.apiKey, app.config.appSecret),
            model: profile.model,
            apiMode: profile.apiMode,
            timeoutSeconds: profile.timeoutSeconds,
            codexCli: profile.codexCli ? 1 : 0,
            grokApiCompat: profile.grokApiCompat ? 1 : 0,
            xaiImage2kEnabled: profile.xaiImage2kEnabled ? 1 : 0,
            responseFormatB64Json: profile.responseFormatB64Json ? 1 : 0,
            videoMaxResolution: profile.videoMaxResolution,
            videoMaxDuration: profile.videoMaxDuration,
            isDefault: profile.isDefault ? 1 : 0,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          })),
          appSettings: manifest.appSettings.map((setting) => ({
            key: setting.key,
            valueJson: JSON.stringify(setting.value),
            updatedAt: setting.updatedAt,
          })),
          usageCodes: manifest.usageCodes.map((code) => ({
            id: code.id,
            codeHash: hashSecret(code.code, app.config.appSecret),
            codeEncrypted: encryptText(code.code, app.config.appSecret),
            name: code.name,
            allowedProviderProfileIds: code.allowedProviderProfileIds ?? null,
            isEnabled: code.isEnabled ? 1 : 0,
            imageQuota: code.imageQuota,
            providerImageQuotas: code.providerImageQuotas ?? null,
            usedImageCredits: code.usedImageCredits,
            providerUsedImageCredits: code.providerUsedImageCredits ?? null,
            videoQuota: code.videoQuota,
            providerVideoQuotas: code.providerVideoQuotas ?? null,
            usedVideoCredits: code.usedVideoCredits,
            providerUsedVideoCredits: code.providerUsedVideoCredits ?? null,
            outputImageCount: code.outputImageCount,
            outputVideoCount: code.outputVideoCount,
            createdAt: code.createdAt,
            updatedAt: code.updatedAt,
            lastUsedAt: code.lastUsedAt,
          })),
          usageQuotaEvents: manifest.usageQuotaEvents,
          usageCodeActivityLogs: manifest.usageCodeActivityLogs,
          tasks: manifest.tasks,
          taskImages: manifest.taskImages,
          taskEvents: manifest.taskEvents,
        },
      files: extractedFiles,
    }
  }

  const manifest = backupManifestSchema.parse(parsedManifest)
  const extractedFiles = await extractArchiveEntriesToTempDir(
    directory,
    path.join(tempDir, 'files'),
    manifest.images.map((image) => image.filePath),
  )
  const legacyPayload: LegacyImportPayload = {
    runtimeSettings: manifest.runtimeSettings,
    tasks: manifest.tasks,
    images: await Promise.all(manifest.images.map(async (image) => {
      const normalizedPath = normalizeArchiveRelativePath(image.filePath)
      const extracted = extractedFiles.find((file) => file.filePath === normalizedPath)
      if (!extracted) {
        throw new Error(`备份缺少图片文件：${image.filePath}`)
      }
      return {
        ...image,
        binary: await fs.readFile(extracted.tempPath),
      }
    })),
  }
  return {
    kind: 'legacy' as const,
    archivePath,
    payload: buildLegacyImportPayload(app, legacyPayload),
    tempDir,
    files: extractedFiles,
  }
}

async function parseBackupImportPayload(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
): Promise<ParsedAdminBackupImport> {
  const contentType = request.headers['content-type'] ?? ''

  if (contentType.includes('multipart/form-data')) {
    const file = await request.file()
    if (!file) {
      throw new Error('导入请求缺少备份文件')
    }
    const safeFileName = path.basename(file.filename || `backup-${Date.now()}.zip`).replace(/[^\w.-]+/g, '-')
    const archivePath = path.join(app.config.backupImportsDir, `${Date.now()}-${safeFileName}`)
    await fs.mkdir(app.config.backupImportsDir, { recursive: true })
    await pipeline(file.file, createWriteStream(archivePath))
    return parseBackupArchiveFile(app, archivePath)
  }

  const payload = backupImportSchema.parse(request.body)
  const tempDir = await fs.mkdtemp(path.join(app.config.dataDir, 'backup-import-'))
  const filesDir = path.join(tempDir, 'files')
  await fs.mkdir(filesDir, { recursive: true })
  const legacyPayload: LegacyImportPayload = {
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
  const files: Array<{ filePath: string; tempPath: string }> = []
  for (const image of legacyPayload.images) {
    const normalizedPath = normalizeArchiveRelativePath(image.filePath)
    const destination = path.join(filesDir, normalizedPath)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, image.binary)
    files.push({
      filePath: normalizedPath,
      tempPath: destination,
    })
  }
  return {
    kind: 'legacy' as const,
    archivePath: null,
    payload: buildLegacyImportPayload(app, legacyPayload),
    tempDir,
    files,
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
        xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
        responseFormatB64Json: Boolean(profile.responseFormatB64Json),
        videoMaxResolution: profile.videoMaxResolution,
        videoMaxDuration: profile.videoMaxDuration,
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
      xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
      responseFormatB64Json: Boolean(profile.responseFormatB64Json),
      videoMaxResolution: profile.videoMaxResolution,
      videoMaxDuration: profile.videoMaxDuration,
      clearInputAfterSubmit: preferences.clearInputAfterSubmit,
      persistInputOnRestart: preferences.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: preferences.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: preferences.alwaysShowRetryButton,
      showUsageCodeAliasOnTaskCard: preferences.showUsageCodeAliasOnTaskCard,
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
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      videoMaxResolution: payload.videoMaxResolution,
      videoMaxDuration: payload.videoMaxDuration,
      isDefault: true,
    })

    app.db.setAppSetting('runtime', {
      clearInputAfterSubmit: payload.clearInputAfterSubmit,
      persistInputOnRestart: payload.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.alwaysShowRetryButton,
      showUsageCodeAliasOnTaskCard: payload.showUsageCodeAliasOnTaskCard,
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
      xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
      videoMaxResolution: profile.videoMaxResolution,
      videoMaxDuration: profile.videoMaxDuration,
      clearInputAfterSubmit: payload.clearInputAfterSubmit,
      persistInputOnRestart: payload.persistInputOnRestart,
      reuseTaskApiProfileTemporarily: payload.reuseTaskApiProfileTemporarily,
      alwaysShowRetryButton: payload.alwaysShowRetryButton,
      showUsageCodeAliasOnTaskCard: payload.showUsageCodeAliasOnTaskCard,
      source: 'database',
    }
  })

  app.put('/api/runtime-preferences', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = runtimePreferencesSchema.parse(request.body)
    app.db.setAppSetting('runtime', payload)
    return getRuntimePreferences(app)
  })

  app.get('/api/reminders', async (request, reply) => {
    await requireAuth(app, request, reply)
    reply.header('Cache-Control', 'no-store')
    return {
      items: getReminderItems(app),
    }
  })

  app.get('/api/admin/reminders', async (request, reply) => {
    await requireAdmin(app, request, reply)
    reply.header('Cache-Control', 'no-store')
    return {
      items: getReminderItems(app),
    }
  })

  app.put('/api/admin/reminders', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const payload = reminderListSchema.parse(request.body)
    const now = new Date().toISOString()
    const items = payload.items.map((item) => ({
      ...normalizeReminderItem(item),
      createdAt: item.createdAt ?? now,
      updatedAt: now,
    }))
    app.db.setAppSetting('reminders', { items })
    return { items }
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
    return app.db.listProviderProfiles().map((profile) => serializeProfile(app, profile, true))
  })

  app.get('/api/admin/provider-profiles/default', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const profile = app.db.getDefaultProviderProfile()
    if (!profile) {
      reply.code(404)
      return { message: '默认 provider profile 不存在' }
    }

    return serializeProfile(app, profile, true)
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
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      videoMaxResolution: payload.videoMaxResolution,
      videoMaxDuration: payload.videoMaxDuration,
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
    const existingProviderProfileIds = app.db.listProviderProfiles().map((item) => item.id)
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
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      videoMaxResolution: payload.videoMaxResolution,
      videoMaxDuration: payload.videoMaxDuration,
      isDefault: payload.isDefault,
    })
    if (!profile) throw new Error('创建 API 配置失败')
    app.db.restrictUsageCodeAccessForNewProvider({
      providerProfileId: profile.id,
      existingProviderProfileIds,
    })
    app.db.appendProviderQuotaOverrideForUsageCodes({
      providerProfileId: profile.id,
      apiMode: profile.apiMode,
    })
    for (const code of app.db.listUsageCodesWithStats()) {
      app.db.insertUsageCodeActivityLog({
        usageCodeId: code.id,
        actorKind: 'admin',
        eventType: 'usage_code_provider_quota_initialized',
        message: `管理员新增 API 配置「${profile.name}」，该端点默认未授权，额度设为 0`,
      })
    }
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
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      videoMaxResolution: payload.videoMaxResolution,
      videoMaxDuration: payload.videoMaxDuration,
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
    const current = app.db.getDistributionSettings()
    app.db.setDistributionSettings(payload)
    app.taskWorker.setMaxConcurrentTasks(payload.maxConcurrentTasks)
    const next = app.db.getDistributionSettings()
    if (current.enabled !== next.enabled || current.maxConcurrentTasks !== next.maxConcurrentTasks) {
      for (const code of app.db.listUsageCodesWithStats()) {
        app.db.insertUsageCodeActivityLog({
          usageCodeId: code.id,
          actorKind: 'admin',
          eventType: 'distribution_updated',
          message: `管理员更新分发设置：${next.enabled ? '开启' : '关闭'}分发，同时执行任务数 ${current.maxConcurrentTasks} -> ${next.maxConcurrentTasks}`,
        })
      }
    }
    return next
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
      imageQuota: null,
      videoQuota: null,
      allowedProviderProfileIds: payload.allowedProviderProfileIds ?? null,
      providerImageQuotas: payload.providerImageQuotas ?? null,
      providerVideoQuotas: payload.providerVideoQuotas ?? null,
    })
    if (!usageCode) throw new Error('创建使用码失败')

    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === usageCode.id)
    app.db.insertUsageCodeActivityLog({
      usageCodeId: usageCode.id,
      actorKind: 'admin',
      eventType: 'usage_code_created',
      message: `管理员创建使用码，可用 API：${formatUsageCodeAccessLabel(app, usageCode.allowedProviderProfileIds)}`,
    })
    return {
      code,
      item: stats ? serializeUsageCode(app, stats) : {
        ...usageCode,
        code,
        codeRecoverable: true,
        isEnabled: Boolean(usageCode.isEnabled),
        remainingImageCredits: Object.entries(usageCode.providerImageQuotas ?? {}).reduce((sum, [providerProfileId, quota]) => {
          if (usageCode.allowedProviderProfileIds?.length && !usageCode.allowedProviderProfileIds.includes(providerProfileId)) {
            return sum
          }
          return sum + quota
        }, 0),
        providerImageQuotas: usageCode.providerImageQuotas ?? null,
        providerUsedImageCredits: usageCode.providerUsedImageCredits ?? null,
        providerRemainingImageCredits: usageCode.providerImageQuotas ?? {},
        videoQuota: usageCode.videoQuota,
        usedVideoCredits: usageCode.usedVideoCredits,
        remainingVideoCredits: Object.entries(usageCode.providerVideoQuotas ?? {}).reduce((sum, [providerProfileId, quota]) => {
          if (usageCode.allowedProviderProfileIds?.length && !usageCode.allowedProviderProfileIds.includes(providerProfileId)) {
            return sum
          }
          return sum + quota
        }, 0),
        providerVideoQuotas: usageCode.providerVideoQuotas ?? null,
        providerUsedVideoCredits: usageCode.providerUsedVideoCredits ?? null,
        providerRemainingVideoCredits: usageCode.providerVideoQuotas ?? {},
        taskCount: 0,
        outputImageCount: 0,
        outputVideoCount: 0,
        quotaEvents: [],
        activityEvents: [],
      },
    }
  })

  app.patch('/api/admin/usage-codes/:codeId', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ codeId: z.string().min(1) }).parse(request.params)
    const payload = usageCodePatchSchema.parse(request.body)
    const current = app.db.getUsageCode(params.codeId)
    if (!current) {
      reply.code(404)
      return { message: '使用码不存在' }
    }
    const updated = app.db.updateUsageCode({
      id: params.codeId,
      name: payload.name?.trim(),
      isEnabled: payload.isEnabled,
      allowedProviderProfileIds: payload.allowedProviderProfileIds,
      providerImageQuotas: payload.providerImageQuotas,
      providerVideoQuotas: payload.providerVideoQuotas,
    })
    if (!updated) {
      reply.code(404)
      return { message: '使用码不存在' }
    }

    if (payload.name !== undefined && payload.name.trim() !== current.name) {
      app.db.insertUsageCodeActivityLog({
        usageCodeId: params.codeId,
        actorKind: 'admin',
        eventType: 'usage_code_renamed',
        message: `管理员修改使用码名称：${current.name} -> ${payload.name.trim()}`,
      })
    }
    if (payload.isEnabled !== undefined && Boolean(current.isEnabled) !== payload.isEnabled) {
      app.db.insertUsageCodeActivityLog({
        usageCodeId: params.codeId,
        actorKind: 'admin',
        eventType: payload.isEnabled ? 'usage_code_enabled' : 'usage_code_disabled',
        message: `管理员${payload.isEnabled ? '启用' : '禁用'}使用码`,
      })
    }
    if (payload.allowedProviderProfileIds !== undefined) {
      const prevLabel = formatUsageCodeAccessLabel(app, current.allowedProviderProfileIds)
      const nextLabel = formatUsageCodeAccessLabel(app, payload.allowedProviderProfileIds)
      if (prevLabel !== nextLabel) {
        app.db.insertUsageCodeActivityLog({
          usageCodeId: params.codeId,
          actorKind: 'admin',
          eventType: 'usage_code_allowed_apis_changed',
          message: `管理员调整可用 API：${prevLabel} -> ${nextLabel}`,
        })
      }
    }

    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === updated.id)
    return stats ? serializeUsageCode(app, stats) : updated
  })

  app.post('/api/admin/usage-codes/:codeId/adjust-quota', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ codeId: z.string().min(1) }).parse(request.params)
    const payload = usageCodeAdjustSchema.parse(request.body)
    const adjusted = app.db.adjustUsageCodeQuota({
      usageCodeId: params.codeId,
      action: payload.action,
      credits: payload.credits,
      providerProfileId: payload.providerProfileId ?? null,
    })
    if (!adjusted) {
      reply.code(404)
      return { message: '使用码不存在' }
    }
    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === adjusted.id)
    return stats ? serializeUsageCode(app, stats) : adjusted
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

  app.get('/api/admin/data/import-candidates', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    return {
      items: await listBackupArchiveFiles(app.config.backupsDir),
    }
  })

  app.post('/api/admin/data/import-from-server', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const payload = serverBackupImportSchema.parse(request.body)
    const archivePath = resolveBackupArchivePath(app, payload.archivePath)
    await fs.access(archivePath)
    const parsed = await parseBackupArchiveFile(app, archivePath)
    const currentSessionToken = getSessionToken(request)

    try {
      await fs.rm(app.config.mediaDir, { recursive: true, force: true })
      await fs.mkdir(app.config.mediaDir, { recursive: true })
      await fs.mkdir(app.config.uploadsDir, { recursive: true })
      await fs.mkdir(app.config.masksDir, { recursive: true })
      await fs.mkdir(app.config.outputsDir, { recursive: true })
      await fs.mkdir(app.config.thumbsDir, { recursive: true })

      for (const file of parsed.files) {
        const absolutePath = path.join(app.config.mediaDir, file.filePath)
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await fs.copyFile(file.tempPath, absolutePath)
      }

      app.db.replaceFullBackup(parsed.payload)
      if (currentSessionToken) {
        const expiresAt = new Date(Date.now() + RESTORED_ADMIN_SESSION_TTL_MS)
        app.db.createAuthSession({
          id: crypto.randomUUID(),
          tokenHash: hashSecret(currentSessionToken, app.config.appSecret),
          role: 'admin',
          usageCodeId: null,
          expiresAt: expiresAt.toISOString(),
        })
        setSessionCookie(reply, currentSessionToken, expiresAt)
      } else {
        const nextSession = createSession(app, {
          role: 'admin',
          usageCodeId: null,
        })
        setSessionCookie(reply, nextSession.token, nextSession.expiresAt)
      }

      return {
        ok: true,
        importedTasks: parsed.payload.tasks.length,
        importedImages: parsed.payload.taskImages.length,
        importedProviderProfiles: parsed.payload.providerProfiles.length,
        importedUsageCodes: parsed.payload.usageCodes.length,
      }
    } finally {
      await fs.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  app.post('/api/admin/data/import', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const parsed = await parseBackupImportPayload(app, request)
    const currentSessionToken = getSessionToken(request)

    try {
      await fs.rm(app.config.mediaDir, { recursive: true, force: true })
      await fs.mkdir(app.config.mediaDir, { recursive: true })
      await fs.mkdir(app.config.uploadsDir, { recursive: true })
      await fs.mkdir(app.config.masksDir, { recursive: true })
      await fs.mkdir(app.config.outputsDir, { recursive: true })
      await fs.mkdir(app.config.thumbsDir, { recursive: true })

      for (const file of parsed.files) {
        const absolutePath = path.join(app.config.mediaDir, file.filePath)
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await fs.copyFile(file.tempPath, absolutePath)
      }

      app.db.replaceFullBackup(parsed.payload)
      if (currentSessionToken) {
        const expiresAt = new Date(Date.now() + RESTORED_ADMIN_SESSION_TTL_MS)
        app.db.createAuthSession({
          id: crypto.randomUUID(),
          tokenHash: hashSecret(currentSessionToken, app.config.appSecret),
          role: 'admin',
          usageCodeId: null,
          expiresAt: expiresAt.toISOString(),
        })
        setSessionCookie(reply, currentSessionToken, expiresAt)
      } else {
        const nextSession = createSession(app, {
          role: 'admin',
          usageCodeId: null,
        })
        setSessionCookie(reply, nextSession.token, nextSession.expiresAt)
      }

      return {
        ok: true,
        uploadedArchivePath: parsed.archivePath,
        importedTasks: parsed.payload.tasks.length,
        importedImages: parsed.payload.taskImages.length,
        importedProviderProfiles: parsed.payload.providerProfiles.length,
        importedUsageCodes: parsed.payload.usageCodes.length,
      }
    } finally {
      await fs.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => undefined)
      if (parsed.archivePath) {
        await fs.rm(parsed.archivePath, { force: true }).catch(() => undefined)
      }
    }
  })

  app.get('/api/admin/data/export', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const manifest = buildFullBackupManifest(app)
    const zipFiles: Record<string, Uint8Array> = {
      'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
    }

    for (const image of manifest.taskImages) {
      const absolutePath = path.join(app.config.mediaDir, image.filePath)
      zipFiles[image.filePath] = new Uint8Array(await fs.readFile(absolutePath))
    }

    const zipped = zipSync(zipFiles, { level: 6 })
    await fs.mkdir(app.config.backupsDir, { recursive: true })
    const filename = `gpt-image-playground-full-backup-${Date.now()}.zip`
    const filePath = path.join(app.config.backupsDir, filename)
    await fs.writeFile(filePath, Buffer.from(zipped))
    reply.header('Cache-Control', 'no-store')
    return {
      ok: true,
      filePath,
      filename,
      bytes: zipped.byteLength,
    }
  })

  app.get('/api/user/data/export-media/summary', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以查看自己的导出预估' }
    }

    const entries = getUsageMediaArchiveEntries(app, auth.usageCodeIds)
    const summary = summarizeUsageMediaEntries(entries)
    return summary
  })

  app.get('/api/user/data/export-media', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以导出自己的图片与视频' }
    }

    const entries = getUsageMediaArchiveEntries(app, auth.usageCodeIds)
    const summary = summarizeUsageMediaEntries(entries)
    const zipFiles: Record<string, Uint8Array> = {}
    const folderCount = new Map<string, number>()
    const taskFolderMap = new Map<string, string>()
    const taskFileCount = new Map<string, Map<string, number>>()

    if (!entries.length) {
      zipFiles['README.txt'] = Buffer.from('当前使用码下没有可导出的图片或视频文件。', 'utf-8')
    }

    for (const entry of entries) {
      const absolutePath = path.join(app.config.mediaDir, entry.filePath)
      const content = await fs.readFile(absolutePath)
      let folderName = taskFolderMap.get(entry.taskId)
      if (!folderName) {
        const folderBaseName = `任务-${shortenPromptForArchive(entry.prompt)}`
        const nextFolderIndex = (folderCount.get(folderBaseName) ?? 0) + 1
        folderCount.set(folderBaseName, nextFolderIndex)
        folderName = nextFolderIndex > 1 ? `${folderBaseName}-${nextFolderIndex}` : folderBaseName
        taskFolderMap.set(entry.taskId, folderName)
      }

      const fileBaseName = buildUsageMediaArchiveFileName(entry, 1)
      const folderFileCount = taskFileCount.get(entry.taskId) ?? new Map<string, number>()
      const nextFileIndex = (folderFileCount.get(fileBaseName) ?? 0) + 1
      folderFileCount.set(fileBaseName, nextFileIndex)
      taskFileCount.set(entry.taskId, folderFileCount)

      zipFiles[`${folderName}/${buildUsageMediaArchiveFileName(entry, nextFileIndex)}`] = new Uint8Array(content)
    }

    const exportTime = new Date().toISOString()
    for (const usageCodeId of auth.usageCodeIds) {
      app.db.insertUsageCodeActivityLog({
        usageCodeId,
        actorKind: 'user',
        eventType: 'media_exported',
        message: `最近一次产物导出时间：${new Date(exportTime).toLocaleString('zh-CN')}，图片 ${summary.imageCount} 张，视频 ${summary.videoCount} 个，预计大小 ${formatBytesForDisplay(summary.totalBytes)}`,
        createdAt: exportTime,
      })
    }

    const zipped = zipSync(zipFiles, { level: 6 })
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Type', 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="usage-code-media-${Date.now()}.zip"`)
    return reply.send(Buffer.from(zipped))
  })

  app.post('/api/admin/data/reset', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const payload = resetRemoteDataSchema.parse(request.body)

    if (payload.mode === 'usage_code_tasks_only') {
      const usageCodeTasks = app.db.listAllUsageCodeTasks()

      for (const task of usageCodeTasks) {
        const images = await removeTaskMediaFiles(app, task.id)
        const outputImageCount = images.filter((image) => image.kind === 'output').length
        const outputVideoCount = images.filter((image) => image.kind === 'video_output').length

        app.taskWorker.cancel(task.id)
        if (task.ownerUsageCodeId) {
          app.db.insertUsageCodeActivityLog({
            usageCodeId: task.ownerUsageCodeId,
            taskId: task.id,
            actorKind: 'admin',
            eventType: 'admin_task_purged',
            message: `管理员批量清理使用码任务，删除图片 ${outputImageCount} 张，视频 ${outputVideoCount} 个`,
          })
        }
        app.db.deleteTask(task.id)
        app.taskEvents.emitDeleted(task.id, {
          ownerUsageCodeId: task.ownerUsageCodeId,
          ownerKind: task.ownerKind,
        })
      }

      return {
        ok: true,
        mode: payload.mode,
        deletedTasks: usageCodeTasks.length,
      }
    }

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
