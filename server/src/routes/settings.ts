import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { finished, pipeline } from 'node:stream/promises'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
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
import {
  appendManagementOperationLog,
  getBackupJobState,
  getDefaultBackupJobState,
  getMaintenanceMessage,
  getUsageCodeMediaExportState,
  listManagementOperationLogs,
  patchBackupJobState,
  patchUsageCodeMediaExportState,
  setBackupJobState,
  setUsageCodeMediaExportState,
} from '../lib/maintenance.js'
import type {
  AppSettingRecord,
  ProviderProfileRecord,
  TaskEventRowRecord,
  UsageCodeActivityRecord,
  UsageCodeRawRecord,
  UsageCodeStatsRecord,
  UsageCodeUserTier,
  UsageQuotaEventRecord,
  UsageQuotaEventRowRecord,
} from '../lib/db.js'

type UsageCodeEventCategory =
  | 'all'
  | 'create'
  | 'generate'
  | 'delete'
  | 'backup'
  | 'api_access_change'
  | 'quota_increase'
  | 'quota_decrease'
  | 'export'
  | 'distribution_change'
  | 'rename'
  | 'enable_disable'

type UsageCodeEventBucket = 'month' | 'day' | 'hour' | '30m' | '15m' | '5m'
type UsageCodeEventTimePreset = 'today' | 'yesterday' | 'last7days' | 'last30days' | 'custom'

interface UsageCodeEventItem {
  id: string
  source: 'quota' | 'activity'
  sourceId: number
  taskId: string | null
  createdAt: string
  label: string
  eventType: string
  eventCategory: Exclude<UsageCodeEventCategory, 'all'>
  credits: number | null
  providerProfileId: string | null
  providerProfileName: string | null
  providerProfileTagColor: string | null
  providerProfileApiMode?: 'images' | 'responses' | 'videos' | 'venice_images' | null
}

const videoDurationOptionSchema = z.union([z.literal(6), z.literal(10), z.literal(15)])
const videoResolutionOptionSchema = z.enum(['480p', '720p'])
const videoResolutionOptionsSchema = z.array(videoResolutionOptionSchema)
  .min(1)
  .max(2)
  .transform((value) => Array.from(new Set(value)).sort((a, b) => a.localeCompare(b)) as Array<'480p' | '720p'>)
const videoDurationOptionsSchema = z.array(videoDurationOptionSchema)
  .min(1)
  .max(3)
  .transform((value) => Array.from(new Set(value)).sort((a, b) => a - b) as Array<6 | 10 | 15>)

const providerProfileSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  remarkName: z.string().trim().optional().nullable(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  modelOptions: z.array(z.string().trim().min(1)).max(32).optional().nullable(),
  veniceGenerateEnabled: z.boolean().default(true),
  veniceEditEnabled: z.boolean().default(true),
  veniceMultiEditEnabled: z.boolean().default(true),
  veniceSkipResolution: z.boolean().default(false),
  apiMode: z.enum(['images', 'responses', 'videos', 'venice_images']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  xaiImage2kEnabled: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  videoMaxResolution: videoResolutionOptionSchema.default('480p'),
  videoResolutionOptions: videoResolutionOptionsSchema.default(['480p']),
  videoMaxDuration: videoDurationOptionSchema.default(6),
  videoDurationOptions: videoDurationOptionsSchema.default([6]),
  isDefault: z.boolean().default(false),
}).refine((value) => !(value.codexCli && value.grokApiCompat), {
  message: 'Codex CLI 模式与 Grok API 兼容不能同时启用',
  path: ['grokApiCompat'],
})

const runtimeSettingsSchemaBase = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses', 'videos', 'venice_images']),
  timeoutSeconds: z.coerce.number().int().positive().max(1800),
  codexCli: z.boolean().default(false),
  grokApiCompat: z.boolean().default(false),
  xaiImage2kEnabled: z.boolean().default(false),
  responseFormatB64Json: z.boolean().default(false),
  veniceGenerateEnabled: z.boolean().default(true),
  veniceEditEnabled: z.boolean().default(true),
  veniceMultiEditEnabled: z.boolean().default(true),
  veniceSkipResolution: z.boolean().default(false),
  videoMaxResolution: videoResolutionOptionSchema.default('480p'),
  videoResolutionOptions: videoResolutionOptionsSchema.default(['480p']),
  videoMaxDuration: videoDurationOptionSchema.default(6),
  videoDurationOptions: videoDurationOptionsSchema.default([6]),
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
  remarkName: z.string().nullable().optional(),
  tagColor: z.string().nullable().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  model: z.string().min(1),
  modelOptions: z.array(z.string().min(1)).nullable().optional(),
  apiMode: z.enum(['images', 'responses', 'videos', 'venice_images']),
  timeoutSeconds: z.number().int().positive(),
  codexCli: z.boolean(),
  grokApiCompat: z.boolean(),
  xaiImage2kEnabled: z.boolean(),
  responseFormatB64Json: z.boolean(),
  veniceGenerateEnabled: z.boolean().default(true),
  veniceEditEnabled: z.boolean().default(true),
  veniceMultiEditEnabled: z.boolean().default(true),
  veniceSkipResolution: z.boolean().default(false),
  videoMaxResolution: videoResolutionOptionSchema,
  videoResolutionOptions: videoResolutionOptionsSchema.default(['480p']),
  videoMaxDuration: videoDurationOptionSchema,
  videoDurationOptions: videoDurationOptionsSchema.default([6]),
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
  userTier: z.enum(['free', 'paid']).optional(),
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
  providerProfileModel: z.string().nullable().optional(),
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

const splitBackupIndexPartSchema = z.object({
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
})

const splitBackupIndexFileSchema = z.object({
  filePath: z.string().min(1),
  partName: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
})

const splitBackupIndexSchema = z.object({
  kind: z.literal('admin_split_backup_index'),
  version: z.literal(1),
  backupId: z.string().min(1),
  exportedAt: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  manifest: fullBackupManifestSchema,
  parts: z.array(splitBackupIndexPartSchema).min(1),
  files: z.array(splitBackupIndexFileSchema),
})

const usageCodeMediaExportPartSchema = z.object({
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
})

const usageCodeMediaExportIndexSchema = z.object({
  kind: z.literal('usage_code_media_export_index'),
  version: z.literal(1),
  exportId: z.string().min(1),
  exportedAt: z.string().min(1),
  imageCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  parts: z.array(usageCodeMediaExportPartSchema).min(1),
})

const resetRemoteDataSchema = z.object({
  mode: z.enum(['tasks', 'all', 'usage_code_tasks_only', 'admin_tasks_only']),
  usageCodeIds: z.array(z.string().min(1)).min(1).optional(),
  taskIds: z.array(z.string().min(1)).min(1).optional(),
}).refine((value) => !value.usageCodeIds?.length || value.mode === 'usage_code_tasks_only', {
  message: '仅清理使用码任务时才能指定分发码',
  path: ['usageCodeIds'],
}).refine((value) => !value.taskIds?.length || value.mode === 'admin_tasks_only', {
  message: '仅清理管理员任务时才能指定任务',
  path: ['taskIds'],
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
  audienceTiers: z.array(z.enum(['free', 'paid'])).max(2).optional().default(['free', 'paid']),
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
  audienceTiers?: UsageCodeUserTier[]
}>(item: T) {
  const imageDataUrls = Array.from(new Set([
    ...(item.imageDataUrls ?? []).map((value) => value.trim()).filter(Boolean),
    item.imageDataUrl?.trim() ?? '',
  ].filter(Boolean)))
  const audienceTiers = Array.from(new Set(item.audienceTiers?.filter((value) => value === 'free' || value === 'paid') ?? []))

  return {
    ...item,
    imageDataUrl: imageDataUrls[0] ?? null,
    imageDataUrls,
    audienceTiers: audienceTiers.length ? audienceTiers : ['free', 'paid'],
  }
}

function inferUsageCodeUserTierFromQuota(input: {
  imageQuota?: number | null
  providerImageQuotas?: Record<string, number> | null
  videoQuota?: number | null
  providerVideoQuotas?: Record<string, number> | null
}): UsageCodeUserTier {
  const imageTotal = input.imageQuota ?? Object.values(input.providerImageQuotas ?? {}).reduce((sum, quota) => sum + quota, 0)
  const videoTotal = input.videoQuota ?? Object.values(input.providerVideoQuotas ?? {}).reduce((sum, quota) => sum + quota, 0)
  return imageTotal === 2 && videoTotal === 1 ? 'free' : 'paid'
}

const reminderListSchema = z.object({
  items: z.array(reminderItemSchema),
})

const usageCodeCreateSchema = z.object({
  name: z.string().min(1).optional(),
  userTier: z.enum(['free', 'paid']).optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
  providerImageQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
  providerVideoQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
})

const usageCodePatchSchema = z.object({
  name: z.string().min(1).optional(),
  userTier: z.enum(['free', 'paid']).optional(),
  isEnabled: z.boolean().optional(),
  allowedProviderProfileIds: z.array(z.string().min(1)).nullable().optional(),
  providerImageQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
  providerVideoQuotas: z.record(z.string().min(1), z.number().int().nonnegative()).nullable().optional(),
}).refine((value) =>
  value.name !== undefined
    || value.userTier !== undefined
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

const usageCodeEventQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  timePreset: z.enum(['today', 'yesterday', 'last7days', 'last30days', 'custom']).default('today'),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  bucket: z.enum(['month', 'day', 'hour', '30m', '15m', '5m']).default('hour'),
  eventCategory: z.union([
    z.enum([
      'all',
      'create',
      'generate',
      'delete',
      'backup',
      'api_access_change',
      'quota_increase',
      'quota_decrease',
      'export',
      'distribution_change',
      'rename',
      'enable_disable',
    ]),
    z.array(z.enum([
      'all',
      'create',
      'generate',
      'delete',
      'backup',
      'api_access_change',
      'quota_increase',
      'quota_decrease',
      'export',
      'distribution_change',
      'rename',
      'enable_disable',
    ])),
  ]).default('all'),
  taskId: z.string().trim().nullable().optional(),
})

const RESTORED_ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const serverBackupImportSchema = z.object({
  archivePath: z.string().min(1),
})

const usageCodeMediaExportDownloadCompleteSchema = z.object({
  fileName: z.string().min(1),
})

function formatQuotaEventLabel(event: { eventType: string; reason?: string | null; providerProfileApiMode?: 'images' | 'responses' | 'videos' | 'venice_images' | null }) {
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

function mapUsageCodeEventCategory(eventType: string): Exclude<UsageCodeEventCategory, 'all'> {
  if (eventType === 'usage_code_created') return 'create'
  if (eventType === 'image_task_succeeded' || eventType === 'video_task_succeeded') return 'generate'
  if (eventType === 'task_deleted' || eventType === 'admin_task_purged') return 'delete'
  if (eventType === 'backup_export' || eventType === 'backup_import') return 'backup'
  if (eventType === 'usage_code_allowed_apis_changed') return 'api_access_change'
  if (eventType === 'admin_increase' || eventType === 'video_admin_increase') return 'quota_increase'
  if (
    eventType === 'admin_decrease'
    || eventType === 'video_admin_decrease'
    || eventType === 'reserve'
    || eventType === 'video_reserve'
    || eventType === 'refund'
    || eventType === 'video_refund'
  ) return 'quota_decrease'
  if (eventType === 'media_export_started') return 'export'
  if (eventType === 'media_exported') return 'export'
  if (eventType === 'media_download_started') return 'export'
  if (eventType === 'media_download_completed') return 'export'
  if (eventType === 'media_export_deleted') return 'export'
  if (eventType === 'distribution_updated') return 'distribution_change'
  if (eventType === 'usage_code_renamed') return 'rename'
  if (eventType === 'usage_code_enabled' || eventType === 'usage_code_disabled') return 'enable_disable'
  return 'api_access_change'
}

function formatUsageCodeEventCategoryLabel(category: UsageCodeEventCategory) {
  if (category === 'all') return '全部事件'
  if (category === 'create') return '创建使用码'
  if (category === 'generate') return '生成'
  if (category === 'delete') return '删除'
  if (category === 'backup') return '备份'
  if (category === 'api_access_change') return '管理员调整 API'
  if (category === 'quota_increase') return '管理员加额'
  if (category === 'quota_decrease') return '额度扣减'
  if (category === 'export') return '导出'
  if (category === 'distribution_change') return '分发设置'
  if (category === 'rename') return '重命名'
  return '启用与禁用'
}

function buildUsageCodeEventItemFromQuota(
  app: Parameters<FastifyPluginAsync>[0],
  event: UsageQuotaEventRecord,
) {
  const providerProfile = event.providerProfileId ? app.db.getProviderProfile(event.providerProfileId) : null
  return {
    id: `quota-${event.id}`,
    source: 'quota' as const,
    sourceId: event.id,
    taskId: event.taskId,
    createdAt: event.createdAt,
    label: formatQuotaEventLabel(event),
    eventType: event.eventType,
    eventCategory: mapUsageCodeEventCategory(event.eventType),
    credits: event.credits,
    providerProfileId: event.providerProfileId,
    providerProfileName: providerProfile?.remarkName ?? providerProfile?.name ?? event.providerProfileName ?? null,
    providerProfileTagColor: providerProfile?.tagColor ?? event.providerProfileTagColor ?? null,
    providerProfileApiMode: providerProfile?.apiMode ?? event.providerProfileApiMode ?? null,
  }
}

function buildUsageCodeEventItemFromActivity(event: UsageCodeActivityRecord) {
  return {
    id: `activity-${event.id}`,
    source: 'activity' as const,
    sourceId: event.id,
    taskId: event.taskId,
    createdAt: event.createdAt,
    label: event.message,
    eventType: event.eventType,
    eventCategory: mapUsageCodeEventCategory(event.eventType),
    credits: null,
    providerProfileId: null,
    providerProfileName: null,
    providerProfileTagColor: null,
    providerProfileApiMode: null,
  }
}

function getShanghaiTimeParts(date: Date) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? '00'
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  }
}

function formatBucketTimestamp(parts: ReturnType<typeof getShanghaiTimeParts>, month: number, day: number, hour: number, minute: number) {
  return `${parts.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function getUsageCodeBucketMeta(createdAt: string, bucket: UsageCodeEventBucket) {
  const parts = getShanghaiTimeParts(new Date(createdAt))
  if (bucket === 'month') {
    return {
      key: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
      label: `${parts.year}年${String(parts.month).padStart(2, '0')}月`,
    }
  }
  if (bucket === 'day') {
    return {
      key: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
      label: `${parts.year}年${String(parts.month).padStart(2, '0')}月${String(parts.day).padStart(2, '0')}日`,
    }
  }
  if (bucket === 'hour') {
    return {
      key: formatBucketTimestamp(parts, parts.month, parts.day, parts.hour, 0),
      label: `${parts.year}年${String(parts.month).padStart(2, '0')}月${String(parts.day).padStart(2, '0')}日 ${String(parts.hour).padStart(2, '0')}:00`,
    }
  }
  const step = bucket === '30m' ? 30 : bucket === '15m' ? 15 : 5
  const bucketMinute = Math.floor(parts.minute / step) * step
  const nextMinute = bucketMinute + step
  const endHour = nextMinute >= 60 ? parts.hour + 1 : parts.hour
  const endMinute = nextMinute >= 60 ? nextMinute - 60 : nextMinute
  return {
    key: formatBucketTimestamp(parts, parts.month, parts.day, parts.hour, bucketMinute),
    label: `${parts.year}年${String(parts.month).padStart(2, '0')}月${String(parts.day).padStart(2, '0')}日 ${String(parts.hour).padStart(2, '0')}:${String(bucketMinute).padStart(2, '0')} - ${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`,
  }
}

function buildUsageCodeEventSummary(items: UsageCodeEventItem[]) {
  return items.reduce((summary, item) => {
    summary.totalEvents += 1
    if (item.eventCategory === 'create') summary.createCount += 1
    if (item.eventType === 'image_task_succeeded') summary.generatedImageCount += Number(item.label.match(/(\d+)/)?.[1] ?? 0)
    if (item.eventType === 'video_task_succeeded') summary.generatedVideoCount += 1
    if (item.eventCategory === 'delete') summary.deletedTaskCount += 1
    if (item.eventCategory === 'backup') summary.backupCount += 1
    if (item.eventCategory === 'api_access_change') summary.apiAccessChangeCount += 1
    if (item.eventCategory === 'quota_increase') {
      if (item.providerProfileApiMode === 'videos') summary.videoQuotaIncreasedCredits += Math.max(0, item.credits ?? 0)
      else summary.imageQuotaIncreasedCredits += Math.max(0, item.credits ?? 0)
    }
    if (item.eventCategory === 'quota_decrease') {
      if (item.providerProfileApiMode === 'videos') summary.videoQuotaDecreasedCredits += Math.max(0, item.credits ?? 0)
      else summary.imageQuotaDecreasedCredits += Math.max(0, item.credits ?? 0)
    }
    if (item.eventCategory === 'export') summary.exportCount += 1
    if (item.eventCategory === 'distribution_change') summary.distributionChangeCount += 1
    if (item.eventCategory === 'rename') summary.renameCount += 1
    if (item.eventCategory === 'enable_disable') summary.enableDisableCount += 1
    return summary
  }, {
    totalEvents: 0,
    createCount: 0,
    generatedImageCount: 0,
    generatedVideoCount: 0,
    deletedTaskCount: 0,
    backupCount: 0,
    apiAccessChangeCount: 0,
    imageQuotaIncreasedCredits: 0,
    videoQuotaIncreasedCredits: 0,
    imageQuotaDecreasedCredits: 0,
    videoQuotaDecreasedCredits: 0,
    exportCount: 0,
    distributionChangeCount: 0,
    renameCount: 0,
    enableDisableCount: 0,
  })
}

function getUsageCodeQueryRange(timePreset: UsageCodeEventTimePreset, startAt?: string | null, endAt?: string | null) {
  if (timePreset === 'custom') {
    return {
      startAt: startAt?.trim() || null,
      endAt: endAt?.trim() || null,
    }
  }

  const now = new Date()
  const parts = getShanghaiTimeParts(now)
  const startTodayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, -8, 0, 0, 0))
  if (timePreset === 'today') {
    return {
      startAt: startTodayUtc.toISOString(),
      endAt: null,
    }
  }
  if (timePreset === 'yesterday') {
    return {
      startAt: new Date(startTodayUtc.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      endAt: startTodayUtc.toISOString(),
    }
  }
  if (timePreset === 'last7days') {
    return {
      startAt: new Date(startTodayUtc.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      endAt: null,
    }
  }
  return {
    startAt: new Date(startTodayUtc.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString(),
    endAt: null,
  }
}

function formatUsageCodeAccessLabel(app: Parameters<FastifyPluginAsync>[0], providerIds: string[] | null | undefined) {
  if (!providerIds?.length) return '全部 API'
  const names = providerIds
    .map((id) => {
      const profile = app.db.getProviderProfile(id)
      return profile?.remarkName ?? profile?.name ?? id
    })
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

function filterReminderItemsForUser(items: ReturnType<typeof getReminderItems>, auth: Awaited<ReturnType<typeof requireAuth>>) {
  if (auth.role === 'admin') return items
  const userTiers = new Set(auth.usageCodes.map((code) => code.userTier))
  return items.filter((item) => {
    if (!item.enabled) return false
    const audienceTiers: UsageCodeUserTier[] = item.audienceTiers?.length ? item.audienceTiers : ['free', 'paid']
    return audienceTiers.some((tier) => userTiers.has(tier))
  })
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

async function listBackupArtifacts(rootDir: string, currentDir = rootDir): Promise<Array<{
  absolutePath: string
  fileName: string
  bytes: number
  modifiedAt: string
}>> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
  const results: Array<{
    absolutePath: string
    fileName: string
    bytes: number
    modifiedAt: string
  }> = []

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      if (path.resolve(absolutePath) === path.resolve(path.join(rootDir, 'imports'))) continue
      results.push(...await listBackupArtifacts(rootDir, absolutePath))
      continue
    }
    const extension = path.extname(entry.name).toLowerCase()
    if (!entry.isFile() || (extension !== '.zip' && extension !== '.json')) continue
    const stat = await fs.stat(absolutePath)
    results.push({
      absolutePath,
      fileName: path.relative(rootDir, absolutePath).replace(/\\/g, '/'),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  }

  return results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
}

async function listBackupImportCandidates(rootDir: string): Promise<BackupImportCandidate[]> {
  const artifacts = await listBackupArtifacts(rootDir)
  const artifactMap = new Map(artifacts.map((item) => [path.resolve(item.absolutePath), item] as const))
  const splitCandidates: BackupImportCandidate[] = []
  const splitPartPaths = new Set<string>()

  for (const artifact of artifacts) {
    if (path.extname(artifact.absolutePath).toLowerCase() !== '.json') continue
    try {
      const parsed = splitBackupIndexSchema.parse(JSON.parse(await fs.readFile(artifact.absolutePath, 'utf-8')))
      let bytes = artifact.bytes
      let latestModifiedAt = artifact.modifiedAt
      const missingPartNames: string[] = []
      let foundPartCount = 0

      for (const part of parsed.parts) {
        const partPath = path.resolve(path.join(path.dirname(artifact.absolutePath), part.name))
        splitPartPaths.add(partPath)
        const matched = artifactMap.get(partPath)
        if (!matched) {
          missingPartNames.push(part.name)
          continue
        }
        foundPartCount += 1
        bytes += matched.bytes
        if (new Date(matched.modifiedAt).getTime() > new Date(latestModifiedAt).getTime()) {
          latestModifiedAt = matched.modifiedAt
        }
      }

      splitCandidates.push({
        kind: 'split',
        filePath: artifact.absolutePath,
        fileName: artifact.fileName,
        displayName: path.relative(rootDir, path.dirname(artifact.absolutePath)).replace(/\\/g, '/'),
        bytes,
        modifiedAt: latestModifiedAt,
        partCount: parsed.parts.length,
        foundPartCount,
        missingPartNames,
      })
    } catch {
      /* 非引导文件忽略 */
    }
  }

  const singleCandidates: BackupImportCandidate[] = artifacts
    .filter((artifact) => path.extname(artifact.absolutePath).toLowerCase() === '.zip')
    .filter((artifact) => !splitPartPaths.has(path.resolve(artifact.absolutePath)))
    .map((artifact) => ({
      kind: 'single' as const,
      filePath: artifact.absolutePath,
      fileName: artifact.fileName,
      bytes: artifact.bytes,
      modifiedAt: artifact.modifiedAt,
    }))

  return [...splitCandidates, ...singleCandidates]
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
}

function serializeProfile(app: Parameters<FastifyPluginAsync>[0], profile: ProviderProfileRecord, includeApiKey = false) {
  const modelOptions = profile.modelOptions ?? []
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
    remarkName: profile.remarkName,
    tagColor: profile.tagColor,
    baseUrl: profile.baseUrl,
    apiKey: includeApiKey ? apiKey : '',
    apiKeyMasked,
    apiKeyConfigured,
    model: profile.model,
    modelOptions: modelOptions.length ? modelOptions : [profile.model],
    veniceGenerateModel: modelOptions[1] ?? profile.model,
    veniceEditModel: modelOptions[2] ?? profile.model,
    veniceMultiEditModel: modelOptions[3] ?? modelOptions[2] ?? profile.model,
    veniceGenerateEnabled: Boolean(profile.veniceGenerateEnabled),
    veniceEditEnabled: Boolean(profile.veniceEditEnabled),
    veniceMultiEditEnabled: Boolean(profile.veniceMultiEditEnabled),
    veniceSkipResolution: Boolean(profile.veniceSkipResolution),
    apiMode: profile.apiMode,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
    videoMaxDuration: profile.videoMaxDuration,
    videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
    isDefault: Boolean(profile.isDefault),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function serializeProviderOption(profile: ProviderProfileRecord) {
  const modelOptions = profile.modelOptions ?? []
  return {
    id: profile.id,
    name: profile.name,
    remarkName: profile.remarkName,
    tagColor: profile.tagColor,
    apiMode: profile.apiMode,
    model: profile.model,
    modelOptions: modelOptions.length ? modelOptions : [profile.model],
    veniceGenerateModel: modelOptions[1] ?? profile.model,
    veniceEditModel: modelOptions[2] ?? profile.model,
    veniceMultiEditModel: modelOptions[3] ?? modelOptions[2] ?? profile.model,
    veniceGenerateEnabled: Boolean(profile.veniceGenerateEnabled),
    veniceEditEnabled: Boolean(profile.veniceEditEnabled),
    veniceMultiEditEnabled: Boolean(profile.veniceMultiEditEnabled),
    veniceSkipResolution: Boolean(profile.veniceSkipResolution),
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
    videoMaxDuration: profile.videoMaxDuration,
    videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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
  const getProviderDisplayName = (providerProfileId: string | null, fallbackName: string | null) => {
    if (!providerProfileId) return fallbackName
    const profile = app.db.getProviderProfile(providerProfileId)
    return profile?.remarkName ?? profile?.name ?? fallbackName
  }

  return {
    id: code.id,
    code: codePlain,
    codeRecoverable: Boolean(codePlain),
    name: code.name,
    userTier: code.userTier,
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
    artifactImageCount: code.artifactImageCount ?? 0,
    artifactVideoCount: code.artifactVideoCount ?? 0,
    taskMediaBytes: code.taskMediaBytes ?? 0,
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
        providerProfileName: getProviderDisplayName(event.providerProfileId, event.providerProfileName),
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

function queryUsageCodeEvents(
  app: Parameters<FastifyPluginAsync>[0],
  input: {
    usageCodeId: string
    page: number
    pageSize: number
    timePreset: UsageCodeEventTimePreset
    startAt?: string | null
    endAt?: string | null
    bucket: UsageCodeEventBucket
    eventCategories: UsageCodeEventCategory[]
    taskId?: string | null
  },
) {
  const range = getUsageCodeQueryRange(input.timePreset, input.startAt, input.endAt)
  const normalizedEventCategories = input.eventCategories.includes('all')
    ? ['all']
    : input.eventCategories
  const quotaEvents = app.db.listUsageQuotaEventsForQuery({
    usageCodeId: input.usageCodeId,
    startAt: range.startAt,
    endAt: range.endAt,
    taskId: input.taskId?.trim() || null,
  }).map((event) => buildUsageCodeEventItemFromQuota(app, event))
  const activityEvents = app.db.listUsageCodeActivityLogsForQuery({
    usageCodeId: input.usageCodeId,
    startAt: range.startAt,
    endAt: range.endAt,
    taskId: input.taskId?.trim() || null,
  }).map((event) => buildUsageCodeEventItemFromActivity(event))

  const items = [...quotaEvents, ...activityEvents]
    .filter((event) => normalizedEventCategories.includes('all') || normalizedEventCategories.includes(event.eventCategory))
    .sort((left, right) => {
      const timeDiff = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      if (timeDiff !== 0) return timeDiff
      if (left.source !== right.source) return left.source === 'activity' ? 1 : -1
      return right.sourceId - left.sourceId
    })

  const total = items.length
  const totalPages = Math.max(1, Math.ceil(total / input.pageSize))
  const page = Math.min(input.page, totalPages)
  const startIndex = (page - 1) * input.pageSize
  const pagedItems = items.slice(startIndex, startIndex + input.pageSize)
  const groupMap = new Map<string, {
    bucketKey: string
    bucketLabel: string
    items: UsageCodeEventItem[]
  }>()

  for (const event of pagedItems) {
    const bucketMeta = getUsageCodeBucketMeta(event.createdAt, input.bucket)
    const current = groupMap.get(bucketMeta.key)
    if (current) {
      current.items.push(event)
      continue
    }
    groupMap.set(bucketMeta.key, {
      bucketKey: bucketMeta.key,
      bucketLabel: bucketMeta.label,
      items: [event],
    })
  }

  return {
    summary: buildUsageCodeEventSummary(items),
    groups: Array.from(groupMap.values()).map((group) => ({
      bucketKey: group.bucketKey,
      bucketLabel: group.bucketLabel,
      eventCount: group.items.length,
      summary: buildUsageCodeEventSummary(group.items),
      items: group.items,
    })),
    pagination: {
      page,
      pageSize: input.pageSize,
      total,
      totalPages,
    },
    filters: {
      timePreset: input.timePreset,
      startAt: range.startAt,
      endAt: range.endAt,
      bucket: input.bucket,
      eventCategories: normalizedEventCategories,
      taskId: input.taskId?.trim() || '',
    },
    categories: [
      'all',
      'create',
      'generate',
      'delete',
      'backup',
      'api_access_change',
      'quota_increase',
      'quota_decrease',
      'export',
      'distribution_change',
      'rename',
      'enable_disable',
    ].map((value) => ({
      value,
      label: formatUsageCodeEventCategoryLabel(value as UsageCodeEventCategory),
    })),
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

function getUsageCodeMediaExportBaseDir(app: Parameters<FastifyPluginAsync>[0]) {
  return path.join(app.config.backupsDir, 'usage-code-media-exports')
}

function getUsageCodeMediaExportStorageId(usageCodeIds: string[]) {
  return crypto.createHash('sha256').update([...usageCodeIds].filter(Boolean).sort().join(',')).digest('hex').slice(0, 16)
}

function getUsageCodeMediaExportDir(app: Parameters<FastifyPluginAsync>[0], usageCodeIds: string[]) {
  return path.join(getUsageCodeMediaExportBaseDir(app), getUsageCodeMediaExportStorageId(usageCodeIds))
}

function getUsageCodeMediaExportRunnerKey(usageCodeIds: string[]) {
  return [...usageCodeIds].filter(Boolean).sort().join(',')
}

function getUsageCodeMediaDownloadOwner(request: FastifyRequest) {
  return getSessionToken(request) ?? `ip:${request.ip}`
}

function buildUsageMediaArchiveEntries(entries: ReturnType<typeof getUsageMediaArchiveEntries>) {
  const folderCount = new Map<string, number>()
  const taskFolderMap = new Map<string, string>()
  const taskFileCount = new Map<string, Map<string, number>>()
  const archiveEntries: Array<{ sourceFilePath: string; archivePath: string; bytes: number }> = []

  for (const entry of entries) {
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

    archiveEntries.push({
      sourceFilePath: entry.filePath,
      archivePath: `${folderName}/${buildUsageMediaArchiveFileName(entry, nextFileIndex)}`,
      bytes: entry.bytes,
    })
  }

  return archiveEntries
}

function resolveUsageCodeMediaExportPath(app: Parameters<FastifyPluginAsync>[0], filePath: string) {
  const rootDir = getUsageCodeMediaExportBaseDir(app)
  const resolved = path.resolve(filePath)
  const relative = path.relative(rootDir, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('导出文件路径无效')
  }
  return resolved
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

type LegacyImportImage = Omit<z.infer<typeof backupImageSchema>, 'dataUrl'> & { binary?: Buffer }

type LegacyImportPayload = {
  runtimeSettings: z.infer<typeof runtimeSettingsSchema>
  tasks: z.infer<typeof backupTaskSchema>[]
  images: LegacyImportImage[]
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
    providerProfileModel?: string | null
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
  tempDir: string | null
  mediaStats: {
    totalFiles: number
    totalBytes: number
  }
  restoreMediaToDir: (
    targetDir: string,
    onProgress: (progress: {
      processedFiles: number
      processedBytes: number
      currentFilePath: string | null
      message?: string
    }) => void,
  ) => Promise<void>
  cleanupPaths: string[]
}

type BackupImportCandidate =
  | {
      kind: 'single'
      filePath: string
      fileName: string
      displayName?: string
      bytes: number
      modifiedAt: string
    }
  | {
      kind: 'split'
      filePath: string
      fileName: string
      displayName?: string
      bytes: number
      modifiedAt: string
      partCount: number
      foundPartCount: number
      missingPartNames: string[]
    }

let backupExportRunner: Promise<void> | null = null
let remoteResetRunner: Promise<void> | null = null
const usageCodeMediaExportRunners = new Map<string, Promise<void>>()
const usageCodeMediaDownloadLocks = new Map<string, { owner: string; activeCount: number }>()

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const MAX_BACKUP_PART_BYTES = 3_500_000_000
const MAX_USAGE_CODE_MEDIA_EXPORT_PART_BYTES = 512 * 1024 * 1024

function buildFullBackupManifest(app: Parameters<FastifyPluginAsync>[0]) {
  const providerProfiles = app.db.listProviderProfiles().map((profile) => ({
    id: profile.id,
    name: profile.name,
    remarkName: profile.remarkName,
    tagColor: profile.tagColor,
    baseUrl: profile.baseUrl,
    apiKey: decryptText(profile.apiKeyEncrypted, app.config.appSecret),
    model: profile.model,
    modelOptions: profile.modelOptions ?? [profile.model],
    apiMode: profile.apiMode,
    timeoutSeconds: profile.timeoutSeconds,
    codexCli: Boolean(profile.codexCli),
    grokApiCompat: Boolean(profile.grokApiCompat),
    xaiImage2kEnabled: Boolean(profile.xaiImage2kEnabled),
    responseFormatB64Json: Boolean(profile.responseFormatB64Json),
    videoMaxResolution: profile.videoMaxResolution,
    videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
    videoMaxDuration: profile.videoMaxDuration,
    videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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
    userTier: code.userTier,
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
    providerProfileModel: task.providerProfileModel,
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

type RemoteResetMode = 'tasks' | 'all' | 'usage_code_tasks_only' | 'admin_tasks_only'

function getRemoteResetOperation(mode: RemoteResetMode) {
  if (mode === 'usage_code_tasks_only') return 'remote_reset_usage_code' as const
  if (mode === 'admin_tasks_only') return 'remote_reset_admin' as const
  if (mode === 'all') return 'remote_reset_all' as const
  return 'remote_reset_tasks' as const
}

function getRemoteResetStartMessage(mode: RemoteResetMode) {
  if (mode === 'usage_code_tasks_only') return '等待现有任务完成后开始清理使用码任务与产物'
  if (mode === 'admin_tasks_only') return '等待现有任务完成后开始清理管理员任务与产物'
  if (mode === 'all') return '等待现有任务完成后开始清空远端全部数据'
  return '等待现有任务完成后开始清空远端记录'
}

function getRemoteResetRunningMessage(mode: RemoteResetMode) {
  if (mode === 'usage_code_tasks_only') return '正在清理使用码任务与产物'
  if (mode === 'admin_tasks_only') return '正在清理管理员任务与产物'
  if (mode === 'all') return '正在清空远端全部数据'
  return '正在清空远端记录'
}

function getRemoteResetCompletedMessage(mode: RemoteResetMode) {
  if (mode === 'usage_code_tasks_only') return '使用码任务与产物已清理完成'
  if (mode === 'admin_tasks_only') return '管理员任务与产物已清理完成'
  if (mode === 'all') return '远端全部数据已清空'
  return '远端记录已清空'
}

function getRemoteResetFailedMessage(mode: RemoteResetMode) {
  if (mode === 'usage_code_tasks_only') return '清理使用码任务与产物失败'
  if (mode === 'admin_tasks_only') return '清理管理员任务与产物失败'
  if (mode === 'all') return '清空远端全部数据失败'
  return '清空远端记录失败'
}

async function runRemoteResetJob(
  app: Parameters<FastifyPluginAsync>[0],
  mode: RemoteResetMode,
  usageCodeIds?: string[],
  taskIds?: string[],
) {
  const normalizedUsageCodeIds = Array.from(new Set(
    (usageCodeIds ?? [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean),
  ))
  const normalizedTaskIds = Array.from(new Set(
    (taskIds ?? [])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean),
  ))
  const startedAt = new Date().toISOString()
  const operation = getRemoteResetOperation(mode)
  setBackupJobState(app, {
    ...getDefaultBackupJobState(),
    active: true,
    operation,
    phase: 'preparing',
    message: getRemoteResetStartMessage(mode),
    progressPercent: 5,
    startedAt,
  })

  try {
    while (true) {
      const snapshot = app.taskWorker.getSnapshot()
      patchBackupJobState(app, {
        waitingRunningTasks: snapshot.runningCount,
        waitingPendingTasks: snapshot.pendingCount,
        message: snapshot.runningCount > 0 || snapshot.pendingCount > 0
          ? `等待队列清空：执行中 ${snapshot.runningCount}，排队中 ${snapshot.pendingCount}`
          : getRemoteResetRunningMessage(mode),
      })
      if (snapshot.runningCount === 0 && snapshot.pendingCount === 0) break
      await sleep(1000)
    }

    const cleanupRecords = mode === 'usage_code_tasks_only'
      ? app.db.listUsageCodeTaskMediaCleanupRecords(normalizedUsageCodeIds.length ? normalizedUsageCodeIds : undefined)
      : mode === 'admin_tasks_only'
        ? app.db.listAdminTaskMediaCleanupRecords(normalizedTaskIds.length ? normalizedTaskIds : undefined)
        : app.db.listTaskMediaCleanupRecords()
    const taskMap = new Map<string, { ownerUsageCodeId: string | null; ownerKind: string }>()
    const usageCodeSummaryMap = new Map<string, { outputImageCount: number; outputVideoCount: number }>()
    const directoryStats = new Map<string, { fileCount: number; bytes: number }>()
    const fileStats = new Map<string, { bytes: number }>()

    for (const record of cleanupRecords) {
      taskMap.set(record.taskId, {
        ownerUsageCodeId: record.ownerUsageCodeId,
        ownerKind: record.ownerKind,
      })

      if (mode === 'usage_code_tasks_only' && record.ownerUsageCodeId) {
        const summary = usageCodeSummaryMap.get(record.ownerUsageCodeId) ?? { outputImageCount: 0, outputVideoCount: 0 }
        if (record.kind === 'output') summary.outputImageCount += 1
        if (record.kind === 'video_output') summary.outputVideoCount += 1
        usageCodeSummaryMap.set(record.ownerUsageCodeId, summary)
      }

      if (!record.filePath) continue
      const normalizedPath = record.filePath.replace(/\\/g, '/')
      const relativeDir = path.posix.dirname(normalizedPath)
      if (relativeDir && relativeDir !== '.') {
        const current = directoryStats.get(relativeDir) ?? { fileCount: 0, bytes: 0 }
        current.fileCount += 1
        current.bytes += Math.max(0, record.bytes ?? 0)
        directoryStats.set(relativeDir, current)
        continue
      }
      const current = fileStats.get(normalizedPath) ?? { bytes: 0 }
      current.bytes += Math.max(0, record.bytes ?? 0)
      fileStats.set(normalizedPath, current)
    }

    const mediaFileCount = [...directoryStats.values()].reduce((sum, item) => sum + item.fileCount, 0) + fileStats.size
    const mediaBytes = [...directoryStats.values()].reduce((sum, item) => sum + item.bytes, 0)
      + [...fileStats.values()].reduce((sum, item) => sum + item.bytes, 0)
    const totalFiles = Math.max(1, mediaFileCount + 1)
    patchBackupJobState(app, {
      phase: 'running',
      operation,
      message: getRemoteResetRunningMessage(mode),
      progressPercent: 10,
      totalFiles,
      processedFiles: 0,
      totalBytes: mediaBytes,
      processedBytes: 0,
      waitingRunningTasks: 0,
      waitingPendingTasks: 0,
      filename: null,
      filePath: null,
      error: null,
    })

    let processedFiles = 0
    let processedBytes = 0
    const sortedDirectories = [...directoryStats.entries()].sort((left, right) => right[0].length - left[0].length)
    for (const [relativeDir, stats] of sortedDirectories) {
      await fs.rm(path.join(app.config.mediaDir, relativeDir), { recursive: true, force: true }).catch(() => undefined)
      processedFiles += stats.fileCount
      processedBytes += stats.bytes
      patchBackupJobState(app, {
        processedFiles,
        processedBytes,
        progressPercent: Math.max(10, Math.min(95, Math.floor((processedFiles / totalFiles) * 100))),
        message: `${getRemoteResetRunningMessage(mode)}（已处理 ${processedFiles}/${totalFiles - 1} 个媒体文件）`,
      })
    }
    for (const [relativePath, stats] of fileStats) {
      await fs.rm(path.join(app.config.mediaDir, relativePath), { force: true }).catch(() => undefined)
      processedFiles += 1
      processedBytes += stats.bytes
      patchBackupJobState(app, {
        processedFiles,
        processedBytes,
        progressPercent: Math.max(10, Math.min(95, Math.floor((processedFiles / totalFiles) * 100))),
        message: `${getRemoteResetRunningMessage(mode)}（已处理 ${processedFiles}/${totalFiles - 1} 个媒体文件）`,
      })
    }

    patchBackupJobState(app, {
      processedFiles: totalFiles - 1,
      processedBytes: mediaBytes,
      progressPercent: 96,
      message: '正在清理数据库记录',
    })

    if (mode === 'usage_code_tasks_only') {
      app.db.clearUsageCodeTaskData(normalizedUsageCodeIds.length ? normalizedUsageCodeIds : undefined)
      for (const [usageCodeId, summary] of usageCodeSummaryMap) {
        app.db.insertUsageCodeActivityLog({
          usageCodeId,
          actorKind: 'admin',
          eventType: 'admin_task_purged',
          message: `管理员批量清理使用码任务，删除图片 ${summary.outputImageCount} 张，视频 ${summary.outputVideoCount} 个`,
        })
      }
      for (const [taskId, task] of taskMap) {
        app.taskWorker.cancel(taskId)
        app.taskEvents.emitDeleted(taskId, {
          ownerUsageCodeId: task.ownerUsageCodeId,
          ownerKind: task.ownerKind,
        })
      }
    } else if (mode === 'admin_tasks_only') {
      app.db.clearAdminTaskData(normalizedTaskIds.length ? normalizedTaskIds : undefined)
      for (const [taskId, task] of taskMap) {
        app.taskWorker.cancel(taskId)
        app.taskEvents.emitDeleted(taskId, {
          ownerUsageCodeId: task.ownerUsageCodeId,
          ownerKind: task.ownerKind,
        })
      }
    } else {
      const existingTasks = [...taskMap.entries()].map(([taskId, task]) => ({
        id: taskId,
        ownerUsageCodeId: task.ownerUsageCodeId,
        ownerKind: task.ownerKind,
      }))
      await fs.mkdir(app.config.mediaDir, { recursive: true })
      await fs.mkdir(app.config.uploadsDir, { recursive: true })
      await fs.mkdir(app.config.masksDir, { recursive: true })
      await fs.mkdir(app.config.outputsDir, { recursive: true })
      await fs.mkdir(app.config.thumbsDir, { recursive: true })
      if (mode === 'all') {
        app.db.clearRuntimeData()
      } else {
        app.db.clearTaskData()
      }
      for (const task of existingTasks) {
        app.taskWorker.cancel(task.id)
        app.taskEvents.emitDeleted(task.id, {
          ownerUsageCodeId: task.ownerUsageCodeId,
          ownerKind: task.ownerKind,
        })
      }
    }

    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation,
      phase: 'completed',
      message: getRemoteResetCompletedMessage(mode),
      progressPercent: 100,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalFiles,
      processedFiles: totalFiles,
      totalBytes: mediaBytes,
      processedBytes: mediaBytes,
      error: null,
    })
    appendManagementOperationLog(app, {
      operation,
      status: 'completed',
      title: getRemoteResetCompletedMessage(mode),
      detail: mode === 'usage_code_tasks_only'
        ? normalizedUsageCodeIds.length
          ? `已清理 ${taskMap.size} 条指定分发码任务与对应媒体产物（${normalizedUsageCodeIds.length} 个分发码）`
          : `已清理 ${taskMap.size} 条使用码任务与对应媒体产物`
        : mode === 'admin_tasks_only'
          ? normalizedTaskIds.length
            ? `已清理 ${taskMap.size} 条指定管理员任务与对应媒体产物`
            : `已清理 ${taskMap.size} 条管理员任务与对应媒体产物`
        : mode === 'all'
          ? '后端任务、媒体与运行配置已清空'
          : '后端任务记录与媒体产物已清空',
      createdAt: new Date().toISOString(),
    })
  } catch (error) {
    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation,
      phase: 'failed',
      message: getRemoteResetFailedMessage(mode),
      progressPercent: 100,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    appendManagementOperationLog(app, {
      operation,
      status: 'failed',
      title: getRemoteResetFailedMessage(mode),
      detail: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    })
    throw error
  } finally {
    remoteResetRunner = null
  }
}

function toUint8Array(chunk: Buffer | Uint8Array | string) {
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk)
  }
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

async function writeFullBackupArchiveToFile(
  outputPath: string,
  input: {
    manifestJson?: string | null
    taskImages: Array<{ filePath: string; bytes: number }>
    mediaDir: string
  },
  options: {
    onProgress?: (input: { processedFiles: number; processedBytes: number; totalFiles: number; totalBytes: number }) => Promise<void> | void
  } = {},
) {
  const output = createWriteStream(outputPath)
  const zip = new Zip()
  const hash = crypto.createHash('sha256')
  const pendingWriteLimitBytes = 8 * 1024 * 1024
  const manifestBytes = input.manifestJson ? Buffer.byteLength(input.manifestJson, 'utf-8') : 0
  const totalFiles = input.taskImages.length + (input.manifestJson ? 1 : 0)
  const totalBytes = input.taskImages.reduce((sum, image) => sum + image.bytes, manifestBytes)
  let pendingWriteBytes = 0
  let writeChain = Promise.resolve()
  let zipClosed = false
  let processedFiles = 0
  let processedBytes = 0

  const reportProgress = async () => {
    await options.onProgress?.({
      processedFiles,
      processedBytes,
      totalFiles,
      totalBytes,
    })
  }

  const writeChunk = (chunk: Uint8Array) => new Promise<void>((resolve, reject) => {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    hash.update(buffer)
    pendingWriteBytes += buffer.byteLength
    output.write(buffer, (error) => {
      pendingWriteBytes -= buffer.byteLength
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  const closeOutput = () => new Promise<void>((resolve, reject) => {
    if (zipClosed) {
      resolve()
      return
    }
    zipClosed = true
    output.end((error?: Error | null) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  const zipFinished = new Promise<void>((resolve, reject) => {
    output.once('error', reject)
    zip.ondata = (error, chunk, final) => {
      if (error) {
        reject(error)
        return
      }

      writeChain = writeChain
        .then(() => writeChunk(chunk))
        .then(async () => {
          if (final) {
            await closeOutput()
          }
        })
        .catch(reject)
    }

    writeChain
      .then(() => finished(output))
      .then(() => resolve())
      .catch(reject)
  })

  if (input.manifestJson) {
    const manifestEntry = new ZipDeflate('manifest.json', { level: 6 })
    zip.add(manifestEntry)
    manifestEntry.push(toUint8Array(input.manifestJson), true)
    processedFiles += 1
    processedBytes += manifestBytes
    await reportProgress()
  }

  for (const image of input.taskImages) {
    const absolutePath = path.join(input.mediaDir, image.filePath)
    const fileEntry = new ZipPassThrough(image.filePath)
    zip.add(fileEntry)

    let previousChunk: Buffer | null = null
    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (previousChunk) {
        fileEntry.push(toUint8Array(previousChunk), false)
        processedBytes += previousChunk.byteLength
        await reportProgress()
        if (pendingWriteBytes >= pendingWriteLimitBytes) {
          await writeChain
        }
      }
      previousChunk = buffer
    }

    fileEntry.push(toUint8Array(previousChunk ?? Buffer.alloc(0)), true)
    processedBytes += previousChunk?.byteLength ?? 0
    processedFiles += 1
    await reportProgress()
    if (pendingWriteBytes >= pendingWriteLimitBytes) {
      await writeChain
    }
  }

  zip.end()
  await zipFinished
  const stat = await fs.stat(outputPath)
  return {
    bytes: stat.size,
    sha256: hash.digest('hex'),
  }
}

async function writeUsageMediaArchiveToFile(
  outputPath: string,
  input: {
    textFiles?: Array<{ name: string; content: string }>
    files: Array<{ sourceFilePath: string; archivePath: string; bytes: number }>
    mediaDir: string
  },
  options: {
    onProgress?: (input: { processedFiles: number; processedBytes: number; totalFiles: number; totalBytes: number }) => Promise<void> | void
  } = {},
) {
  const output = createWriteStream(outputPath)
  const zip = new Zip()
  const hash = crypto.createHash('sha256')
  const pendingWriteLimitBytes = 8 * 1024 * 1024
  const textFiles = input.textFiles ?? []
  const textFileBytes = textFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf-8'), 0)
  const totalFiles = input.files.length + textFiles.length
  const totalBytes = input.files.reduce((sum, file) => sum + file.bytes, textFileBytes)
  let pendingWriteBytes = 0
  let writeChain = Promise.resolve()
  let zipClosed = false
  let processedFiles = 0
  let processedBytes = 0

  const reportProgress = async () => {
    await options.onProgress?.({
      processedFiles,
      processedBytes,
      totalFiles,
      totalBytes,
    })
  }

  const writeChunk = (chunk: Uint8Array) => new Promise<void>((resolve, reject) => {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    hash.update(buffer)
    pendingWriteBytes += buffer.byteLength
    output.write(buffer, (error) => {
      pendingWriteBytes -= buffer.byteLength
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  const closeOutput = () => new Promise<void>((resolve, reject) => {
    if (zipClosed) {
      resolve()
      return
    }
    zipClosed = true
    output.end((error?: Error | null) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

  const zipFinished = new Promise<void>((resolve, reject) => {
    output.once('error', reject)
    zip.ondata = (error, chunk, final) => {
      if (error) {
        reject(error)
        return
      }

      writeChain = writeChain
        .then(() => writeChunk(chunk))
        .then(async () => {
          if (final) {
            await closeOutput()
          }
        })
        .catch(reject)
    }

    writeChain
      .then(() => finished(output))
      .then(() => resolve())
      .catch(reject)
  })

  for (const textFile of textFiles) {
    const entry = new ZipDeflate(textFile.name, { level: 6 })
    zip.add(entry)
    entry.push(toUint8Array(textFile.content), true)
    processedFiles += 1
    processedBytes += Buffer.byteLength(textFile.content, 'utf-8')
    await reportProgress()
  }

  for (const file of input.files) {
    const absolutePath = path.join(input.mediaDir, file.sourceFilePath)
    const fileEntry = new ZipPassThrough(file.archivePath)
    zip.add(fileEntry)

    let previousChunk: Buffer | null = null
    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (previousChunk) {
        fileEntry.push(toUint8Array(previousChunk), false)
        processedBytes += previousChunk.byteLength
        await reportProgress()
        if (pendingWriteBytes >= pendingWriteLimitBytes) {
          await writeChain
        }
      }
      previousChunk = buffer
    }

    fileEntry.push(toUint8Array(previousChunk ?? Buffer.alloc(0)), true)
    processedBytes += previousChunk?.byteLength ?? 0
    processedFiles += 1
    await reportProgress()
    if (pendingWriteBytes >= pendingWriteLimitBytes) {
      await writeChain
    }
  }

  zip.end()
  await zipFinished
  const stat = await fs.stat(outputPath)
  return {
    bytes: stat.size,
    sha256: hash.digest('hex'),
  }
}

function getBackupProgressPercent(input: {
  phase: 'preparing' | 'running' | 'completed' | 'failed'
  processedBytes?: number
  totalBytes?: number
}) {
  if (input.phase === 'completed') return 100
  if (input.phase === 'failed') return 0
  if (input.phase === 'preparing') return 5
  const totalBytes = Math.max(0, input.totalBytes ?? 0)
  const processedBytes = Math.max(0, input.processedBytes ?? 0)
  if (totalBytes <= 0) return 10
  return Math.max(10, Math.min(99, Math.floor((processedBytes / totalBytes) * 100)))
}

function buildSplitBackupPlan(manifest: ReturnType<typeof buildFullBackupManifest>, backupId: string) {
  const manifestJson = JSON.stringify(manifest, null, 2)
  const totalBytes = manifest.taskImages.reduce((sum, image) => sum + image.bytes, Buffer.byteLength(manifestJson, 'utf-8'))
  if (totalBytes <= MAX_BACKUP_PART_BYTES) return null

  const parts: Array<{
    name: string
    taskImages: Array<(typeof manifest.taskImages)[number]>
    estimatedBytes: number
  }> = []

  let currentImages: Array<(typeof manifest.taskImages)[number]> = []
  let currentBytes = Buffer.byteLength(manifestJson, 'utf-8')

  for (const image of manifest.taskImages) {
    const willOverflow = currentImages.length > 0 && currentBytes + image.bytes > MAX_BACKUP_PART_BYTES
    if (willOverflow) {
      parts.push({
        name: `${backupId}.part-${String(parts.length + 1).padStart(3, '0')}.zip`,
        taskImages: currentImages,
        estimatedBytes: currentBytes,
      })
      currentImages = []
      currentBytes = 0
    }
    currentImages.push(image)
    currentBytes += image.bytes
  }

  if (currentImages.length > 0) {
    parts.push({
      name: `${backupId}.part-${String(parts.length + 1).padStart(3, '0')}.zip`,
      taskImages: currentImages,
      estimatedBytes: currentBytes,
    })
  }

  return {
    backupId,
    manifestJson,
    totalBytes,
    totalFiles: manifest.taskImages.length + 1,
    parts,
  }
}

function buildUsageMediaSplitPlan(
  files: Array<{ sourceFilePath: string; archivePath: string; bytes: number }>,
  textFiles: Array<{ name: string; content: string }>,
  exportId: string,
) {
  const textFileBytes = textFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf-8'), 0)
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, textFileBytes)
  if (totalBytes <= MAX_USAGE_CODE_MEDIA_EXPORT_PART_BYTES) return null

  const parts: Array<{
    name: string
    files: typeof files
    estimatedBytes: number
    textFiles: Array<{ name: string; content: string }>
  }> = []

  let currentFiles: typeof files = []
  let currentBytes = textFileBytes

  for (const file of files) {
    const willOverflow = currentFiles.length > 0 && currentBytes + file.bytes > MAX_USAGE_CODE_MEDIA_EXPORT_PART_BYTES
    if (willOverflow) {
      parts.push({
        name: `${exportId}.part-${String(parts.length + 1).padStart(3, '0')}.zip`,
        files: currentFiles,
        estimatedBytes: currentBytes,
        textFiles: parts.length === 0 ? textFiles : [],
      })
      currentFiles = []
      currentBytes = 0
    }

    currentFiles.push(file)
    currentBytes += file.bytes
  }

  if (currentFiles.length > 0 || textFiles.length > 0) {
    parts.push({
      name: `${exportId}.part-${String(parts.length + 1).padStart(3, '0')}.zip`,
      files: currentFiles,
      estimatedBytes: currentBytes,
      textFiles: parts.length === 0 ? textFiles : [],
    })
  }

  return {
    exportId,
    totalBytes,
    totalFiles: files.length + textFiles.length,
    parts,
  }
}

async function removeUsageCodeMediaExportDir(app: Parameters<FastifyPluginAsync>[0], usageCodeIds: string[]) {
  const exportDir = getUsageCodeMediaExportDir(app, usageCodeIds)
  await fs.rm(exportDir, { recursive: true, force: true })
}

function appendUsageCodeActivityLogs(
  app: Parameters<FastifyPluginAsync>[0],
  usageCodeIds: string[],
  eventType: string,
  message: string,
  createdAt = new Date().toISOString(),
) {
  for (const usageCodeId of usageCodeIds) {
    app.db.insertUsageCodeActivityLog({
      usageCodeId,
      actorKind: 'user',
      eventType,
      message,
      createdAt,
    })
  }
}

function getUsageCodeMediaDownloadLockState(usageCodeIds: string[]) {
  return usageCodeMediaDownloadLocks.get(getUsageCodeMediaExportRunnerKey(usageCodeIds)) ?? null
}

function acquireUsageCodeMediaDownloadLock(usageCodeIds: string[], owner: string) {
  const key = getUsageCodeMediaExportRunnerKey(usageCodeIds)
  const current = usageCodeMediaDownloadLocks.get(key)
  if (current && current.owner !== owner && current.activeCount > 0) {
    return { ok: false as const, message: '当前已有其他客户端在下载这批分包，请稍后再试' }
  }
  if (current && current.owner === owner && current.activeCount >= 2) {
    return { ok: false as const, message: '当前客户端最多同时下载两个分包' }
  }

  usageCodeMediaDownloadLocks.set(key, {
    owner,
    activeCount: (current?.owner === owner ? current.activeCount : 0) + 1,
  })
  return { ok: true as const }
}

function releaseUsageCodeMediaDownloadLock(usageCodeIds: string[], owner: string) {
  const key = getUsageCodeMediaExportRunnerKey(usageCodeIds)
  const current = usageCodeMediaDownloadLocks.get(key)
  if (!current || current.owner !== owner) return
  if (current.activeCount <= 1) {
    usageCodeMediaDownloadLocks.delete(key)
    return
  }
  usageCodeMediaDownloadLocks.set(key, {
    owner,
    activeCount: current.activeCount - 1,
  })
}

async function readUsageCodeMediaExportArtifacts(app: Parameters<FastifyPluginAsync>[0], usageCodeIds: string[]) {
  const exportState = getUsageCodeMediaExportState(app, usageCodeIds)
  if (!exportState.filePath) return []

  const exportDir = getUsageCodeMediaExportDir(app, usageCodeIds)
  const resolvedFilePath = resolveUsageCodeMediaExportPath(app, exportState.filePath)

  const fileName = path.basename(resolvedFilePath)
  if (fileName.toLowerCase().endsWith('.json')) {
    const parsedIndex = usageCodeMediaExportIndexSchema.parse(JSON.parse(await fs.readFile(resolvedFilePath, 'utf-8')))
    const items: Array<{ fileName: string; bytes: number; modifiedAt: string }> = []
    for (const part of parsedIndex.parts) {
      const partPath = path.join(exportDir, part.name)
      const partStat = await fs.stat(partPath)
      items.push({
        fileName: part.name,
        bytes: partStat.size,
        modifiedAt: partStat.mtime.toISOString(),
      })
    }
    return items
  }

  const stat = await fs.stat(resolvedFilePath)
  return [{
    fileName,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  }]
}

async function runUsageCodeMediaExportJob(
  app: Parameters<FastifyPluginAsync>[0],
  usageCodeIds: string[],
) {
  const startedAt = new Date().toISOString()
  const entries = getUsageMediaArchiveEntries(app, usageCodeIds)
  const summary = summarizeUsageMediaEntries(entries)
  const archiveEntries = buildUsageMediaArchiveEntries(entries)
  const textFiles = archiveEntries.length ? [] : [{ name: 'README.txt', content: '当前使用码下没有可导出的图片或视频文件。' }]
  const exportId = `usage-code-media-${Date.now()}`
  const exportDir = getUsageCodeMediaExportDir(app, usageCodeIds)
  const splitPlan = buildUsageMediaSplitPlan(archiveEntries, textFiles, exportId)
  const filename = splitPlan ? `${exportId}.index.json` : `${exportId}.zip`
  const filePath = path.join(exportDir, filename)
  const totalBytes = splitPlan?.totalBytes ?? summary.totalBytes + textFiles.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf-8'), 0)
  const totalFiles = splitPlan?.totalFiles ?? archiveEntries.length + textFiles.length
  let lastProgressUpdatedAt = 0

  setUsageCodeMediaExportState(app, usageCodeIds, {
    ...getDefaultBackupJobState(),
    active: true,
    operation: 'usage_code_media_export',
    phase: 'preparing',
    message: '正在整理导出文件',
    progressPercent: 5,
    startedAt,
    filename,
    filePath,
    totalFiles,
    totalBytes,
  })

  try {
    await removeUsageCodeMediaExportDir(app, usageCodeIds)
    await fs.mkdir(exportDir, { recursive: true })

    if (splitPlan) {
      const indexParts: z.infer<typeof usageCodeMediaExportPartSchema>[] = []

      patchUsageCodeMediaExportState(app, usageCodeIds, {
        phase: 'running',
        message: '正在写入导出分包',
        progressPercent: 10,
      })

      for (let index = 0; index < splitPlan.parts.length; index += 1) {
        const part = splitPlan.parts[index]
        const partPath = path.join(exportDir, part.name)
        const partResult = await writeUsageMediaArchiveToFile(partPath, {
          textFiles: part.textFiles,
          files: part.files,
          mediaDir: app.config.mediaDir,
        }, {
          onProgress: async ({ processedFiles, processedBytes }) => {
            const processedFilesBeforePart = splitPlan.parts
              .slice(0, index)
              .reduce((sum, item) => sum + item.files.length + item.textFiles.length, 0)
            const processedBytesBeforePart = splitPlan.parts
              .slice(0, index)
              .reduce((sum, item) => (
                sum
                + item.files.reduce((inner, file) => inner + file.bytes, 0)
                + item.textFiles.reduce((inner, file) => inner + Buffer.byteLength(file.content, 'utf-8'), 0)
              ), 0)
            const nextProcessedFiles = processedFilesBeforePart + processedFiles
            const nextProcessedBytes = processedBytesBeforePart + processedBytes
            const now = Date.now()
            const shouldFlush = nextProcessedFiles >= splitPlan.totalFiles || now - lastProgressUpdatedAt >= 400
            if (!shouldFlush) return
            lastProgressUpdatedAt = now
            patchUsageCodeMediaExportState(app, usageCodeIds, {
              processedFiles: nextProcessedFiles,
              processedBytes: nextProcessedBytes,
              progressPercent: getBackupProgressPercent({
                phase: 'running',
                processedBytes: nextProcessedBytes,
                totalBytes: splitPlan.totalBytes,
              }),
              message: `正在写入第 ${index + 1}/${splitPlan.parts.length} 个分包`,
            })
          },
        })
        const partStat = await fs.stat(partPath)
        indexParts.push({
          name: part.name,
          bytes: partStat.size,
          sha256: partResult.sha256,
          fileCount: part.files.length + part.textFiles.length,
        })
      }

      const indexPayload = {
        kind: 'usage_code_media_export_index' as const,
        version: 1 as const,
        exportId,
        exportedAt: new Date().toISOString(),
        imageCount: summary.imageCount,
        videoCount: summary.videoCount,
        totalBytes: splitPlan.totalBytes,
        totalFiles: splitPlan.totalFiles,
        parts: indexParts,
      }
      await fs.writeFile(filePath, JSON.stringify(indexPayload, null, 2), 'utf-8')
    } else {
      await writeUsageMediaArchiveToFile(filePath, {
        textFiles,
        files: archiveEntries,
        mediaDir: app.config.mediaDir,
      }, {
        onProgress: async ({ processedFiles, processedBytes, totalFiles: nextTotalFiles, totalBytes: nextTotalBytes }) => {
          const now = Date.now()
          const shouldFlush = processedFiles >= nextTotalFiles || now - lastProgressUpdatedAt >= 400
          if (!shouldFlush) return
          lastProgressUpdatedAt = now
          patchUsageCodeMediaExportState(app, usageCodeIds, {
            phase: 'running',
            processedFiles,
            processedBytes,
            totalFiles: nextTotalFiles,
            totalBytes: nextTotalBytes,
            progressPercent: getBackupProgressPercent({
              phase: 'running',
              processedBytes,
              totalBytes: nextTotalBytes,
            }),
            message: `正在写入导出文件（${processedFiles}/${nextTotalFiles}）`,
          })
        },
      })
    }

    const exportTime = new Date().toISOString()
    appendUsageCodeActivityLogs(
      app,
      usageCodeIds,
      'media_exported',
      `最近一次产物导出时间：${new Date(exportTime).toLocaleString('zh-CN')}，图片 ${summary.imageCount} 张，视频 ${summary.videoCount} 个，预计大小 ${formatBytesForDisplay(summary.totalBytes)}`,
      exportTime,
    )

    setUsageCodeMediaExportState(app, usageCodeIds, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'usage_code_media_export',
      phase: 'completed',
      message: splitPlan ? `导出完成，共 ${splitPlan.parts.length} 个分包` : '导出完成',
      progressPercent: 100,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalFiles,
      processedFiles: totalFiles,
      totalBytes,
      processedBytes: totalBytes,
      filename,
      filePath,
      error: null,
    })
  } catch (error) {
    setUsageCodeMediaExportState(app, usageCodeIds, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'usage_code_media_export',
      phase: 'failed',
      message: '导出失败',
      progressPercent: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      filename,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function runBackupExportJob(app: Parameters<FastifyPluginAsync>[0]) {
  const startedAt = new Date().toISOString()
  setBackupJobState(app, {
    ...getDefaultBackupJobState(),
    active: true,
    operation: 'backup_export',
    phase: 'preparing',
    message: '等待现有任务完成后开始备份',
    progressPercent: 5,
    startedAt,
  })

  try {
    while (true) {
      const snapshot = app.taskWorker.getSnapshot()
      patchBackupJobState(app, {
        waitingRunningTasks: snapshot.runningCount,
        waitingPendingTasks: snapshot.pendingCount,
        message: snapshot.runningCount > 0 || snapshot.pendingCount > 0
          ? `等待队列清空：执行中 ${snapshot.runningCount}，排队中 ${snapshot.pendingCount}`
          : '正在整理备份清单',
      })
      if (snapshot.runningCount === 0 && snapshot.pendingCount === 0) break
      await sleep(1000)
    }

    const manifest = buildFullBackupManifest(app)
    await fs.mkdir(app.config.backupsDir, { recursive: true })
    const backupId = `gpt-image-playground-full-backup-${Date.now()}`
    const backupDir = path.join(app.config.backupsDir, backupId)
    await fs.mkdir(backupDir, { recursive: true })
    const splitPlan = buildSplitBackupPlan(manifest, backupId)
    const manifestJson = JSON.stringify(manifest, null, 2)
    const filename = splitPlan ? `${backupId}.index.json` : `${backupId}.zip`
    const filePath = path.join(backupDir, filename)
    let lastProgressUpdatedAt = 0

    patchBackupJobState(app, {
      phase: 'running',
      operation: 'backup_export',
      filename,
      filePath,
      totalFiles: manifest.taskImages.length + 1,
      processedFiles: 0,
      totalBytes: manifest.taskImages.reduce((sum, image) => sum + image.bytes, Buffer.byteLength(manifestJson, 'utf-8')),
      processedBytes: 0,
      waitingRunningTasks: 0,
      waitingPendingTasks: 0,
      message: '正在写入服务器备份包',
      progressPercent: 10,
    })

    let bytes = 0
    if (splitPlan) {
      const indexParts: z.infer<typeof splitBackupIndexPartSchema>[] = []
      const indexFiles: z.infer<typeof splitBackupIndexFileSchema>[] = []
      let aggregateBytes = 0

      for (let index = 0; index < splitPlan.parts.length; index += 1) {
        const part = splitPlan.parts[index]
        const partPath = path.join(backupDir, part.name)
        const partResult = await writeFullBackupArchiveToFile(partPath, {
          manifestJson: index === 0 ? splitPlan.manifestJson : null,
          taskImages: part.taskImages,
          mediaDir: app.config.mediaDir,
        }, {
          onProgress: async ({ processedFiles, processedBytes }) => {
            const processedFilesBeforePart = splitPlan.parts
              .slice(0, index)
              .reduce((sum, item, partIndex) => sum + item.taskImages.length + (partIndex === 0 ? 1 : 0), 0)
            const processedBytesBeforePart = splitPlan.parts
              .slice(0, index)
              .reduce((sum, item, partIndex) => sum + item.taskImages.reduce((inner, image) => inner + image.bytes, partIndex === 0 ? Buffer.byteLength(splitPlan.manifestJson, 'utf-8') : 0), 0)
            const nextProcessedFiles = processedFilesBeforePart + processedFiles
            const nextProcessedBytes = processedBytesBeforePart + processedBytes
            const now = Date.now()
            const shouldFlush = nextProcessedFiles >= splitPlan.totalFiles || now - lastProgressUpdatedAt >= 400
            if (!shouldFlush) return
            lastProgressUpdatedAt = now
            patchBackupJobState(app, {
              processedFiles: nextProcessedFiles,
              processedBytes: nextProcessedBytes,
              totalFiles: splitPlan.totalFiles,
              totalBytes: splitPlan.totalBytes,
              progressPercent: getBackupProgressPercent({
                phase: 'running',
                processedBytes: nextProcessedBytes,
                totalBytes: splitPlan.totalBytes,
              }),
              message: `正在写入第 ${index + 1}/${splitPlan.parts.length} 个分包`,
            })
          },
        })
        const partStat = await fs.stat(partPath)
        aggregateBytes += partStat.size
        indexParts.push({
          name: part.name,
          bytes: partStat.size,
          sha256: partResult.sha256,
          fileCount: part.taskImages.length + (index === 0 ? 1 : 0),
        })
        for (const image of part.taskImages) {
          indexFiles.push({
            filePath: image.filePath,
            partName: part.name,
            bytes: image.bytes,
            sha256: image.sha256,
          })
        }
        bytes += partResult.bytes
      }

      const indexPayload = {
        kind: 'admin_split_backup_index' as const,
        version: 1 as const,
        backupId,
        exportedAt: manifest.exportedAt,
        totalBytes: splitPlan.totalBytes,
        totalFiles: splitPlan.totalFiles,
        manifest,
        parts: indexParts,
        files: indexFiles,
      }
      await fs.writeFile(filePath, JSON.stringify(indexPayload, null, 2), 'utf-8')
      bytes = aggregateBytes + (await fs.stat(filePath)).size
    } else {
      bytes = (await writeFullBackupArchiveToFile(filePath, {
        manifestJson,
        taskImages: manifest.taskImages,
        mediaDir: app.config.mediaDir,
      }, {
        onProgress: async ({ processedFiles, processedBytes, totalFiles, totalBytes }) => {
          const now = Date.now()
          const shouldFlush = processedFiles >= totalFiles || now - lastProgressUpdatedAt >= 400
          if (!shouldFlush) return
          lastProgressUpdatedAt = now
          patchBackupJobState(app, {
            processedFiles,
            processedBytes,
            totalFiles,
            totalBytes,
            progressPercent: getBackupProgressPercent({
              phase: 'running',
              processedBytes,
              totalBytes,
            }),
            message: `正在写入服务器备份包（${processedFiles}/${totalFiles}）`,
          })
        },
      })).bytes
    }

    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'backup_export',
      phase: 'completed',
      message: '备份已完成',
      progressPercent: 100,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalFiles: manifest.taskImages.length + 1,
      processedFiles: manifest.taskImages.length + 1,
      totalBytes: manifest.taskImages.reduce((sum, image) => sum + image.bytes, Buffer.byteLength(manifestJson, 'utf-8')),
      processedBytes: manifest.taskImages.reduce((sum, image) => sum + image.bytes, Buffer.byteLength(manifestJson, 'utf-8')),
      waitingRunningTasks: 0,
      waitingPendingTasks: 0,
      filename,
      filePath,
      error: null,
    })
    appendManagementOperationLog(app, {
      operation: 'backup_export',
      status: 'completed',
      title: '服务器备份已完成',
      detail: `备份文件已写入 ${filePath}`,
      createdAt: new Date().toISOString(),
    })
    app.log.info({ filePath, bytes }, '服务器备份导出完成')
  } catch (error) {
    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'backup_export',
      phase: 'failed',
      message: '备份失败',
      progressPercent: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    appendManagementOperationLog(app, {
      operation: 'backup_export',
      status: 'failed',
      title: '服务器备份失败',
      detail: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    })
    throw error
  }
}

async function runImportRestoreJob<T>(
  app: Parameters<FastifyPluginAsync>[0],
  work: () => Promise<T>,
) {
  const startedAt = new Date().toISOString()
  setBackupJobState(app, {
    ...getDefaultBackupJobState(),
    active: true,
    operation: 'backup_import',
    phase: 'running',
    message: '管理员正在恢复备份',
    progressPercent: 10,
    startedAt,
  })

  try {
    const result = await work()
    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'backup_import',
      phase: 'completed',
      message: '备份恢复已完成',
      progressPercent: 100,
      startedAt,
      finishedAt: new Date().toISOString(),
    })
    appendManagementOperationLog(app, {
      operation: 'backup_import',
      status: 'completed',
      title: '服务器备份恢复已完成',
      detail: '备份数据已恢复到当前服务器',
      createdAt: new Date().toISOString(),
    })
    return result
  } catch (error) {
    setBackupJobState(app, {
      ...getDefaultBackupJobState(),
      active: false,
      operation: 'backup_import',
      phase: 'failed',
      message: '备份恢复失败',
      progressPercent: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    appendManagementOperationLog(app, {
      operation: 'backup_import',
      status: 'failed',
      title: '服务器备份恢复失败',
      detail: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    })
    throw error
  }
}

function buildLegacyImportPayload(app: Parameters<FastifyPluginAsync>[0], payload: LegacyImportPayload): ParsedAdminBackupPayload {
  const nowIso = new Date().toISOString()
  const providerProfileId = 'imported-default'
  const providerProfiles: ProviderProfileRecord[] = [{
    id: providerProfileId,
    name: '导入的默认节点',
    remarkName: null,
    tagColor: 'blue',
    baseUrl: payload.runtimeSettings.baseUrl,
    apiKeyEncrypted: encryptText(payload.runtimeSettings.apiKey, app.config.appSecret),
    model: payload.runtimeSettings.model,
    modelOptions: [payload.runtimeSettings.model],
    apiMode: payload.runtimeSettings.apiMode,
    timeoutSeconds: payload.runtimeSettings.timeoutSeconds,
    codexCli: payload.runtimeSettings.codexCli ? 1 : 0,
    grokApiCompat: payload.runtimeSettings.grokApiCompat ? 1 : 0,
    xaiImage2kEnabled: payload.runtimeSettings.xaiImage2kEnabled ? 1 : 0,
    responseFormatB64Json: payload.runtimeSettings.responseFormatB64Json ? 1 : 0,
    veniceGenerateEnabled: payload.runtimeSettings.veniceGenerateEnabled === false ? 0 : 1,
    veniceEditEnabled: payload.runtimeSettings.veniceEditEnabled === false ? 0 : 1,
    veniceMultiEditEnabled: payload.runtimeSettings.veniceMultiEditEnabled === false ? 0 : 1,
    veniceSkipResolution: payload.runtimeSettings.veniceSkipResolution === true ? 1 : 0,
    videoMaxResolution: payload.runtimeSettings.videoMaxResolution,
    videoResolutionOptions: payload.runtimeSettings.videoResolutionOptions ?? [payload.runtimeSettings.videoMaxResolution],
    videoMaxDuration: payload.runtimeSettings.videoMaxDuration,
    videoDurationOptions: payload.runtimeSettings.videoDurationOptions ?? [payload.runtimeSettings.videoMaxDuration],
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
          bytes: image.bytes,
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

function buildMediaStatsFromTaskImages(taskImages: ParsedAdminBackupPayload['taskImages']) {
  return {
    totalFiles: taskImages.length,
    totalBytes: taskImages.reduce((sum, image) => sum + Math.max(0, image.bytes ?? 0), 0),
  }
}

function buildMediaEntryByteMap(entries: Array<{ filePath: string; bytes: number }>) {
  return new Map(entries.map((entry) => [normalizeArchiveRelativePath(entry.filePath), Math.max(0, entry.bytes)] as const))
}

async function streamArchiveEntriesToDir(
  directory: CentralDirectory,
  targetDir: string,
  requiredEntries: Array<{ filePath: string; bytes: number }>,
  onProgress: (progress: {
    processedFiles: number
    processedBytes: number
    currentFilePath: string | null
    message?: string
  }) => void,
  progressMessage?: string,
) {
  const normalizedPathMap = buildMediaEntryByteMap(requiredEntries)
  let processedFiles = 0
  let processedBytes = 0

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
    processedFiles += 1
    processedBytes += normalizedPathMap.get(normalizedEntryPath) ?? 0
    onProgress({
      processedFiles,
      processedBytes,
      currentFilePath: normalizedEntryPath,
      message: progressMessage,
    })
    normalizedPathMap.delete(normalizedEntryPath)
  }

  for (const expectedPath of normalizedPathMap.keys()) {
    throw new Error(`备份缺少媒体文件：${expectedPath}`)
  }
}

function buildParsedPayloadFromFullManifest(
  app: Parameters<FastifyPluginAsync>[0],
  manifest: z.infer<typeof fullBackupManifestSchema>,
): ParsedAdminBackupPayload {
  return {
    providerProfiles: manifest.providerProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      remarkName: profile.remarkName ?? null,
      tagColor: profile.tagColor ?? null,
      baseUrl: profile.baseUrl,
      apiKeyEncrypted: encryptText(profile.apiKey, app.config.appSecret),
      model: profile.model,
      modelOptions: profile.modelOptions ?? [profile.model],
      apiMode: profile.apiMode,
      timeoutSeconds: profile.timeoutSeconds,
      codexCli: profile.codexCli ? 1 : 0,
      grokApiCompat: profile.grokApiCompat ? 1 : 0,
      xaiImage2kEnabled: profile.xaiImage2kEnabled ? 1 : 0,
      responseFormatB64Json: profile.responseFormatB64Json ? 1 : 0,
      veniceGenerateEnabled: profile.veniceGenerateEnabled === false ? 0 : 1,
      veniceEditEnabled: profile.veniceEditEnabled === false ? 0 : 1,
      veniceMultiEditEnabled: profile.veniceMultiEditEnabled === false ? 0 : 1,
      veniceSkipResolution: profile.veniceSkipResolution ? 1 : 0,
      videoMaxResolution: profile.videoMaxResolution,
      videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
      videoMaxDuration: profile.videoMaxDuration,
      videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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
      userTier: code.userTier ?? inferUsageCodeUserTierFromQuota(code),
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
  }
}

async function parseBackupArchiveFile(
  app: Parameters<FastifyPluginAsync>[0],
  archivePath: string,
): Promise<ParsedAdminBackupImport> {
  const directory = await unzipper.Open.file(archivePath)
  const manifestEntry = directory.files.find((entry) => normalizeArchiveRelativePath(entry.path) === 'manifest.json')
  if (!manifestEntry || manifestEntry.type !== 'File') {
    throw new Error('备份文件缺少 manifest.json')
  }

  const parsedManifest = JSON.parse((await manifestEntry.buffer()).toString('utf-8'))
  if (parsedManifest?.kind === 'admin_full_backup' && parsedManifest?.version === 2) {
    const manifest = fullBackupManifestSchema.parse(parsedManifest)
    const payload = buildParsedPayloadFromFullManifest(app, manifest)
    return {
      kind: 'full' as const,
      archivePath,
      payload,
      tempDir: null,
      mediaStats: buildMediaStatsFromTaskImages(payload.taskImages),
      restoreMediaToDir: async (targetDir, onProgress) => {
        await streamArchiveEntriesToDir(
          directory,
          targetDir,
          payload.taskImages.map((image) => ({
            filePath: image.filePath,
            bytes: image.bytes,
          })),
          onProgress,
          '正在解压媒体文件',
        )
      },
      cleanupPaths: [],
    }
  }

  const manifest = backupManifestSchema.parse(parsedManifest)
  const legacyPayload: LegacyImportPayload = {
    runtimeSettings: manifest.runtimeSettings,
    tasks: manifest.tasks,
    images: manifest.images,
  }
  const payload = buildLegacyImportPayload(app, legacyPayload)
  return {
    kind: 'legacy' as const,
    archivePath,
    payload,
    tempDir: null,
    mediaStats: buildMediaStatsFromTaskImages(payload.taskImages),
    restoreMediaToDir: async (targetDir, onProgress) => {
      await streamArchiveEntriesToDir(
        directory,
        targetDir,
        manifest.images.map((image) => ({
          filePath: image.filePath,
          bytes: image.bytes,
        })),
        onProgress,
        '正在解压媒体文件',
      )
    },
    cleanupPaths: [],
  }
}

async function parseSplitBackupIndexFile(
  app: Parameters<FastifyPluginAsync>[0],
  indexPath: string,
  availableFilePaths?: string[],
): Promise<ParsedAdminBackupImport> {
  const parsedIndex = splitBackupIndexSchema.parse(JSON.parse(await fs.readFile(indexPath, 'utf-8')))
  const availableSet = new Set((availableFilePaths ?? []).map((item) => path.resolve(item)))
  const payload = buildParsedPayloadFromFullManifest(app, parsedIndex.manifest)

  return {
    kind: 'full',
    archivePath: indexPath,
    payload,
    tempDir: null,
    mediaStats: buildMediaStatsFromTaskImages(payload.taskImages),
    restoreMediaToDir: async (targetDir, onProgress) => {
      let processedFiles = 0
      let processedBytes = 0

      for (const [partIndex, part] of parsedIndex.parts.entries()) {
        const partPath = path.resolve(path.join(path.dirname(indexPath), part.name))
        if (availableSet.size > 0 && !availableSet.has(partPath)) {
          throw new Error(`备份缺少分包：${part.name}`)
        }
        const stat = await fs.stat(partPath).catch(() => null)
        if (!stat) {
          throw new Error(`备份缺少分包：${part.name}`)
        }
        if (stat.size !== part.bytes) {
          throw new Error(`备份分包大小不匹配：${part.name}`)
        }
        const directory = await unzipper.Open.file(partPath)
        const requiredEntries = parsedIndex.files
          .filter((item) => item.partName === part.name)
          .map((item) => ({
            filePath: item.filePath,
            bytes: item.bytes,
          }))
        await streamArchiveEntriesToDir(directory, targetDir, requiredEntries, (progress) => {
          onProgress({
            processedFiles: processedFiles + progress.processedFiles,
            processedBytes: processedBytes + progress.processedBytes,
            currentFilePath: progress.currentFilePath,
            message: progress.message,
          })
        }, `正在解压媒体文件（第 ${partIndex + 1}/${parsedIndex.parts.length} 个分包）`)
        processedFiles += requiredEntries.length
        processedBytes += requiredEntries.reduce((sum, item) => sum + item.bytes, 0)
      }
    },
    cleanupPaths: [],
  }
}

async function parseBackupImportPayload(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
): Promise<ParsedAdminBackupImport> {
  const contentType = request.headers['content-type'] ?? ''

  if (contentType.includes('multipart/form-data')) {
    const parts = await request.files()
    const uploadedPaths: string[] = []
    const uploadBatchDir = path.join(app.config.backupImportsDir, `${Date.now()}`)
    await fs.mkdir(uploadBatchDir, { recursive: true })
    for await (const file of parts) {
      const safeFileName = path.basename(file.filename || `backup-${Date.now()}.zip`).replace(/[^\w.-]+/g, '-')
      const archivePath = path.join(uploadBatchDir, safeFileName)
      await pipeline(file.file, createWriteStream(archivePath))
      uploadedPaths.push(archivePath)
    }

    if (uploadedPaths.length === 0) {
      throw new Error('导入请求缺少备份文件')
    }

    const indexFiles = uploadedPaths.filter((item) => path.extname(item).toLowerCase() === '.json')
    if (indexFiles.length > 1) {
      throw new Error('一次只能上传一组备份引导文件')
    }
    if (indexFiles.length === 1) {
      const parsed = await parseSplitBackupIndexFile(app, indexFiles[0], uploadedPaths)
      return {
        ...parsed,
        cleanupPaths: [uploadBatchDir],
      }
    }
    if (uploadedPaths.length !== 1) {
      throw new Error('单包备份只能上传一个 ZIP 文件')
    }
    const parsed = await parseBackupArchiveFile(app, uploadedPaths[0])
    return {
      ...parsed,
      cleanupPaths: [uploadBatchDir],
    }
  }

  const payload = backupImportSchema.parse(request.body)
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
  const parsedPayload = buildLegacyImportPayload(app, legacyPayload)
  return {
    kind: 'legacy' as const,
    archivePath: null,
    payload: parsedPayload,
    tempDir: null,
    mediaStats: buildMediaStatsFromTaskImages(parsedPayload.taskImages),
    restoreMediaToDir: async (targetDir, onProgress) => {
      let processedFiles = 0
      let processedBytes = 0
      for (const image of legacyPayload.images) {
        if (!image.binary) {
          throw new Error(`备份缺少图片数据：${image.filePath}`)
        }
        const normalizedPath = normalizeArchiveRelativePath(image.filePath)
        const destination = path.join(targetDir, normalizedPath)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, image.binary)
        processedFiles += 1
        processedBytes += image.bytes
        onProgress({
          processedFiles,
          processedBytes,
          currentFilePath: normalizedPath,
          message: '正在解压媒体文件',
        })
      }
    },
    cleanupPaths: [],
  }
}

function getRestoreProgressPercent(stage: 'reading' | 'extracting' | 'database' | 'switching', ratio = 0) {
  if (stage === 'reading') return 12
  if (stage === 'extracting') return 20 + Math.floor(Math.max(0, Math.min(1, ratio)) * 60)
  if (stage === 'database') return 88 + Math.floor(Math.max(0, Math.min(1, ratio)) * 8)
  return 97 + Math.floor(Math.max(0, Math.min(1, ratio)) * 2)
}

async function ensureRestoreMediaWorkspace(
  app: Parameters<FastifyPluginAsync>[0],
  targetDir: string,
) {
  await fs.mkdir(targetDir, { recursive: true })
  const relativeDirs = [
    path.relative(app.config.mediaDir, app.config.uploadsDir),
    path.relative(app.config.mediaDir, app.config.masksDir),
    path.relative(app.config.mediaDir, app.config.outputsDir),
    path.relative(app.config.mediaDir, app.config.thumbsDir),
  ]

  for (const relativeDir of relativeDirs) {
    if (!relativeDir || relativeDir === '.') continue
    await fs.mkdir(path.join(targetDir, relativeDir), { recursive: true })
  }
}

async function listDirectoryEntryNames(directory: string) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.map((entry) => entry.name)
}

async function copyDirectoryEntries(fromDir: string, toDir: string) {
  await fs.mkdir(toDir, { recursive: true })
  const entryNames = await listDirectoryEntryNames(fromDir)
  for (const entryName of entryNames) {
    const sourcePath = path.join(fromDir, entryName)
    const targetPath = path.join(toDir, entryName)
    await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true })
  }
  return entryNames
}

async function moveDirectoryEntries(fromDir: string, toDir: string) {
  await fs.mkdir(toDir, { recursive: true })
  const entryNames = await listDirectoryEntryNames(fromDir)
  for (const entryName of entryNames) {
    await fs.rename(path.join(fromDir, entryName), path.join(toDir, entryName))
  }
  return entryNames
}

async function rollbackMovedEntries(fromDir: string, toDir: string, entryNames: string[]) {
  for (const entryName of entryNames.reverse()) {
    const sourcePath = path.join(fromDir, entryName)
    const targetPath = path.join(toDir, entryName)
    await fs.access(sourcePath).then(() => fs.rename(sourcePath, targetPath)).catch(() => undefined)
  }
}

function isRenameBlockedError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function swapRestoredMediaDirectory(
  app: Parameters<FastifyPluginAsync>[0],
  stagingMediaDir: string,
  previousMediaDir: string,
) {
  await fs.mkdir(path.dirname(app.config.mediaDir), { recursive: true })
  await fs.rm(previousMediaDir, { recursive: true, force: true }).catch(() => undefined)

  let currentExists = true
  try {
    await fs.access(app.config.mediaDir)
  } catch {
    currentExists = false
  }

  if (currentExists) {
    try {
      await fs.rename(app.config.mediaDir, previousMediaDir)
    } catch (error) {
      if (!isRenameBlockedError(error)) throw error

      const previousEntryNames = await copyDirectoryEntries(app.config.mediaDir, previousMediaDir)
      try {
        await copyDirectoryEntries(stagingMediaDir, app.config.mediaDir)
      } catch (moveError) {
        await fs.rm(app.config.mediaDir, { recursive: true, force: true }).catch(() => undefined)
        await fs.mkdir(app.config.mediaDir, { recursive: true })
        await rollbackMovedEntries(previousMediaDir, app.config.mediaDir, previousEntryNames)
        throw moveError
      }
      await fs.rm(previousMediaDir, { recursive: true, force: true }).catch(() => undefined)
      await fs.rm(stagingMediaDir, { recursive: true, force: true }).catch(() => undefined)
      return
    }
  }

  try {
    await fs.rename(stagingMediaDir, app.config.mediaDir)
  } catch (error) {
    if (currentExists) {
      await fs.rename(previousMediaDir, app.config.mediaDir).catch(() => undefined)
    }
    throw error
  }

  await fs.rm(previousMediaDir, { recursive: true, force: true }).catch(() => undefined)
}

async function restoreParsedBackupToServer(
  app: Parameters<FastifyPluginAsync>[0],
  reply: FastifyReply,
  currentSessionToken: string | null,
  parsed: ParsedAdminBackupImport,
) {
  const restoreWorkspaceDir = await fs.mkdtemp(path.join(app.config.dataDir, 'backup-restore-work-'))
  const stagingMediaDir = path.join(restoreWorkspaceDir, 'media-next')
  const previousMediaDir = path.join(restoreWorkspaceDir, 'media-prev')
  const totalFiles = Math.max(1, parsed.mediaStats.totalFiles)
  const totalBytes = parsed.mediaStats.totalBytes

  patchBackupJobState(app, {
    phase: 'running',
    message: '正在读取备份清单',
    progressPercent: getRestoreProgressPercent('reading'),
    totalFiles,
    processedFiles: 0,
    totalBytes,
    processedBytes: 0,
    filename: parsed.archivePath ? path.basename(parsed.archivePath) : '本地导入数据',
    filePath: parsed.archivePath,
    error: null,
  })

  try {
    await ensureRestoreMediaWorkspace(app, stagingMediaDir)

    patchBackupJobState(app, {
      message: '正在解压媒体文件',
      progressPercent: getRestoreProgressPercent('extracting', 0),
    })
    await parsed.restoreMediaToDir(stagingMediaDir, (progress) => {
      const ratioByFiles = progress.processedFiles / totalFiles
      const ratioByBytes = totalBytes > 0 ? progress.processedBytes / totalBytes : ratioByFiles
      patchBackupJobState(app, {
        message: progress.message ?? '正在解压媒体文件',
        progressPercent: getRestoreProgressPercent('extracting', Math.max(ratioByFiles, ratioByBytes)),
        totalFiles,
        processedFiles: progress.processedFiles,
        totalBytes,
        processedBytes: progress.processedBytes,
        filename: progress.currentFilePath ? path.basename(progress.currentFilePath) : null,
        filePath: progress.currentFilePath,
      })
    })

    patchBackupJobState(app, {
      message: '正在收尾切换',
      progressPercent: getRestoreProgressPercent('switching', 0),
      totalFiles,
      processedFiles: totalFiles,
      totalBytes,
      processedBytes: totalBytes,
    })
    await swapRestoredMediaDirectory(app, stagingMediaDir, previousMediaDir)
    patchBackupJobState(app, {
      message: '正在收尾切换',
      progressPercent: getRestoreProgressPercent('switching', 1),
    })

    patchBackupJobState(app, {
      message: '正在写入数据库',
      progressPercent: getRestoreProgressPercent('database', 0),
    })
    app.db.replaceFullBackup(parsed.payload)
    patchBackupJobState(app, {
      message: '正在写入数据库',
      progressPercent: getRestoreProgressPercent('database', 1),
      filename: null,
      filePath: null,
    })

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
    if (parsed.tempDir) {
      await fs.rm(parsed.tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
    await fs.rm(restoreWorkspaceDir, { recursive: true, force: true }).catch(() => undefined)
    for (const cleanupPath of parsed.cleanupPaths) {
      await fs.rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined)
    }
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
        videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
        videoMaxDuration: profile.videoMaxDuration,
        videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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
      videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
      videoMaxDuration: profile.videoMaxDuration,
      videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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
      veniceGenerateEnabled: payload.veniceGenerateEnabled,
      veniceEditEnabled: payload.veniceEditEnabled,
      veniceMultiEditEnabled: payload.veniceMultiEditEnabled,
      veniceSkipResolution: payload.veniceSkipResolution,
      videoMaxResolution: payload.videoMaxResolution,
      videoResolutionOptions: payload.videoResolutionOptions ?? [payload.videoMaxResolution],
      videoMaxDuration: payload.videoMaxDuration,
      videoDurationOptions: payload.videoDurationOptions ?? [payload.videoMaxDuration],
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
      videoResolutionOptions: profile.videoResolutionOptions ?? [profile.videoMaxResolution],
      videoMaxDuration: profile.videoMaxDuration,
      videoDurationOptions: profile.videoDurationOptions ?? [profile.videoMaxDuration],
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

  const remindersEnabled = true

  app.get('/api/reminders', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (!remindersEnabled) {
      reply.code(503)
      return { message: '提醒功能已临时关闭' }
    }
    reply.header('Cache-Control', 'no-store')
    return {
      items: filterReminderItemsForUser(getReminderItems(app), auth),
    }
  })

  app.get('/api/admin/reminders', async (request, reply) => {
    await requireAdmin(app, request, reply)
    if (!remindersEnabled) {
      reply.code(503)
      return { message: '提醒功能已临时关闭' }
    }
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
      remarkName: payload.remarkName,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: apiKey
        ? encryptText(apiKey, app.config.appSecret)
        : currentProfile?.apiKeyEncrypted ?? '',
      model: payload.model,
      modelOptions: payload.modelOptions ?? [payload.model],
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      veniceGenerateEnabled: payload.veniceGenerateEnabled,
      veniceEditEnabled: payload.veniceEditEnabled,
      veniceMultiEditEnabled: payload.veniceMultiEditEnabled,
      veniceSkipResolution: payload.veniceSkipResolution,
      videoMaxResolution: payload.videoMaxResolution,
      videoResolutionOptions: payload.videoResolutionOptions ?? [payload.videoMaxResolution],
      videoMaxDuration: payload.videoMaxDuration,
      videoDurationOptions: payload.videoDurationOptions ?? [payload.videoMaxDuration],
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
    const shouldSetDefault = existingProviderProfileIds.length === 0 || payload.isDefault
    const profile = app.db.upsertProviderProfile({
      id: payload.id ?? crypto.randomUUID(),
      name: payload.name,
      remarkName: payload.remarkName,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: encryptText(apiKey, app.config.appSecret),
      model: payload.model,
      modelOptions: payload.modelOptions ?? [payload.model],
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      veniceGenerateEnabled: payload.veniceGenerateEnabled,
      veniceEditEnabled: payload.veniceEditEnabled,
      veniceMultiEditEnabled: payload.veniceMultiEditEnabled,
      veniceSkipResolution: payload.veniceSkipResolution,
      videoMaxResolution: payload.videoMaxResolution,
      videoResolutionOptions: payload.videoResolutionOptions ?? [payload.videoMaxResolution],
      videoMaxDuration: payload.videoMaxDuration,
      videoDurationOptions: payload.videoDurationOptions ?? [payload.videoMaxDuration],
      isDefault: shouldSetDefault,
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
          message: `管理员新增 API 配置「${profile.remarkName ?? profile.name}」，该端点默认未授权，额度设为 0`,
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
      remarkName: payload.remarkName,
      baseUrl: payload.baseUrl,
      apiKeyEncrypted: apiKey
        ? encryptText(apiKey, app.config.appSecret)
        : currentProfile.apiKeyEncrypted,
      model: payload.model,
      modelOptions: payload.modelOptions ?? [payload.model],
      apiMode: payload.apiMode,
      timeoutSeconds: payload.timeoutSeconds,
      codexCli: payload.codexCli,
      grokApiCompat: payload.grokApiCompat,
      xaiImage2kEnabled: payload.xaiImage2kEnabled,
      responseFormatB64Json: payload.responseFormatB64Json,
      veniceGenerateEnabled: payload.veniceGenerateEnabled,
      veniceEditEnabled: payload.veniceEditEnabled,
      veniceMultiEditEnabled: payload.veniceMultiEditEnabled,
      veniceSkipResolution: payload.veniceSkipResolution,
      videoMaxResolution: payload.videoMaxResolution,
      videoResolutionOptions: payload.videoResolutionOptions ?? [payload.videoMaxResolution],
      videoMaxDuration: payload.videoMaxDuration,
      videoDurationOptions: payload.videoDurationOptions ?? [payload.videoMaxDuration],
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

  app.get('/api/admin/usage-codes/:codeId/events', async (request, reply) => {
    await requireAdmin(app, request, reply)
    const params = z.object({ codeId: z.string().min(1) }).parse(request.params)
    const query = usageCodeEventQuerySchema.parse(request.query)
    const usageCode = app.db.getUsageCode(params.codeId)
    if (!usageCode) {
      reply.code(404)
      return { message: '使用码不存在' }
    }
    const stats = app.db.listUsageCodesWithStats().find((item) => item.id === params.codeId)
    const result = queryUsageCodeEvents(app, {
      usageCodeId: params.codeId,
      page: query.page,
      pageSize: query.pageSize,
      timePreset: query.timePreset,
      startAt: query.startAt ?? null,
      endAt: query.endAt ?? null,
      bucket: query.bucket,
      eventCategories: Array.isArray(query.eventCategory) ? query.eventCategory : [query.eventCategory],
      taskId: query.taskId ?? null,
    })
    return {
      usageCode: {
        id: usageCode.id,
        name: usageCode.name,
        lastUsedAt: usageCode.lastUsedAt,
        totalEvents: result.pagination.total,
        taskCount: stats?.taskCount ?? 0,
      },
      ...result,
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
      userTier: payload.userTier,
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
        userTier: usageCode.userTier,
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
        artifactImageCount: 0,
        artifactVideoCount: 0,
        taskMediaBytes: 0,
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
      userTier: payload.userTier,
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
    if (payload.userTier !== undefined && payload.userTier !== current.userTier) {
      app.db.insertUsageCodeActivityLog({
        usageCodeId: params.codeId,
        actorKind: 'admin',
        eventType: 'usage_code_user_tier_changed',
        message: `管理员修改用户类型：${current.userTier === 'free' ? '免费用户' : '付费用户'} -> ${payload.userTier === 'free' ? '免费用户' : '付费用户'}`,
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
      items: await listBackupImportCandidates(app.config.backupsDir),
    }
  })

  app.post('/api/admin/data/import-from-server', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    return runImportRestoreJob(app, async () => {
      const payload = serverBackupImportSchema.parse(request.body)
      const archivePath = resolveBackupArchivePath(app, payload.archivePath)
      await fs.access(archivePath)
      const parsed = path.extname(archivePath).toLowerCase() === '.json'
        ? await parseSplitBackupIndexFile(app, archivePath)
        : await parseBackupArchiveFile(app, archivePath)
      const currentSessionToken = getSessionToken(request)
      const result = await restoreParsedBackupToServer(app, reply, currentSessionToken, parsed)
      return {
        ok: true,
        importedTasks: result.importedTasks,
        importedImages: result.importedImages,
        importedProviderProfiles: result.importedProviderProfiles,
        importedUsageCodes: result.importedUsageCodes,
      }
    })
  })

  app.post('/api/admin/data/import', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    return runImportRestoreJob(app, async () => {
      const parsed = await parseBackupImportPayload(app, request)
      const currentSessionToken = getSessionToken(request)
      return restoreParsedBackupToServer(app, reply, currentSessionToken, parsed)
    })
  })

  app.get('/api/admin/data/export/status', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    reply.header('Cache-Control', 'no-store')
    return getBackupJobState(app)
  })

  app.get('/api/admin/data/management-logs', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    reply.header('Cache-Control', 'no-store')
    return {
      items: listManagementOperationLogs(app, 20),
    }
  })

  app.get('/api/admin/data/media-stats', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    reply.header('Cache-Control', 'no-store')
    return app.db.summarizeMediaStats()
  })

  app.get('/api/admin/data/admin-task-cleanup-candidates', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    reply.header('Cache-Control', 'no-store')
    return {
      items: app.db.listAdminTaskCleanupCandidates(),
    }
  })

  app.post('/api/admin/data/export/start', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const current = getBackupJobState(app)
    if (current.active) {
      reply.code(409)
      return {
        message: getMaintenanceMessage(),
        state: current,
      }
    }

    backupExportRunner = runBackupExportJob(app)
      .catch((error) => {
        app.log.error(error, '服务器备份导出失败')
      })
      .finally(() => {
        backupExportRunner = null
      })

    reply.header('Cache-Control', 'no-store')
    return getBackupJobState(app)
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

  app.post('/api/user/data/export-media/start', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以导出自己的图片与视频' }
    }

    const globalState = getBackupJobState(app)
    if (globalState.active) {
      reply.code(409)
      return { message: '当前已有维护任务正在执行，请稍后再试' }
    }

    const downloadLock = getUsageCodeMediaDownloadLockState(auth.usageCodeIds)
    if (downloadLock?.activeCount) {
      reply.code(409)
      return { message: '当前导出文件仍在下载中，请稍后再试' }
    }

    const currentState = getUsageCodeMediaExportState(app, auth.usageCodeIds)
    if (currentState.active) {
      reply.header('Cache-Control', 'no-store')
      return currentState
    }

    const runnerKey = getUsageCodeMediaExportRunnerKey(auth.usageCodeIds)
    const runner = runUsageCodeMediaExportJob(app, auth.usageCodeIds)
      .catch((error) => {
        app.log.error({ err: error, usageCodeIds: auth.usageCodeIds }, '使用码产物导出任务失败')
      })
      .finally(() => {
        usageCodeMediaExportRunners.delete(runnerKey)
      })
    usageCodeMediaExportRunners.set(runnerKey, runner)
    appendUsageCodeActivityLogs(app, auth.usageCodeIds, 'media_export_started', '用户发起产物备份导出任务')

    reply.header('Cache-Control', 'no-store')
    return getUsageCodeMediaExportState(app, auth.usageCodeIds)
  })

  app.get('/api/user/data/export-media/files', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以查看自己的导出文件' }
    }

    const exportState = getUsageCodeMediaExportState(app, auth.usageCodeIds)
    if (exportState.phase !== 'completed' || !exportState.filePath) {
      return { items: [] }
    }

    const items = await readUsageCodeMediaExportArtifacts(app, auth.usageCodeIds)
    return { items }
  })

  app.delete('/api/user/data/export-media', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以删除自己的导出文件' }
    }

    const exportState = getUsageCodeMediaExportState(app, auth.usageCodeIds)
    if (exportState.active) {
      reply.code(409)
      return { message: '导出仍在进行中，暂时不能删除远端备份' }
    }
    if (getUsageCodeMediaDownloadLockState(auth.usageCodeIds)?.activeCount) {
      reply.code(409)
      return { message: '当前仍有分包下载请求正在进行，暂时不能删除远端备份' }
    }

    await removeUsageCodeMediaExportDir(app, auth.usageCodeIds)
    setUsageCodeMediaExportState(app, auth.usageCodeIds, getDefaultBackupJobState())
    appendUsageCodeActivityLogs(app, auth.usageCodeIds, 'media_export_deleted', '用户删除远端备份文件')
    reply.header('Cache-Control', 'no-store')
    return { ok: true }
  })

  app.get('/api/user/data/export-media/download/:fileName', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以下载自己的导出文件' }
    }

    const params = z.object({ fileName: z.string().min(1) }).parse(request.params)
    const items = await readUsageCodeMediaExportArtifacts(app, auth.usageCodeIds)
    const target = items.find((item) => item.fileName === params.fileName)
    if (!target) {
      reply.code(404)
      return { message: '导出文件不存在' }
    }

    const filePath = path.join(getUsageCodeMediaExportDir(app, auth.usageCodeIds), target.fileName)
    const downloadOwner = getUsageCodeMediaDownloadOwner(request)
    const lockResult = acquireUsageCodeMediaDownloadLock(auth.usageCodeIds, downloadOwner)
    if (!lockResult.ok) {
      reply.code(409)
      return { message: lockResult.message }
    }
    let released = false
    const releaseLock = () => {
      if (released) return
      released = true
      releaseUsageCodeMediaDownloadLock(auth.usageCodeIds, downloadOwner)
    }
    reply.raw.once('close', releaseLock)
    reply.raw.once('finish', releaseLock)

    appendUsageCodeActivityLogs(app, auth.usageCodeIds, 'media_download_started', `用户开始下载备份文件：${target.fileName}`)
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Length', String(target.bytes))
    reply.header('Content-Type', path.extname(target.fileName).toLowerCase() === '.json' ? 'application/json; charset=utf-8' : 'application/zip')
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(target.fileName)}"`)
    return reply.send(createReadStream(filePath))
  })

  app.post('/api/user/data/export-media/download-complete', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    if (auth.role !== 'user') {
      reply.code(403)
      return { message: '只有使用码用户可以记录自己的下载结果' }
    }

    const payload = usageCodeMediaExportDownloadCompleteSchema.parse(request.body)
    const items = await readUsageCodeMediaExportArtifacts(app, auth.usageCodeIds)
    const target = items.find((item) => item.fileName === payload.fileName)
    if (!target) {
      reply.code(404)
      return { message: '导出文件不存在' }
    }

    appendUsageCodeActivityLogs(app, auth.usageCodeIds, 'media_download_completed', `用户完成备份文件下载：${target.fileName}`)
    reply.header('Cache-Control', 'no-store')
    return { ok: true }
  })

  app.post('/api/admin/data/reset', async (request, reply) => {
    await requireAdmin(app, request, reply)
    requireLanForDataManagement(request, reply)
    const payload = resetRemoteDataSchema.parse(request.body)
    const currentState = getBackupJobState(app)
    if (currentState.active) {
      reply.code(409)
      return { message: '当前已有维护任务正在执行，请稍后再试' }
    }

    remoteResetRunner = runRemoteResetJob(app, payload.mode, payload.usageCodeIds, payload.taskIds).catch((error) => {
      app.log.error({
        err: error,
        mode: payload.mode,
        usageCodeIds: payload.usageCodeIds,
        taskIds: payload.taskIds,
      }, '远端清理任务失败')
    })
    reply.header('Cache-Control', 'no-store')
    return getBackupJobState(app)
  })
}
