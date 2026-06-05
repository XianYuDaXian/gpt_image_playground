import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { TaskEventRecord } from './eventBus.js'

export interface ProviderProfileRecord {
  id: string
  name: string
  remarkName: string | null
  tagColor: string | null
  baseUrl: string
  apiKeyEncrypted: string
  model: string
  modelOptions: string[] | null
  apiMode: 'images' | 'responses' | 'videos' | 'venice_images'
  timeoutSeconds: number
  codexCli: number
  grokApiCompat: number
  xaiImage2kEnabled: number
  responseFormatB64Json: number
  veniceGenerateEnabled: number
  veniceEditEnabled: number
  veniceMultiEditEnabled: number
  videoMaxResolution: '480p' | '720p'
  videoResolutionOptions?: Array<'480p' | '720p'>
  videoMaxDuration: 6 | 10 | 15
  videoDurationOptions?: Array<6 | 10 | 15>
  isDefault: number
  createdAt: string
  updatedAt: string
}

export interface TaskRecord {
  id: string
  prompt: string
  taskType: 'image' | 'video'
  status: string
  progressPercent: number
  currentStep: string
  paramsJson: string
  errorMessage: string | null
  providerProfileId: string | null
  upstreamRequestId: string | null
  upstreamUsageJson: string | null
  ownerUsageCodeId: string | null
  ownerKind: 'admin' | 'usage_code' | 'legacy'
  ownerLabel: string
  ownerUsageCodeCreatedAt: string | null
  ownerUsageCodeCodeEncrypted: string | null
  ownerUsageCodeLastUsedAt: string | null
  ownerUsageCodeImageQuota: number | null
  ownerUsageCodeUsedImageCredits: number | null
  ownerUsageCodeProviderImageQuotasJson: string | null
  ownerUsageCodeProviderUsedImageCreditsJson: string | null
  ownerUsageCodeVideoQuota: number | null
  ownerUsageCodeUsedVideoCredits: number | null
  ownerUsageCodeProviderVideoQuotasJson: string | null
  ownerUsageCodeProviderUsedVideoCreditsJson: string | null
  ownerUsageCodeTaskCount: number | null
  ownerUsageCodeOutputImageCount: number | null
  ownerUsageCodeProviderOutputImageCount: number | null
  ownerUsageCodeOutputVideoCount: number | null
  ownerUsageCodeProviderOutputVideoCount: number | null
  reservedImageCredits: number
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  isFavorite: number
  isArchived: number
}

export interface TaskListQueryInput {
  ownerUsageCodeIds?: string[]
  includeUsageCodeTasksForAdmin?: boolean
  status?: 'all' | 'running' | 'done' | 'error'
  taskType?: 'all' | 'image' | 'video'
  favorite?: boolean
  archived?: boolean
  limit: number
  offset: number
}

export interface TaskImageRecord {
  id: string
  taskId: string
  kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
  filePath: string
  mimeType: string
  width: number | null
  height: number | null
  bytes: number
  sha256: string
  metadataJson: string | null
  createdAt: string
}

export interface UsageCodeTaskMediaCleanupRecord {
  taskId: string
  ownerUsageCodeId: string | null
  ownerKind: 'admin' | 'usage_code' | 'legacy'
  kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output' | null
  filePath: string | null
  bytes: number | null
}

export interface UsageCodeRecord {
  id: string
  name: string
  codeHash: string
  codeEncrypted: string | null
  userTier: UsageCodeUserTier
  allowedProviderProfileIds: string[] | null
  isEnabled: number
  imageQuota: number | null
  providerImageQuotas: Record<string, number> | null
  usedImageCredits: number
  providerUsedImageCredits: Record<string, number> | null
  videoQuota: number | null
  providerVideoQuotas: Record<string, number> | null
  usedVideoCredits: number
  providerUsedVideoCredits: Record<string, number> | null
  outputImageCount: number
  outputVideoCount: number
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface UsageCodeStatsRecord extends UsageCodeRecord {
  taskCount: number
  outputImageCount: number
  outputVideoCount: number
  quotaEvents?: UsageQuotaEventRecord[]
}

export interface UsageQuotaEventRecord {
  id: number
  usageCodeId: string
  taskId: string | null
  eventType: string
  credits: number
  reason: string | null
  providerProfileId: string | null
  providerProfileName: string | null
  providerProfileTagColor: string | null
  providerProfileApiMode: 'images' | 'responses' | 'videos' | 'venice_images' | null
  createdAt: string
}

export interface UsageCodeActivityRecord {
  id: number
  usageCodeId: string
  taskId: string | null
  actorKind: 'admin' | 'user' | 'system'
  eventType: string
  message: string
  createdAt: string
}

export interface UsageCodeEventQueryInput {
  usageCodeId: string
  startAt?: string | null
  endAt?: string | null
  taskId?: string | null
}

export type UsageCodeUserTier = 'free' | 'paid'

export interface AppSettingRecord {
  key: string
  valueJson: string
  updatedAt: string
}

export interface TaskEventRowRecord {
  id: number
  taskId: string
  status: string
  step: string
  percent: number
  message: string | null
  createdAt: string
}

export interface MediaStatsRecord {
  imageCount: number
  videoCount: number
  totalBytes: number
}

export interface UsageQuotaEventRowRecord {
  id: number
  usageCodeId: string
  taskId: string | null
  eventType: string
  credits: number
  reason: string | null
  providerProfileId: string | null
  createdAt: string
}

export interface UsageCodeRawRecord extends UsageCodeRecord {
  codeEncrypted: string | null
}

export interface AuthSessionRecord {
  id: string
  tokenHash: string
  role: 'admin' | 'user'
  usageCodeId: string | null
  expiresAt: string
  createdAt: string
  lastSeenAt: string
}

export interface AuthSessionUsageCodeRecord extends UsageCodeRecord {
  sessionUsageCreatedAt: string
}

export interface DistributionSettings {
  enabled: boolean
  maxConcurrentTasks: number
}

function parseAllowedProviderProfileIds(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return null
    const ids = parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
    return ids.length ? Array.from(new Set(ids)) : null
  } catch {
    return null
  }
}

function stringifyAllowedProviderProfileIds(value: string[] | null | undefined) {
  if (!value?.length) return null
  const ids = value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
  return ids.length ? JSON.stringify(Array.from(new Set(ids))) : null
}

function parseProviderImageQuotaMap(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entries = Object.entries(parsed)
      .map(([key, rawValue]) => {
        const id = String(key ?? '').trim()
        const amount = Number(rawValue)
        if (!id || !Number.isInteger(amount) || amount < 0) return null
        return [id, amount] as const
      })
      .filter((item): item is readonly [string, number] => Boolean(item))
    if (!entries.length) return null
    return Object.fromEntries(entries)
  } catch {
    return null
  }
}

function stringifyProviderImageQuotaMap(value: Record<string, number> | null | undefined) {
  if (!value) return null
  const entries = Object.entries(value)
    .map(([key, rawValue]) => {
      const id = String(key ?? '').trim()
      const amount = Number(rawValue)
      if (!id || !Number.isInteger(amount) || amount < 0) return null
      return [id, amount] as const
    })
    .filter((item): item is readonly [string, number] => Boolean(item))
  if (!entries.length) return null
  return JSON.stringify(Object.fromEntries(entries))
}

function parseProviderModelOptions(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return null
    const items = parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
    return items.length ? Array.from(new Set(items)) : null
  } catch {
    return null
  }
}

function normalizeVideoResolutionOptions(value: ReadonlyArray<string> | null | undefined): Array<'480p' | '720p'> {
  const items = Array.from(new Set(
    (value ?? [])
      .map((item) => item === '720p' ? '720p' : item === '480p' ? '480p' : null)
      .filter((item): item is '480p' | '720p' => item !== null),
  ))
  if (!items.length) return ['480p']
  const sortedOptions: Array<'480p' | '720p'> = ['480p', '720p']
  return sortedOptions.filter((item) => items.includes(item))
}

function parseVideoResolutionOptions(
  value: string | null | undefined,
  fallbackMaxResolution?: string | null,
): Array<'480p' | '720p'> {
  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) return normalizeVideoResolutionOptions(parsed.map((item) => String(item)))
    } catch {
    }
  }
  if (fallbackMaxResolution === '720p') return ['480p', '720p']
  return ['480p']
}

function normalizeVideoDurationOptions(value: ReadonlyArray<number> | null | undefined): Array<6 | 10 | 15> {
  const items = Array.from(new Set(
    (value ?? [])
      .map((item) => item === 15 ? 15 : item === 10 ? 10 : item === 6 ? 6 : null)
      .filter((item): item is 6 | 10 | 15 => item !== null),
  ))
  if (!items.length) return [6]
  const sortedOptions: Array<6 | 10 | 15> = [6, 10, 15]
  return sortedOptions.filter((item) => items.includes(item))
}

function parseVideoDurationOptions(
  value: string | null | undefined,
  fallbackMaxDuration?: number | null,
): Array<6 | 10 | 15> {
  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) return normalizeVideoDurationOptions(parsed.map((item) => Number(item)))
    } catch {
    }
  }
  if (fallbackMaxDuration === 15) return [6, 10, 15]
  if (fallbackMaxDuration === 10) return [6, 10]
  return [6]
}

function quotaMapsEqual(
  left: Record<string, number> | null | undefined,
  right: Record<string, number> | null | undefined,
) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value], index) => {
    const [rightKey, rightValue] = rightEntries[index] ?? []
    return key === rightKey && value === rightValue
  })
}

function sumQuotaMap(value: Record<string, number> | null | undefined) {
  return Object.values(value ?? {}).reduce((sum, quota) => sum + quota, 0)
}

function normalizeUsageCodeUserTier(value: string | null | undefined): UsageCodeUserTier {
  return value === 'free' ? 'free' : 'paid'
}

function inferUsageCodeUserTier(input: {
  imageQuota?: number | null
  providerImageQuotas?: Record<string, number> | null
  videoQuota?: number | null
  providerVideoQuotas?: Record<string, number> | null
}): UsageCodeUserTier {
  const imageTotal = input.imageQuota ?? sumQuotaMap(input.providerImageQuotas)
  const videoTotal = input.videoQuota ?? sumQuotaMap(input.providerVideoQuotas)
  return imageTotal === 2 && videoTotal === 1 ? 'free' : 'paid'
}

const PROVIDER_TAG_COLORS = [
  'rose',
  'orange',
  'amber',
  'lime',
  'emerald',
  'cyan',
  'sky',
  'blue',
  'violet',
  'fuchsia',
] as const

type ProviderTagColor = (typeof PROVIDER_TAG_COLORS)[number]

function isProviderTagColor(value: string | null | undefined): value is ProviderTagColor {
  return PROVIDER_TAG_COLORS.includes(value as ProviderTagColor)
}

function selectUsageCodeFields() {
  return `
          id,
          code_hash as codeHash,
          code_encrypted as codeEncrypted,
          name,
          user_tier as userTier,
          allowed_provider_profile_ids_json as allowedProviderProfileIdsJson,
          is_enabled as isEnabled,
          image_quota as imageQuota,
          provider_image_quotas_json as providerImageQuotasJson,
          used_image_credits as usedImageCredits,
          provider_used_image_credits_json as providerUsedImageCreditsJson,
          video_quota as videoQuota,
          provider_video_quotas_json as providerVideoQuotasJson,
          used_video_credits as usedVideoCredits,
          provider_used_video_credits_json as providerUsedVideoCreditsJson,
          output_image_count as outputImageCount,
          output_video_count as outputVideoCount,
          created_at as createdAt,
          updated_at as updatedAt,
          last_used_at as lastUsedAt
  `
}

function normalizeUsageCodeRow<T extends {
  allowedProviderProfileIdsJson: string | null
  providerImageQuotasJson: string | null
  providerUsedImageCreditsJson: string | null
  providerVideoQuotasJson: string | null
  providerUsedVideoCreditsJson: string | null
}>(row: T) {
  return {
    ...row,
    userTier: normalizeUsageCodeUserTier((row as T & { userTier?: string | null }).userTier),
    allowedProviderProfileIds: parseAllowedProviderProfileIds(row.allowedProviderProfileIdsJson),
    providerImageQuotas: parseProviderImageQuotaMap(row.providerImageQuotasJson),
    providerUsedImageCredits: parseProviderImageQuotaMap(row.providerUsedImageCreditsJson),
    providerVideoQuotas: parseProviderImageQuotaMap(row.providerVideoQuotasJson),
    providerUsedVideoCredits: parseProviderImageQuotaMap(row.providerUsedVideoCreditsJson),
  }
}

export interface TaskImageAccessRecord extends TaskImageRecord {
  ownerUsageCodeId: string | null
  ownerKind: 'admin' | 'usage_code' | 'legacy'
}

export class AppDatabase {
  readonly sqlite: Database.Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.sqlite = new Database(dbPath)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        remark_name TEXT,
        tag_color TEXT,
        base_url TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        model TEXT NOT NULL,
        model_options_json TEXT,
        api_mode TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        codex_cli INTEGER NOT NULL DEFAULT 0,
        grok_api_compat INTEGER NOT NULL DEFAULT 0,
        xai_image_2k_enabled INTEGER NOT NULL DEFAULT 0,
        response_format_b64_json INTEGER NOT NULL DEFAULT 0,
        venice_generate_enabled INTEGER NOT NULL DEFAULT 1,
        venice_edit_enabled INTEGER NOT NULL DEFAULT 1,
        venice_multi_edit_enabled INTEGER NOT NULL DEFAULT 1,
        video_max_resolution TEXT NOT NULL DEFAULT '480p',
        video_resolution_options_json TEXT,
        video_max_duration INTEGER NOT NULL DEFAULT 6,
        video_duration_options_json TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_profiles_default
      ON provider_profiles(is_default) WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'image',
        status TEXT NOT NULL,
        progress_percent INTEGER NOT NULL,
        current_step TEXT NOT NULL,
        params_json TEXT NOT NULL,
        error_message TEXT,
        provider_profile_id TEXT,
        upstream_request_id TEXT,
        upstream_usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(provider_profile_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS task_images (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        step TEXT NOT NULL,
        percent INTEGER NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        code_encrypted TEXT,
        name TEXT NOT NULL,
        user_tier TEXT NOT NULL DEFAULT 'paid',
        allowed_provider_profile_ids_json TEXT,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        image_quota INTEGER,
        provider_image_quotas_json TEXT,
        used_image_credits INTEGER NOT NULL DEFAULT 0,
        provider_used_image_credits_json TEXT,
        video_quota INTEGER,
        provider_video_quotas_json TEXT,
        used_video_credits INTEGER NOT NULL DEFAULT 0,
        provider_used_video_credits_json TEXT,
        output_image_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        usage_code_id TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
      FOREIGN KEY(usage_code_id) REFERENCES usage_codes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
      ON auth_sessions(token_hash);

      CREATE TABLE IF NOT EXISTS auth_session_usage_codes (
        session_id TEXT NOT NULL,
        usage_code_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, usage_code_id),
        FOREIGN KEY(session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(usage_code_id) REFERENCES usage_codes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_session_usage_codes_session
      ON auth_session_usage_codes(session_id);

      CREATE TABLE IF NOT EXISTS usage_quota_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usage_code_id TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        credits INTEGER NOT NULL,
        reason TEXT,
        provider_profile_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(usage_code_id) REFERENCES usage_codes(id) ON DELETE CASCADE,
        FOREIGN KEY(provider_profile_id) REFERENCES provider_profiles(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_quota_events_task_type
      ON usage_quota_events(task_id, event_type) WHERE task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS usage_code_activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usage_code_id TEXT NOT NULL,
        task_id TEXT,
        actor_kind TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(usage_code_id) REFERENCES usage_codes(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
      );
    `)

    this.sqlite.exec(`
      INSERT OR IGNORE INTO auth_session_usage_codes (session_id, usage_code_id, created_at)
      SELECT id, usage_code_id, created_at
      FROM auth_sessions
      WHERE role = 'user' AND usage_code_id IS NOT NULL;
    `)

    const taskColumns = this.sqlite.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    const taskColumnNames = new Set(taskColumns.map((column) => column.name))
    if (!taskColumnNames.has('is_favorite')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0')
    }
    if (!taskColumnNames.has('is_archived')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0')
    }
    if (!taskColumnNames.has('task_type')) {
      this.sqlite.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'image'")
    }
    if (!taskColumnNames.has('upstream_request_id')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN upstream_request_id TEXT')
    }
    if (!taskColumnNames.has('upstream_usage_json')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN upstream_usage_json TEXT')
    }
    if (!taskColumnNames.has('owner_usage_code_id')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN owner_usage_code_id TEXT')
    }
    if (!taskColumnNames.has('owner_kind')) {
      this.sqlite.exec("ALTER TABLE tasks ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'legacy'")
    }
    if (!taskColumnNames.has('reserved_image_credits')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN reserved_image_credits INTEGER NOT NULL DEFAULT 0')
    }
    const profileColumns = this.sqlite.prepare('PRAGMA table_info(provider_profiles)').all() as Array<{ name: string }>
    const profileColumnNames = new Set(profileColumns.map((column) => column.name))
    if (!profileColumnNames.has('codex_cli')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN codex_cli INTEGER NOT NULL DEFAULT 0')
    }
    if (!profileColumnNames.has('grok_api_compat')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN grok_api_compat INTEGER NOT NULL DEFAULT 0')
    }
    if (!profileColumnNames.has('response_format_b64_json')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN response_format_b64_json INTEGER NOT NULL DEFAULT 0')
    }
    if (!profileColumnNames.has('xai_image_2k_enabled')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN xai_image_2k_enabled INTEGER NOT NULL DEFAULT 0')
    }
    if (!profileColumnNames.has('venice_generate_enabled')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN venice_generate_enabled INTEGER NOT NULL DEFAULT 1')
    }
    if (!profileColumnNames.has('venice_edit_enabled')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN venice_edit_enabled INTEGER NOT NULL DEFAULT 1')
    }
    if (!profileColumnNames.has('venice_multi_edit_enabled')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN venice_multi_edit_enabled INTEGER NOT NULL DEFAULT 1')
    }
    if (!profileColumnNames.has('video_max_resolution')) {
      this.sqlite.exec("ALTER TABLE provider_profiles ADD COLUMN video_max_resolution TEXT NOT NULL DEFAULT '480p'")
    }
    if (!profileColumnNames.has('video_resolution_options_json')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN video_resolution_options_json TEXT')
      this.sqlite.exec(`
        UPDATE provider_profiles
        SET video_resolution_options_json = CASE
          WHEN video_max_resolution = '720p' THEN '["480p","720p"]'
          ELSE '["480p"]'
        END
      `)
    }
    if (!profileColumnNames.has('video_max_duration')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN video_max_duration INTEGER NOT NULL DEFAULT 6')
    }
    if (!profileColumnNames.has('video_duration_options_json')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN video_duration_options_json TEXT')
      this.sqlite.exec(`
        UPDATE provider_profiles
        SET video_duration_options_json = CASE
          WHEN video_max_duration >= 15 THEN '[6,10,15]'
          WHEN video_max_duration >= 10 THEN '[6,10]'
          ELSE '[6]'
        END
      `)
    }
    if (!profileColumnNames.has('tag_color')) {
      this.sqlite.exec("ALTER TABLE provider_profiles ADD COLUMN tag_color TEXT")
    }
    if (!profileColumnNames.has('remark_name')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN remark_name TEXT')
    }
    if (!profileColumnNames.has('model_options_json')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN model_options_json TEXT')
      this.sqlite.exec(`
        UPDATE provider_profiles
        SET model_options_json = json_array(model)
        WHERE COALESCE(model, '') <> ''
      `)
    }
    this.assignMissingProviderTagColors()
    const usageCodeColumns = this.sqlite.prepare('PRAGMA table_info(usage_codes)').all() as Array<{ name: string }>
    const usageCodeColumnNames = new Set(usageCodeColumns.map((column) => column.name))
    if (!usageCodeColumnNames.has('code_encrypted')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN code_encrypted TEXT')
    }
    if (!usageCodeColumnNames.has('user_tier')) {
      this.sqlite.exec("ALTER TABLE usage_codes ADD COLUMN user_tier TEXT NOT NULL DEFAULT 'paid'")
      const rows = this.sqlite.prepare(`
        SELECT
          id,
          image_quota as imageQuota,
          provider_image_quotas_json as providerImageQuotasJson,
          video_quota as videoQuota,
          provider_video_quotas_json as providerVideoQuotasJson
        FROM usage_codes
      `).all() as Array<{
        id: string
        imageQuota: number | null
        providerImageQuotasJson: string | null
        videoQuota: number | null
        providerVideoQuotasJson: string | null
      }>
      const updateTier = this.sqlite.prepare('UPDATE usage_codes SET user_tier = ? WHERE id = ?')
      const tx = this.sqlite.transaction(() => {
        for (const row of rows) {
          updateTier.run(inferUsageCodeUserTier({
            imageQuota: row.imageQuota,
            providerImageQuotas: parseProviderImageQuotaMap(row.providerImageQuotasJson),
            videoQuota: row.videoQuota,
            providerVideoQuotas: parseProviderImageQuotaMap(row.providerVideoQuotasJson),
          }), row.id)
        }
      })
      tx()
    } else {
      this.sqlite.exec("UPDATE usage_codes SET user_tier = 'paid' WHERE user_tier NOT IN ('free', 'paid')")
    }
    if (!usageCodeColumnNames.has('allowed_provider_profile_ids_json')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN allowed_provider_profile_ids_json TEXT')
    }
    if (!usageCodeColumnNames.has('provider_image_quotas_json')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN provider_image_quotas_json TEXT')
    }
    if (!usageCodeColumnNames.has('provider_used_image_credits_json')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN provider_used_image_credits_json TEXT')
    }
    if (!usageCodeColumnNames.has('output_image_count')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN output_image_count INTEGER NOT NULL DEFAULT 0')
      this.sqlite.exec(`
        UPDATE usage_codes
        SET output_image_count = COALESCE((
          SELECT COUNT(task_images.id)
          FROM tasks owner_tasks
          INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'output'
          WHERE owner_tasks.owner_usage_code_id = usage_codes.id
        ), 0)
      `)
    }
    if (!usageCodeColumnNames.has('video_quota')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN video_quota INTEGER')
    }
    if (!usageCodeColumnNames.has('provider_video_quotas_json')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN provider_video_quotas_json TEXT')
    }
    if (!usageCodeColumnNames.has('used_video_credits')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN used_video_credits INTEGER NOT NULL DEFAULT 0')
    }
    if (!usageCodeColumnNames.has('provider_used_video_credits_json')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN provider_used_video_credits_json TEXT')
    }
    if (!usageCodeColumnNames.has('output_video_count')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN output_video_count INTEGER NOT NULL DEFAULT 0')
      this.sqlite.exec(`
        UPDATE usage_codes
        SET output_video_count = COALESCE((
          SELECT COUNT(task_images.id)
          FROM tasks owner_tasks
          INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'video_output'
          WHERE owner_tasks.owner_usage_code_id = usage_codes.id
        ), 0)
      `)
    }
    this.sqlite.exec(`
      UPDATE usage_codes
      SET output_video_count = MAX(
        output_video_count,
        COALESCE((
          SELECT COUNT(*)
          FROM usage_code_activity_logs
          WHERE usage_code_activity_logs.usage_code_id = usage_codes.id
            AND usage_code_activity_logs.event_type = 'video_task_succeeded'
        ), 0),
        COALESCE((
          SELECT COUNT(task_images.id)
          FROM tasks owner_tasks
          INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'video_output'
          WHERE owner_tasks.owner_usage_code_id = usage_codes.id
        ), 0)
      )
    `)
    const taskImageColumns = this.sqlite.prepare('PRAGMA table_info(task_images)').all() as Array<{ name: string }>
    const taskImageColumnNames = new Set(taskImageColumns.map((column) => column.name))
    if (!taskImageColumnNames.has('metadata_json')) {
      this.sqlite.exec('ALTER TABLE task_images ADD COLUMN metadata_json TEXT')
    }
    const usageQuotaEventColumns = this.sqlite.prepare('PRAGMA table_info(usage_quota_events)').all() as Array<{ name: string }>
    const usageQuotaEventColumnNames = new Set(usageQuotaEventColumns.map((column) => column.name))
    if (!usageQuotaEventColumnNames.has('provider_profile_id')) {
      this.sqlite.exec('ALTER TABLE usage_quota_events ADD COLUMN provider_profile_id TEXT')
    }

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_created_at
      ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_owner_kind_created_at
      ON tasks(owner_kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_owner_usage_code_created_at
      ON tasks(owner_usage_code_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created_at
      ON tasks(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_images_task_id
      ON task_images(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_images_task_id_kind
      ON task_images(task_id, kind);
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id_created_at
      ON task_events(task_id, created_at ASC);
    `)
  }

  private assignMissingProviderTagColors() {
    const rows = this.sqlite.prepare(`
      SELECT id, tag_color as tagColor
      FROM provider_profiles
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string; tagColor: string | null }>
    if (!rows.length) return
    const usedCounts = new Map<ProviderTagColor, number>()
    for (const color of PROVIDER_TAG_COLORS) {
      usedCounts.set(color, 0)
    }
    for (const row of rows) {
      if (!isProviderTagColor(row.tagColor)) continue
      usedCounts.set(row.tagColor, (usedCounts.get(row.tagColor) ?? 0) + 1)
    }
    const update = this.sqlite.prepare(`
      UPDATE provider_profiles
      SET tag_color = ?, updated_at = ?
      WHERE id = ?
    `)
    const now = new Date().toISOString()
    for (const row of rows) {
      if (isProviderTagColor(row.tagColor)) continue
      const minCount = Math.min(...PROVIDER_TAG_COLORS.map((color) => usedCounts.get(color) ?? 0))
      const candidates = PROVIDER_TAG_COLORS.filter((color) => (usedCounts.get(color) ?? 0) === minCount)
      const color = candidates[crypto.randomInt(candidates.length)] ?? PROVIDER_TAG_COLORS[0]
      update.run(color, now, row.id)
      usedCounts.set(color, (usedCounts.get(color) ?? 0) + 1)
    }
  }

  private resolveProviderTagColor(inputColor: string | null | undefined, providerProfileId: string) {
    if (isProviderTagColor(inputColor)) return inputColor
    const current = this.sqlite.prepare(`
      SELECT tag_color as tagColor
      FROM provider_profiles
      WHERE id = ?
      LIMIT 1
    `).get(providerProfileId) as { tagColor: string | null } | undefined
    if (isProviderTagColor(current?.tagColor)) return current.tagColor
    const rows = this.sqlite.prepare(`
      SELECT tag_color as tagColor
      FROM provider_profiles
      WHERE id <> ?
    `).all(providerProfileId) as Array<{ tagColor: string | null }>
    const usedCounts = new Map<ProviderTagColor, number>()
    for (const color of PROVIDER_TAG_COLORS) {
      usedCounts.set(color, 0)
    }
    for (const row of rows) {
      if (!isProviderTagColor(row.tagColor)) continue
      usedCounts.set(row.tagColor, (usedCounts.get(row.tagColor) ?? 0) + 1)
    }
    const minCount = Math.min(...PROVIDER_TAG_COLORS.map((color) => usedCounts.get(color) ?? 0))
    const candidates = PROVIDER_TAG_COLORS.filter((color) => (usedCounts.get(color) ?? 0) === minCount)
    return candidates[crypto.randomInt(candidates.length)] ?? PROVIDER_TAG_COLORS[0]
  }

  listProviderProfiles() {
    const rows = this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          remark_name as remarkName,
          tag_color as tagColor,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          model_options_json as modelOptionsJson,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          venice_generate_enabled as veniceGenerateEnabled,
          venice_edit_enabled as veniceEditEnabled,
          venice_multi_edit_enabled as veniceMultiEditEnabled,
          CASE WHEN video_max_resolution = '720p' THEN '720p' ELSE '480p' END as videoMaxResolution,
          video_resolution_options_json as videoResolutionOptionsJson,
          CASE WHEN video_max_duration >= 15 THEN 15 WHEN video_max_duration >= 10 THEN 10 ELSE 6 END as videoMaxDuration,
          video_duration_options_json as videoDurationOptionsJson,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        ORDER BY is_default DESC, updated_at DESC
      `)
      .all() as Array<ProviderProfileRecord & { modelOptionsJson: string | null; videoResolutionOptionsJson: string | null; videoDurationOptionsJson: string | null }>
    return rows.map((row) => {
      const { modelOptionsJson, videoResolutionOptionsJson, videoDurationOptionsJson, ...rest } = row
      return {
        ...rest,
        modelOptions: parseProviderModelOptions(modelOptionsJson),
        videoResolutionOptions: parseVideoResolutionOptions(videoResolutionOptionsJson, rest.videoMaxResolution),
        videoDurationOptions: parseVideoDurationOptions(videoDurationOptionsJson, rest.videoMaxDuration),
      }
    })
  }

  getProviderProfile(id: string) {
    const row = this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          remark_name as remarkName,
          tag_color as tagColor,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          model_options_json as modelOptionsJson,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          venice_generate_enabled as veniceGenerateEnabled,
          venice_edit_enabled as veniceEditEnabled,
          venice_multi_edit_enabled as veniceMultiEditEnabled,
          CASE WHEN video_max_resolution = '720p' THEN '720p' ELSE '480p' END as videoMaxResolution,
          video_resolution_options_json as videoResolutionOptionsJson,
          CASE WHEN video_max_duration >= 15 THEN 15 WHEN video_max_duration >= 10 THEN 10 ELSE 6 END as videoMaxDuration,
          video_duration_options_json as videoDurationOptionsJson,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        WHERE id = ?
      `)
      .get(id) as (ProviderProfileRecord & { modelOptionsJson: string | null; videoResolutionOptionsJson: string | null; videoDurationOptionsJson: string | null }) | undefined
    if (!row) return undefined
    return {
      ...row,
      modelOptions: parseProviderModelOptions(row.modelOptionsJson),
      videoResolutionOptions: parseVideoResolutionOptions(row.videoResolutionOptionsJson, row.videoMaxResolution),
      videoDurationOptions: parseVideoDurationOptions(row.videoDurationOptionsJson, row.videoMaxDuration),
    }
  }

  getDefaultProviderProfile() {
    const row = this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          remark_name as remarkName,
          tag_color as tagColor,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          model_options_json as modelOptionsJson,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          venice_generate_enabled as veniceGenerateEnabled,
          venice_edit_enabled as veniceEditEnabled,
          venice_multi_edit_enabled as veniceMultiEditEnabled,
          CASE WHEN video_max_resolution = '720p' THEN '720p' ELSE '480p' END as videoMaxResolution,
          video_resolution_options_json as videoResolutionOptionsJson,
          CASE WHEN video_max_duration >= 15 THEN 15 WHEN video_max_duration >= 10 THEN 10 ELSE 6 END as videoMaxDuration,
          video_duration_options_json as videoDurationOptionsJson,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        WHERE is_default = 1
        LIMIT 1
      `)
      .get() as (ProviderProfileRecord & { modelOptionsJson: string | null; videoResolutionOptionsJson: string | null; videoDurationOptionsJson: string | null }) | undefined
    if (!row) return undefined
    return {
      ...row,
      modelOptions: parseProviderModelOptions(row.modelOptionsJson),
      videoResolutionOptions: parseVideoResolutionOptions(row.videoResolutionOptionsJson, row.videoMaxResolution),
      videoDurationOptions: parseVideoDurationOptions(row.videoDurationOptionsJson, row.videoMaxDuration),
    }
  }

  upsertProviderProfile(input: {
    id: string
    name: string
    remarkName?: string | null
    tagColor?: string | null
    baseUrl: string
    apiKeyEncrypted: string
    model: string
    modelOptions?: string[] | null
    apiMode: 'images' | 'responses' | 'videos' | 'venice_images'
    timeoutSeconds: number
    codexCli?: boolean
    grokApiCompat?: boolean
    xaiImage2kEnabled?: boolean
    responseFormatB64Json?: boolean
    veniceGenerateEnabled?: boolean
    veniceEditEnabled?: boolean
    veniceMultiEditEnabled?: boolean
    videoMaxResolution?: '480p' | '720p'
    videoResolutionOptions?: Array<'480p' | '720p'>
    videoMaxDuration?: 6 | 10 | 15
    videoDurationOptions?: Array<6 | 10 | 15>
    isDefault: boolean
  }) {
    const now = new Date().toISOString()
    const videoResolutionOptions = normalizeVideoResolutionOptions(input.videoResolutionOptions ?? [input.videoMaxResolution ?? '480p'])
    const videoMaxResolution = videoResolutionOptions[videoResolutionOptions.length - 1] ?? '480p'
    const videoDurationOptions = normalizeVideoDurationOptions(input.videoDurationOptions ?? [input.videoMaxDuration ?? 6])
    const videoMaxDuration = videoDurationOptions[videoDurationOptions.length - 1] ?? 6
    const tx = this.sqlite.transaction(() => {
      if (input.isDefault) {
        this.sqlite.prepare('UPDATE provider_profiles SET is_default = 0').run()
      }

      this.sqlite.prepare(`
        INSERT INTO provider_profiles (
          id,
          name,
          remark_name,
          tag_color,
          base_url,
          api_key_encrypted,
          model,
          model_options_json,
          api_mode,
          timeout_seconds,
          codex_cli,
          grok_api_compat,
          xai_image_2k_enabled,
          response_format_b64_json,
          venice_generate_enabled,
          venice_edit_enabled,
          venice_multi_edit_enabled,
          video_max_resolution,
          video_resolution_options_json,
          video_max_duration,
          video_duration_options_json,
          is_default,
          created_at,
          updated_at
        )
        VALUES (
          @id,
          @name,
          @remarkName,
          @tagColor,
          @baseUrl,
          @apiKeyEncrypted,
          @model,
          @modelOptionsJson,
          @apiMode,
          @timeoutSeconds,
          @codexCli,
          @grokApiCompat,
          @xaiImage2kEnabled,
          @responseFormatB64Json,
          @veniceGenerateEnabled,
          @veniceEditEnabled,
          @veniceMultiEditEnabled,
          @videoMaxResolution,
          @videoResolutionOptionsJson,
          @videoMaxDuration,
          @videoDurationOptionsJson,
          @isDefault,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          remark_name = excluded.remark_name,
          tag_color = excluded.tag_color,
          base_url = excluded.base_url,
          api_key_encrypted = excluded.api_key_encrypted,
          model = excluded.model,
          model_options_json = excluded.model_options_json,
          api_mode = excluded.api_mode,
          timeout_seconds = excluded.timeout_seconds,
          codex_cli = excluded.codex_cli,
          grok_api_compat = excluded.grok_api_compat,
          xai_image_2k_enabled = excluded.xai_image_2k_enabled,
          response_format_b64_json = excluded.response_format_b64_json,
          venice_generate_enabled = excluded.venice_generate_enabled,
          venice_edit_enabled = excluded.venice_edit_enabled,
          venice_multi_edit_enabled = excluded.venice_multi_edit_enabled,
          video_max_resolution = excluded.video_max_resolution,
          video_resolution_options_json = excluded.video_resolution_options_json,
          video_max_duration = excluded.video_max_duration,
          video_duration_options_json = excluded.video_duration_options_json,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `).run({
        ...input,
        remarkName: input.remarkName?.trim() || null,
        tagColor: this.resolveProviderTagColor(input.tagColor, input.id),
        modelOptionsJson: JSON.stringify(
          Array.from(new Set(
            [input.model, ...(input.modelOptions ?? [])]
              .map((item) => String(item ?? '').trim())
              .filter(Boolean),
          )),
        ),
        codexCli: input.codexCli ? 1 : 0,
        grokApiCompat: input.grokApiCompat ? 1 : 0,
        xaiImage2kEnabled: input.xaiImage2kEnabled ? 1 : 0,
        responseFormatB64Json: input.responseFormatB64Json ? 1 : 0,
        veniceGenerateEnabled: input.veniceGenerateEnabled === false ? 0 : 1,
        veniceEditEnabled: input.veniceEditEnabled === false ? 0 : 1,
        veniceMultiEditEnabled: input.veniceMultiEditEnabled === false ? 0 : 1,
        videoMaxResolution,
        videoResolutionOptionsJson: JSON.stringify(videoResolutionOptions),
        videoMaxDuration,
        videoDurationOptionsJson: JSON.stringify(videoDurationOptions),
        isDefault: input.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
    })

    tx()
    return this.getProviderProfile(input.id)
  }

  deleteProviderProfile(id: string) {
    const profile = this.getProviderProfile(id)
    if (!profile) return false
    const count = this.sqlite.prepare('SELECT COUNT(*) as count FROM provider_profiles').get() as { count: number }
    if (count.count <= 1) {
      throw new Error('至少需要保留一个 API 配置')
    }
    this.sqlite.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id)
    if (profile.isDefault) {
      this.sqlite.prepare(`
        UPDATE provider_profiles
        SET is_default = 1, updated_at = ?
        WHERE id = (
          SELECT id FROM provider_profiles
          ORDER BY updated_at DESC
          LIMIT 1
        )
      `).run(new Date().toISOString())
    }
    return true
  }

  getAppSetting<T>(key: string) {
    const row = this.sqlite
      .prepare(`
        SELECT value_json as valueJson
        FROM app_settings
        WHERE key = ?
      `)
      .get(key) as { valueJson: string } | undefined

    if (!row) return null
    return JSON.parse(row.valueJson) as T
  }

  setAppSetting<T>(key: string, value: T) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
      updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now)
  }

  listAppSettings() {
    return this.sqlite
      .prepare(`
        SELECT
          key,
          value_json as valueJson,
          updated_at as updatedAt
        FROM app_settings
        ORDER BY key ASC
      `)
      .all() as AppSettingRecord[]
  }

  getDistributionSettings(): DistributionSettings {
    const stored = this.getAppSetting<Partial<DistributionSettings>>('distribution')
    return {
      enabled: Boolean(stored?.enabled),
      maxConcurrentTasks: Math.max(1, Math.floor(Number(stored?.maxConcurrentTasks) || 2)),
    }
  }

  setDistributionSettings(value: DistributionSettings) {
    this.setAppSetting('distribution', {
      enabled: Boolean(value.enabled),
      maxConcurrentTasks: Math.max(1, Math.floor(Number(value.maxConcurrentTasks) || 2)),
    })
  }

  createUsageCode(input: {
    id: string
    codeHash: string
    codeEncrypted: string
    name: string
    userTier?: UsageCodeUserTier
    imageQuota: number | null
    videoQuota?: number | null
    allowedProviderProfileIds?: string[] | null
    providerImageQuotas?: Record<string, number> | null
    providerVideoQuotas?: Record<string, number> | null
  }) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO usage_codes (
        id,
        code_hash,
        code_encrypted,
        name,
        user_tier,
        allowed_provider_profile_ids_json,
        is_enabled,
        image_quota,
        provider_image_quotas_json,
        used_image_credits,
        provider_used_image_credits_json,
        video_quota,
        provider_video_quotas_json,
        used_video_credits,
        provider_used_video_credits_json,
        output_image_count,
        created_at,
        updated_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, NULL, ?, ?, 0, NULL, 0, ?, ?, NULL)
    `).run(
      input.id,
      input.codeHash,
      input.codeEncrypted,
      input.name,
      input.userTier ?? inferUsageCodeUserTier({
        imageQuota: input.imageQuota,
        providerImageQuotas: input.providerImageQuotas,
        videoQuota: input.videoQuota ?? null,
        providerVideoQuotas: input.providerVideoQuotas,
      }),
      stringifyAllowedProviderProfileIds(input.allowedProviderProfileIds),
      input.imageQuota,
      stringifyProviderImageQuotaMap(input.providerImageQuotas),
      input.videoQuota ?? null,
      stringifyProviderImageQuotaMap(input.providerVideoQuotas),
      now,
      now,
    )
    return this.getUsageCode(input.id)
  }

  getUsageCode(id: string) {
    const row = this.sqlite
      .prepare(`
        SELECT
${selectUsageCodeFields()}
        FROM usage_codes
        WHERE id = ?
      `)
      .get(id) as ({
        allowedProviderProfileIdsJson: string | null
        providerImageQuotasJson: string | null
        providerUsedImageCreditsJson: string | null
        providerVideoQuotasJson: string | null
        providerUsedVideoCreditsJson: string | null
      } & Omit<UsageCodeRecord, 'allowedProviderProfileIds' | 'providerImageQuotas' | 'providerUsedImageCredits' | 'providerVideoQuotas' | 'providerUsedVideoCredits'>) | undefined
    return row ? normalizeUsageCodeRow(row) : undefined
  }

  listUsageCodes() {
    const rows = this.sqlite
      .prepare(`
        SELECT
${selectUsageCodeFields()}
        FROM usage_codes
        ORDER BY created_at DESC
      `)
      .all() as Array<{
        allowedProviderProfileIdsJson: string | null
        providerImageQuotasJson: string | null
        providerUsedImageCreditsJson: string | null
        providerVideoQuotasJson: string | null
        providerUsedVideoCreditsJson: string | null
      } & Omit<UsageCodeRawRecord, 'allowedProviderProfileIds' | 'providerImageQuotas' | 'providerUsedImageCredits' | 'providerVideoQuotas' | 'providerUsedVideoCredits'>>
    return rows.map((row) => normalizeUsageCodeRow(row))
  }

  getUsageCodeByHash(codeHash: string) {
    const row = this.sqlite
      .prepare(`
        SELECT
${selectUsageCodeFields()}
        FROM usage_codes
        WHERE code_hash = ?
      `)
      .get(codeHash) as ({
        allowedProviderProfileIdsJson: string | null
        providerImageQuotasJson: string | null
        providerUsedImageCreditsJson: string | null
        providerVideoQuotasJson: string | null
        providerUsedVideoCreditsJson: string | null
      } & Omit<UsageCodeRecord, 'allowedProviderProfileIds' | 'providerImageQuotas' | 'providerUsedImageCredits' | 'providerVideoQuotas' | 'providerUsedVideoCredits'>) | undefined
    return row ? normalizeUsageCodeRow(row) : undefined
  }

  markUsageCodeUsed(id: string) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET last_used_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id)
  }

  updateUsageCode(input: {
    id: string
    name?: string
    userTier?: UsageCodeUserTier
    isEnabled?: boolean
    imageQuota?: number | null
    videoQuota?: number | null
    allowedProviderProfileIds?: string[] | null
    providerImageQuotas?: Record<string, number> | null
    providerVideoQuotas?: Record<string, number> | null
  }) {
    const current = this.getUsageCode(input.id)
    if (!current) return null
    const now = new Date().toISOString()
    const nextProviderImageQuotas = input.imageQuota !== undefined
      ? null
      : input.providerImageQuotas === undefined
        ? current.providerImageQuotas
        : input.providerImageQuotas
    const nextImageQuota = input.imageQuota !== undefined
      ? input.imageQuota
      : input.providerImageQuotas !== undefined
        ? null
        : current.imageQuota
    const nextProviderVideoQuotas = input.videoQuota !== undefined
      ? null
      : input.providerVideoQuotas === undefined
        ? current.providerVideoQuotas
        : input.providerVideoQuotas
    const nextVideoQuota = input.videoQuota !== undefined
      ? input.videoQuota
      : input.providerVideoQuotas !== undefined
        ? null
        : current.videoQuota
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET
        name = ?,
        user_tier = ?,
        allowed_provider_profile_ids_json = ?,
        is_enabled = ?,
        image_quota = ?,
        provider_image_quotas_json = ?,
        video_quota = ?,
        provider_video_quotas_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? current.name,
      input.userTier ?? current.userTier,
      input.allowedProviderProfileIds === undefined
        ? stringifyAllowedProviderProfileIds(current.allowedProviderProfileIds)
        : stringifyAllowedProviderProfileIds(input.allowedProviderProfileIds),
      input.isEnabled == null ? current.isEnabled : input.isEnabled ? 1 : 0,
      nextImageQuota,
      stringifyProviderImageQuotaMap(nextProviderImageQuotas),
      nextVideoQuota,
      stringifyProviderImageQuotaMap(nextProviderVideoQuotas),
      now,
      input.id,
    )
    if (
      input.imageQuota !== undefined
      && current.imageQuota != null
      && nextImageQuota != null
      && current.imageQuota !== nextImageQuota
    ) {
        this.insertUsageQuotaEvent({
          usageCodeId: input.id,
          eventType: nextImageQuota > current.imageQuota ? 'admin_increase' : 'admin_decrease',
          credits: Math.abs(nextImageQuota - current.imageQuota),
          reason: 'admin_adjust_total',
        createdAt: now,
      })
    }
    if (input.providerImageQuotas !== undefined && !quotaMapsEqual(current.providerImageQuotas, nextProviderImageQuotas)) {
      const changedProviderIds = Array.from(new Set([
        ...Object.keys(current.providerImageQuotas ?? {}),
        ...Object.keys(nextProviderImageQuotas ?? {}),
      ]))
      for (const providerProfileId of changedProviderIds) {
        const previousQuota = current.providerImageQuotas?.[providerProfileId] ?? 0
        const nextQuota = nextProviderImageQuotas?.[providerProfileId] ?? 0
        if (previousQuota === nextQuota) continue
        this.insertUsageQuotaEvent({
          usageCodeId: input.id,
          eventType: nextQuota > previousQuota ? 'admin_increase' : 'admin_decrease',
          credits: Math.abs(nextQuota - previousQuota),
          reason: 'admin_adjust_provider',
          providerProfileId,
          createdAt: now,
        })
      }
    }
    if (
      input.videoQuota !== undefined
      && current.videoQuota != null
      && nextVideoQuota != null
      && current.videoQuota !== nextVideoQuota
    ) {
        this.insertUsageQuotaEvent({
          usageCodeId: input.id,
          eventType: nextVideoQuota > current.videoQuota ? 'video_admin_increase' : 'video_admin_decrease',
          credits: Math.abs(nextVideoQuota - current.videoQuota),
          reason: 'admin_adjust_total',
        createdAt: now,
      })
    }
    if (input.providerVideoQuotas !== undefined && !quotaMapsEqual(current.providerVideoQuotas, nextProviderVideoQuotas)) {
      const changedProviderIds = Array.from(new Set([
        ...Object.keys(current.providerVideoQuotas ?? {}),
        ...Object.keys(nextProviderVideoQuotas ?? {}),
      ]))
      for (const providerProfileId of changedProviderIds) {
        const previousQuota = current.providerVideoQuotas?.[providerProfileId] ?? 0
        const nextQuota = nextProviderVideoQuotas?.[providerProfileId] ?? 0
        if (previousQuota === nextQuota) continue
        this.insertUsageQuotaEvent({
          usageCodeId: input.id,
          eventType: nextQuota > previousQuota ? 'video_admin_increase' : 'video_admin_decrease',
          credits: Math.abs(nextQuota - previousQuota),
          reason: 'admin_adjust_provider',
          providerProfileId,
          createdAt: now,
        })
      }
    }
    return this.getUsageCode(input.id)
  }

  restrictUsageCodeAccessForNewProvider(input: {
    providerProfileId: string
    existingProviderProfileIds: string[]
  }) {
    const nextAllowedProviderProfileIds = Array.from(
      new Set(
        input.existingProviderProfileIds
          .map((id) => String(id ?? '').trim())
          .filter((id) => Boolean(id) && id !== input.providerProfileId),
      ),
    )
    const now = new Date().toISOString()
    const codes = this.listUsageCodesWithStats()
    const tx = this.sqlite.transaction(() => {
      for (const code of codes) {
        if (code.allowedProviderProfileIds != null) continue
        this.sqlite.prepare(`
          UPDATE usage_codes
          SET allowed_provider_profile_ids_json = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          stringifyAllowedProviderProfileIds(nextAllowedProviderProfileIds),
          now,
          code.id,
        )
      }
    })
    tx()
  }

  appendProviderQuotaOverrideForUsageCodes(input: {
    providerProfileId: string
    apiMode: 'images' | 'responses' | 'videos' | 'venice_images'
  }) {
    const now = new Date().toISOString()
    const isVideoMode = input.apiMode === 'videos'
    const codes = this.listUsageCodesWithStats()
    const tx = this.sqlite.transaction(() => {
      for (const code of codes) {
        if (isVideoMode) {
          const nextProviderVideoQuotas = { ...(code.providerVideoQuotas ?? {}) }
          if (nextProviderVideoQuotas[input.providerProfileId] != null) continue
          nextProviderVideoQuotas[input.providerProfileId] = 0
          this.sqlite.prepare(`
            UPDATE usage_codes
            SET provider_video_quotas_json = ?,
                updated_at = ?
            WHERE id = ?
          `).run(
            stringifyProviderImageQuotaMap(nextProviderVideoQuotas),
            now,
            code.id,
          )
          continue
        }

        const nextProviderImageQuotas = { ...(code.providerImageQuotas ?? {}) }
        if (nextProviderImageQuotas[input.providerProfileId] != null) continue
        nextProviderImageQuotas[input.providerProfileId] = 0
        this.sqlite.prepare(`
          UPDATE usage_codes
          SET provider_image_quotas_json = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          stringifyProviderImageQuotaMap(nextProviderImageQuotas),
          now,
          code.id,
        )
      }
    })
    tx()
  }

  deleteUsageCode(id: string) {
    const current = this.getUsageCode(id)
    if (!current) return false
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        UPDATE auth_sessions
        SET usage_code_id = (
          SELECT usage_code_id
          FROM auth_session_usage_codes
          WHERE session_id = auth_sessions.id
            AND usage_code_id <> ?
          ORDER BY created_at ASC
          LIMIT 1
        )
        WHERE usage_code_id = ?
      `).run(id, id)
      this.sqlite.prepare('DELETE FROM auth_session_usage_codes WHERE usage_code_id = ?').run(id)
      this.sqlite.prepare("DELETE FROM auth_sessions WHERE role = 'user' AND usage_code_id IS NULL").run()
      this.sqlite.prepare(`
        UPDATE tasks
        SET owner_usage_code_id = NULL,
            owner_kind = 'usage_code',
            updated_at = ?
        WHERE owner_usage_code_id = ?
      `).run(new Date().toISOString(), id)
      this.sqlite.prepare('DELETE FROM usage_quota_events WHERE usage_code_id = ?').run(id)
      this.sqlite.prepare('DELETE FROM usage_code_activity_logs WHERE usage_code_id = ?').run(id)
      this.sqlite.prepare('DELETE FROM usage_codes WHERE id = ?').run(id)
    })
    tx()
    return true
  }

  listUsageCodesWithStats() {
    const rows = this.sqlite
      .prepare(`
        SELECT
          usage_codes.id,
          usage_codes.code_hash as codeHash,
          usage_codes.code_encrypted as codeEncrypted,
          usage_codes.name,
          usage_codes.user_tier as userTier,
          usage_codes.allowed_provider_profile_ids_json as allowedProviderProfileIdsJson,
          usage_codes.is_enabled as isEnabled,
          usage_codes.image_quota as imageQuota,
          usage_codes.provider_image_quotas_json as providerImageQuotasJson,
          usage_codes.used_image_credits as usedImageCredits,
          usage_codes.provider_used_image_credits_json as providerUsedImageCreditsJson,
          usage_codes.video_quota as videoQuota,
          usage_codes.provider_video_quotas_json as providerVideoQuotasJson,
          usage_codes.used_video_credits as usedVideoCredits,
          usage_codes.provider_used_video_credits_json as providerUsedVideoCreditsJson,
          usage_codes.output_image_count as outputImageCount,
          usage_codes.output_video_count as outputVideoCount,
          usage_codes.created_at as createdAt,
          usage_codes.updated_at as updatedAt,
          usage_codes.last_used_at as lastUsedAt,
          COUNT(DISTINCT tasks.id) as taskCount,
          usage_codes.output_image_count as currentOutputImageCount
        FROM usage_codes
        LEFT JOIN tasks ON tasks.owner_usage_code_id = usage_codes.id
        LEFT JOIN task_images ON task_images.task_id = tasks.id AND task_images.kind = 'output'
        GROUP BY usage_codes.id
        ORDER BY usage_codes.created_at DESC
      `)
      .all() as Array<{
        allowedProviderProfileIdsJson: string | null
        providerImageQuotasJson: string | null
        providerUsedImageCreditsJson: string | null
        providerVideoQuotasJson: string | null
        providerUsedVideoCreditsJson: string | null
        currentOutputImageCount: number
      } & Omit<UsageCodeStatsRecord, 'allowedProviderProfileIds' | 'providerImageQuotas' | 'providerUsedImageCredits' | 'providerVideoQuotas' | 'providerUsedVideoCredits'>>
    return rows.map((row) => normalizeUsageCodeRow(row))
  }

  listUsageQuotaEvents(usageCodeId: string, limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          usage_quota_events.id,
          usage_quota_events.usage_code_id as usageCodeId,
          usage_quota_events.task_id as taskId,
          usage_quota_events.event_type as eventType,
          usage_quota_events.credits,
          usage_quota_events.reason,
          usage_quota_events.provider_profile_id as providerProfileId,
          provider_profiles.name as providerProfileName,
          provider_profiles.tag_color as providerProfileTagColor,
          provider_profiles.api_mode as providerProfileApiMode,
          usage_quota_events.created_at as createdAt
        FROM usage_quota_events
        LEFT JOIN provider_profiles ON provider_profiles.id = usage_quota_events.provider_profile_id
        WHERE usage_quota_events.usage_code_id = ?
        ORDER BY usage_quota_events.id DESC
        LIMIT ?
      `)
      .all(usageCodeId, limit) as UsageQuotaEventRecord[]
  }

  listAllUsageQuotaEvents() {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          usage_code_id as usageCodeId,
          task_id as taskId,
          event_type as eventType,
          credits,
          reason,
          provider_profile_id as providerProfileId,
          created_at as createdAt
        FROM usage_quota_events
        ORDER BY id ASC
      `)
      .all() as UsageQuotaEventRowRecord[]
  }

  listUsageQuotaEventsForQuery(input: UsageCodeEventQueryInput) {
    const where: string[] = ['usage_quota_events.usage_code_id = ?']
    const params: Array<string> = [input.usageCodeId]

    if (input.startAt) {
      where.push('usage_quota_events.created_at >= ?')
      params.push(input.startAt)
    }
    if (input.endAt) {
      where.push('usage_quota_events.created_at < ?')
      params.push(input.endAt)
    }
    if (input.taskId) {
      where.push('usage_quota_events.task_id = ?')
      params.push(input.taskId)
    }

    return this.sqlite
      .prepare(`
        SELECT
          usage_quota_events.id,
          usage_quota_events.usage_code_id as usageCodeId,
          usage_quota_events.task_id as taskId,
          usage_quota_events.event_type as eventType,
          usage_quota_events.credits,
          usage_quota_events.reason,
          usage_quota_events.provider_profile_id as providerProfileId,
          provider_profiles.name as providerProfileName,
          provider_profiles.tag_color as providerProfileTagColor,
          provider_profiles.api_mode as providerProfileApiMode,
          usage_quota_events.created_at as createdAt
        FROM usage_quota_events
        LEFT JOIN provider_profiles ON provider_profiles.id = usage_quota_events.provider_profile_id
        WHERE ${where.join(' AND ')}
        ORDER BY usage_quota_events.id DESC
      `)
      .all(...params) as UsageQuotaEventRecord[]
  }

  listUsageCodeActivityLogs(usageCodeId: string, limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          usage_code_id as usageCodeId,
          task_id as taskId,
          actor_kind as actorKind,
          event_type as eventType,
          message,
          created_at as createdAt
        FROM usage_code_activity_logs
        WHERE usage_code_id = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(usageCodeId, limit) as UsageCodeActivityRecord[]
  }

  listAllUsageCodeActivityLogs() {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          usage_code_id as usageCodeId,
          task_id as taskId,
          actor_kind as actorKind,
          event_type as eventType,
          message,
          created_at as createdAt
        FROM usage_code_activity_logs
        ORDER BY id ASC
      `)
      .all() as UsageCodeActivityRecord[]
  }

  listUsageCodeActivityLogsForQuery(input: UsageCodeEventQueryInput) {
    const where: string[] = ['usage_code_activity_logs.usage_code_id = ?']
    const params: Array<string> = [input.usageCodeId]

    if (input.startAt) {
      where.push('usage_code_activity_logs.created_at >= ?')
      params.push(input.startAt)
    }
    if (input.endAt) {
      where.push('usage_code_activity_logs.created_at < ?')
      params.push(input.endAt)
    }
    if (input.taskId) {
      where.push('usage_code_activity_logs.task_id = ?')
      params.push(input.taskId)
    }

    return this.sqlite
      .prepare(`
        SELECT
          id,
          usage_code_id as usageCodeId,
          task_id as taskId,
          actor_kind as actorKind,
          event_type as eventType,
          message,
          created_at as createdAt
        FROM usage_code_activity_logs
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
      `)
      .all(...params) as UsageCodeActivityRecord[]
  }

  insertUsageCodeActivityLog(input: {
    usageCodeId: string
    taskId?: string | null
    actorKind: 'admin' | 'user' | 'system'
    eventType: string
    message: string
    createdAt?: string
  }) {
    this.sqlite.prepare(`
      INSERT INTO usage_code_activity_logs (
        usage_code_id,
        task_id,
        actor_kind,
        event_type,
        message,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.usageCodeId,
      input.taskId ?? null,
      input.actorKind,
      input.eventType,
      input.message,
      input.createdAt ?? new Date().toISOString(),
    )
  }

  createAuthSession(input: {
    id: string
    tokenHash: string
    role: 'admin' | 'user'
    usageCodeId: string | null
    expiresAt: string
  }) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO auth_sessions (
        id,
        token_hash,
        role,
        usage_code_id,
        expires_at,
        created_at,
        last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.tokenHash, input.role, input.usageCodeId, input.expiresAt, now, now)
    if (input.role === 'user' && input.usageCodeId) {
      this.addUsageCodeToAuthSession(input.id, input.usageCodeId)
    }
    return this.getAuthSessionByHash(input.tokenHash)
  }

  addUsageCodeToAuthSession(sessionId: string, usageCodeId: string) {
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO auth_session_usage_codes (
        session_id,
        usage_code_id,
        created_at
      )
      VALUES (?, ?, ?)
    `).run(sessionId, usageCodeId, new Date().toISOString())
  }

  listAuthSessionUsageCodes(sessionId: string) {
    const rows = this.sqlite
      .prepare(`
        SELECT
          usage_codes.id,
          usage_codes.code_hash as codeHash,
          usage_codes.code_encrypted as codeEncrypted,
          usage_codes.name,
          usage_codes.user_tier as userTier,
          usage_codes.allowed_provider_profile_ids_json as allowedProviderProfileIdsJson,
          usage_codes.is_enabled as isEnabled,
          usage_codes.image_quota as imageQuota,
          usage_codes.provider_image_quotas_json as providerImageQuotasJson,
          usage_codes.used_image_credits as usedImageCredits,
          usage_codes.provider_used_image_credits_json as providerUsedImageCreditsJson,
          usage_codes.video_quota as videoQuota,
          usage_codes.provider_video_quotas_json as providerVideoQuotasJson,
          usage_codes.used_video_credits as usedVideoCredits,
          usage_codes.provider_used_video_credits_json as providerUsedVideoCreditsJson,
          usage_codes.output_image_count as outputImageCount,
          usage_codes.output_video_count as outputVideoCount,
          usage_codes.created_at as createdAt,
          usage_codes.updated_at as updatedAt,
          usage_codes.last_used_at as lastUsedAt,
          auth_session_usage_codes.created_at as sessionUsageCreatedAt
        FROM auth_session_usage_codes
        INNER JOIN usage_codes ON usage_codes.id = auth_session_usage_codes.usage_code_id
        LEFT JOIN tasks ON tasks.owner_usage_code_id = usage_codes.id
        WHERE auth_session_usage_codes.session_id = ?
        GROUP BY usage_codes.id, auth_session_usage_codes.created_at
        ORDER BY auth_session_usage_codes.created_at ASC
      `)
      .all(sessionId) as Array<{
        allowedProviderProfileIdsJson: string | null
        providerImageQuotasJson: string | null
        providerUsedImageCreditsJson: string | null
        providerVideoQuotasJson: string | null
        providerUsedVideoCreditsJson: string | null
      } & Omit<AuthSessionUsageCodeRecord, 'allowedProviderProfileIds' | 'providerImageQuotas' | 'providerUsedImageCredits' | 'providerVideoQuotas' | 'providerUsedVideoCredits'>>
    return rows.map((row) => normalizeUsageCodeRow(row))
  }

  getAuthSessionByHash(tokenHash: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          token_hash as tokenHash,
          role,
          usage_code_id as usageCodeId,
          expires_at as expiresAt,
          created_at as createdAt,
          last_seen_at as lastSeenAt
        FROM auth_sessions
        WHERE token_hash = ?
      `)
      .get(tokenHash) as AuthSessionRecord | undefined
  }

  touchAuthSession(id: string) {
    this.sqlite.prepare(`
      UPDATE auth_sessions
      SET last_seen_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id)
  }

  deleteAuthSessionByHash(tokenHash: string) {
    this.sqlite.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
  }

  deleteExpiredAuthSessions() {
    this.sqlite.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString())
  }

  reserveUsageCreditsForTask(input: {
    usageCodeId: string
    taskId: string
    credits: number
    providerProfileId: string
  }) {
    const tx = this.sqlite.transaction(() => {
      const code = this.getUsageCode(input.usageCodeId)
      if (!code || !code.isEnabled) {
        throw new Error('使用码不可用')
      }
      const providerQuota = code.providerImageQuotas?.[input.providerProfileId] ?? 0
      const providerUsedCredits = code.providerUsedImageCredits?.[input.providerProfileId] ?? 0
      const providerRemaining = providerQuota - providerUsedCredits
      if (providerRemaining < input.credits) {
        throw new Error(`当前端点剩余图片额度不足，当前剩余 ${Math.max(0, providerRemaining)} 张`)
      }

      const now = new Date().toISOString()
      const nextProviderUsedImageCredits = {
        ...(code.providerUsedImageCredits ?? {}),
        [input.providerProfileId]: providerUsedCredits + input.credits,
      }
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_image_credits = used_image_credits + ?,
            provider_used_image_credits_json = ?,
            updated_at = ?,
            last_used_at = ?
        WHERE id = ?
      `).run(
        input.credits,
        stringifyProviderImageQuotaMap(nextProviderUsedImageCredits),
        now,
        now,
        input.usageCodeId,
      )
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          provider_profile_id,
          created_at
        )
        VALUES (?, ?, 'reserve', ?, 'task_create', ?, ?)
      `).run(input.usageCodeId, input.taskId, input.credits, input.providerProfileId, now)

      const nextCode = this.getUsageCode(input.usageCodeId)
      return nextCode
        ? {
            usedImageCredits: nextCode.usedImageCredits,
            remainingImageCredits: Object.entries(nextCode.providerImageQuotas ?? {}).reduce(
              (sum, [providerProfileId, quota]) => sum + Math.max(0, quota - (nextCode.providerUsedImageCredits?.[providerProfileId] ?? 0)),
              0,
            ),
            providerRemainingImageCredits: Math.max(
              0,
              (nextCode.providerImageQuotas?.[input.providerProfileId] ?? 0)
              - (nextCode.providerUsedImageCredits?.[input.providerProfileId] ?? 0),
            ),
          }
        : null
    })

    return tx()
  }

  refundUsageCreditsForTask(input: {
    usageCodeId: string
    taskId: string
    credits: number
    reason: string
    providerProfileId?: string | null
  }) {
    if (input.credits <= 0) return false
    const tx = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare(`
          SELECT 1 as existsFlag
          FROM usage_quota_events
          WHERE task_id = ? AND event_type = 'refund'
          LIMIT 1
        `)
        .get(input.taskId) as { existsFlag: number } | undefined
      if (existing) return false

      const now = new Date().toISOString()
      const code = this.getUsageCode(input.usageCodeId)
      const nextProviderUsedImageCredits = { ...(code?.providerUsedImageCredits ?? {}) }
      if (input.providerProfileId && nextProviderUsedImageCredits[input.providerProfileId] != null) {
        nextProviderUsedImageCredits[input.providerProfileId] = Math.max(
          0,
          nextProviderUsedImageCredits[input.providerProfileId] - input.credits,
        )
        if (nextProviderUsedImageCredits[input.providerProfileId] === 0) {
          delete nextProviderUsedImageCredits[input.providerProfileId]
        }
      }
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_image_credits = MAX(0, used_image_credits - ?),
            provider_used_image_credits_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.credits,
        stringifyProviderImageQuotaMap(nextProviderUsedImageCredits),
        now,
        input.usageCodeId,
      )
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          provider_profile_id,
          created_at
        )
        VALUES (?, ?, 'refund', ?, ?, ?, ?)
      `).run(input.usageCodeId, input.taskId, input.credits, input.reason, input.providerProfileId ?? null, now)
      return true
    })

    return tx()
  }

  reserveVideoCreditsForTask(input: {
    usageCodeId: string
    taskId: string
    credits: number
    providerProfileId: string
  }) {
    const tx = this.sqlite.transaction(() => {
      const code = this.getUsageCode(input.usageCodeId)
      if (!code || !code.isEnabled) {
        throw new Error('使用码不可用')
      }
      const providerQuota = code.providerVideoQuotas?.[input.providerProfileId] ?? 0
      const providerUsedCredits = code.providerUsedVideoCredits?.[input.providerProfileId] ?? 0
      const providerRemaining = providerQuota - providerUsedCredits
      if (providerRemaining < input.credits) {
        throw new Error(`当前端点剩余视频额度不足，当前剩余 ${Math.max(0, providerRemaining)} 次`)
      }

      const now = new Date().toISOString()
      const nextProviderUsedVideoCredits = {
        ...(code.providerUsedVideoCredits ?? {}),
        [input.providerProfileId]: providerUsedCredits + input.credits,
      }
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_video_credits = used_video_credits + ?,
            provider_used_video_credits_json = ?,
            updated_at = ?,
            last_used_at = ?
        WHERE id = ?
      `).run(
        input.credits,
        stringifyProviderImageQuotaMap(nextProviderUsedVideoCredits),
        now,
        now,
        input.usageCodeId,
      )
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          provider_profile_id,
          created_at
        )
        VALUES (?, ?, 'video_reserve', ?, 'task_create', ?, ?)
      `).run(input.usageCodeId, input.taskId, input.credits, input.providerProfileId, now)

      const nextCode = this.getUsageCode(input.usageCodeId)
      return nextCode
        ? {
            usedVideoCredits: nextCode.usedVideoCredits,
            remainingVideoCredits: Object.entries(nextCode.providerVideoQuotas ?? {}).reduce(
              (sum, [providerProfileId, quota]) => sum + Math.max(0, quota - (nextCode.providerUsedVideoCredits?.[providerProfileId] ?? 0)),
              0,
            ),
            providerRemainingVideoCredits: Math.max(
              0,
              (nextCode.providerVideoQuotas?.[input.providerProfileId] ?? 0)
              - (nextCode.providerUsedVideoCredits?.[input.providerProfileId] ?? 0),
            ),
          }
        : null
    })

    return tx()
  }

  refundVideoCreditsForTask(input: {
    usageCodeId: string
    taskId: string
    credits: number
    reason: string
    providerProfileId?: string | null
  }) {
    if (input.credits <= 0) return false
    const tx = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare(`
          SELECT 1 as existsFlag
          FROM usage_quota_events
          WHERE task_id = ? AND event_type = 'video_refund'
          LIMIT 1
        `)
        .get(input.taskId) as { existsFlag: number } | undefined
      if (existing) return false

      const now = new Date().toISOString()
      const code = this.getUsageCode(input.usageCodeId)
      const nextProviderUsedVideoCredits = { ...(code?.providerUsedVideoCredits ?? {}) }
      if (input.providerProfileId && nextProviderUsedVideoCredits[input.providerProfileId] != null) {
        nextProviderUsedVideoCredits[input.providerProfileId] = Math.max(
          0,
          nextProviderUsedVideoCredits[input.providerProfileId] - input.credits,
        )
        if (nextProviderUsedVideoCredits[input.providerProfileId] === 0) {
          delete nextProviderUsedVideoCredits[input.providerProfileId]
        }
      }
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_video_credits = MAX(0, used_video_credits - ?),
            provider_used_video_credits_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.credits,
        stringifyProviderImageQuotaMap(nextProviderUsedVideoCredits),
        now,
        input.usageCodeId,
      )
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          provider_profile_id,
          created_at
        )
        VALUES (?, ?, 'video_refund', ?, ?, ?, ?)
      `).run(input.usageCodeId, input.taskId, input.credits, input.reason, input.providerProfileId ?? null, now)
      return true
    })

    return tx()
  }

  refundTaskQuota(taskId: string, reason: string) {
    const task = this.getTask(taskId)
    if (!task?.ownerUsageCodeId || task.ownerKind !== 'usage_code' || task.reservedImageCredits <= 0) {
      return false
    }
    if (task.taskType === 'video') {
      return this.refundVideoCreditsForTask({
        usageCodeId: task.ownerUsageCodeId,
        taskId,
        credits: task.reservedImageCredits,
        reason,
        providerProfileId: task.providerProfileId,
      })
    }
    return this.refundUsageCreditsForTask({
      usageCodeId: task.ownerUsageCodeId,
      taskId,
      credits: task.reservedImageCredits,
      reason,
      providerProfileId: task.providerProfileId,
    })
  }

  recordUsageCodeOutputImages(input: {
    usageCodeId: string
    count: number
  }) {
    if (input.count <= 0) return false
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET output_image_count = output_image_count + ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.count, new Date().toISOString(), input.usageCodeId)
    return true
  }

  recordUsageCodeOutputVideos(input: {
    usageCodeId: string
    count: number
  }) {
    if (input.count <= 0) return false
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET output_video_count = output_video_count + ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.count, new Date().toISOString(), input.usageCodeId)
    return true
  }

  private insertUsageQuotaEvent(input: {
    usageCodeId: string
    taskId?: string | null
    eventType: string
    credits: number
    reason?: string | null
    providerProfileId?: string | null
    createdAt: string
  }) {
    this.sqlite.prepare(`
      INSERT INTO usage_quota_events (
        usage_code_id,
        task_id,
        event_type,
        credits,
        reason,
        provider_profile_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.usageCodeId,
      input.taskId ?? null,
      input.eventType,
      input.credits,
      input.reason ?? null,
      input.providerProfileId ?? null,
      input.createdAt,
    )
  }

  adjustUsageCodeQuota(input: {
    usageCodeId: string
    action: 'increase' | 'decrease'
    credits: number
    providerProfileId?: string | null
  }) {
    if (input.credits <= 0) {
      throw new Error('调整额度必须大于 0')
    }
    const tx = this.sqlite.transaction(() => {
      const code = this.getUsageCode(input.usageCodeId)
      if (!code) {
        throw new Error('使用码不存在')
      }
      const now = new Date().toISOString()

      if (!input.providerProfileId) {
        if (code.providerImageQuotas && Object.keys(code.providerImageQuotas).length > 0) {
          throw new Error('当前使用码已按端点分额度，请改为调整端点额度')
        }
        if (code.imageQuota == null) {
          throw new Error('不限量使用码不能直接增减总额度')
        }
        const nextQuota = input.action === 'increase'
          ? code.imageQuota + input.credits
          : Math.max(code.usedImageCredits, code.imageQuota - input.credits)
        this.sqlite.prepare(`
          UPDATE usage_codes
          SET image_quota = ?, updated_at = ?
          WHERE id = ?
        `).run(nextQuota, now, input.usageCodeId)
        this.insertUsageQuotaEvent({
          usageCodeId: input.usageCodeId,
          eventType: input.action === 'increase' ? 'admin_increase' : 'admin_decrease',
          credits: input.credits,
          reason: 'admin_adjust_total',
          createdAt: now,
        })
      } else {
        const providerUsedImageCredits = code.providerUsedImageCredits?.[input.providerProfileId] ?? 0
        const nextProviderImageQuotas = { ...(code.providerImageQuotas ?? {}) }
        const currentProviderQuota = nextProviderImageQuotas[input.providerProfileId] ?? providerUsedImageCredits
        const nextProviderQuota = input.action === 'increase'
          ? currentProviderQuota + input.credits
          : Math.max(providerUsedImageCredits, currentProviderQuota - input.credits)
        nextProviderImageQuotas[input.providerProfileId] = nextProviderQuota
        const normalizedProviderImageQuotas = Object.fromEntries(
          Object.entries(nextProviderImageQuotas).filter(([, quota]) => quota > 0),
        )
        const nextImageQuota = Object.values(normalizedProviderImageQuotas).reduce((sum, quota) => sum + quota, 0)
        this.sqlite.prepare(`
          UPDATE usage_codes
          SET image_quota = ?,
              provider_image_quotas_json = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          nextImageQuota,
          stringifyProviderImageQuotaMap(normalizedProviderImageQuotas),
          now,
          input.usageCodeId,
        )
        this.insertUsageQuotaEvent({
          usageCodeId: input.usageCodeId,
          eventType: input.action === 'increase' ? 'admin_increase' : 'admin_decrease',
          credits: input.credits,
          reason: 'admin_adjust_provider',
          providerProfileId: input.providerProfileId,
          createdAt: now,
        })
      }

      return this.getUsageCode(input.usageCodeId)
    })

    return tx()
  }

  createTask(input: {
    id: string
    prompt: string
    paramsJson: string
    taskType?: 'image' | 'video'
    providerProfileId: string | null
    ownerUsageCodeId?: string | null
    ownerKind?: 'admin' | 'usage_code' | 'legacy'
    reservedImageCredits?: number
  }) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO tasks (
        id,
        prompt,
        task_type,
        status,
        progress_percent,
        current_step,
        params_json,
        error_message,
        provider_profile_id,
        owner_usage_code_id,
        owner_kind,
        reserved_image_credits,
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, ?, 'queued', 5, 'queued', ?, NULL, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      input.id,
      input.prompt,
      input.taskType ?? 'image',
      input.paramsJson,
      input.providerProfileId,
      input.ownerUsageCodeId ?? null,
      input.ownerKind ?? 'legacy',
      input.reservedImageCredits ?? 0,
      now,
      now,
    )

    return this.getTask(input.id)
  }

  listActiveTasks() {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          CASE
            WHEN owner_kind = 'admin' THEN '管理员'
            WHEN owner_kind = 'usage_code' THEN COALESCE(usage_codes.name, '已删除使用码')
            ELSE '历史任务'
          END as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        WHERE tasks.status IN ('queued', 'submitted', 'processing', 'downloading')
        ORDER BY tasks.created_at ASC
      `)
      .all() as TaskRecord[]
  }

  listTasks(limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          CASE
            WHEN owner_kind = 'admin' THEN '管理员'
            WHEN owner_kind = 'usage_code' THEN COALESCE(usage_codes.name, '已删除使用码')
            ELSE '历史任务'
          END as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        ORDER BY tasks.created_at DESC
        LIMIT ?
      `)
      .all(limit) as TaskRecord[]
  }

  private buildTaskListWhereClause(input: Omit<TaskListQueryInput, 'limit' | 'offset'>) {
    const where: string[] = []
    const params: Array<string | number> = []

    if (input.ownerUsageCodeIds) {
      if (input.ownerUsageCodeIds.length === 0) {
        where.push('1 = 0')
      } else {
        where.push(`tasks.owner_usage_code_id IN (${input.ownerUsageCodeIds.map(() => '?').join(', ')})`)
        params.push(...input.ownerUsageCodeIds)
      }
    }

    if (input.includeUsageCodeTasksForAdmin === false) {
      where.push("tasks.owner_kind <> 'usage_code'")
    }

    if (input.favorite) {
      where.push('tasks.is_favorite = 1')
    }

    if (input.archived === true) {
      where.push('tasks.is_archived = 1')
    } else if (input.archived === false) {
      where.push('tasks.is_archived = 0')
    }

    if (input.taskType && input.taskType !== 'all') {
      where.push('tasks.task_type = ?')
      params.push(input.taskType)
    }

    if (input.status && input.status !== 'all') {
      if (input.status === 'running') {
        where.push("tasks.status IN ('queued', 'submitted', 'processing', 'downloading')")
      } else if (input.status === 'done') {
        where.push("tasks.status = 'succeeded'")
      } else if (input.status === 'error') {
        where.push("tasks.status IN ('failed', 'canceled')")
      }
    }

    return {
      whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
    }
  }

  listTaskPage(input: TaskListQueryInput) {
    const { whereSql, params } = this.buildTaskListWhereClause(input)
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          CASE
            WHEN tasks.owner_kind = 'admin' THEN '管理员'
            WHEN tasks.owner_kind = 'usage_code' THEN COALESCE(usage_codes.name, '已删除使用码')
            ELSE '历史任务'
          END as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        ${whereSql}
        ORDER BY tasks.created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, input.limit, input.offset) as TaskRecord[]
  }

  countTaskPage(input: Omit<TaskListQueryInput, 'limit' | 'offset'>) {
    const { whereSql, params } = this.buildTaskListWhereClause(input)
    const row = this.sqlite
      .prepare(`
        SELECT COUNT(*) as total
        FROM tasks
        ${whereSql}
      `)
      .get(...params) as { total: number }
    return row.total
  }

  private taskOwnerStatsSelect() {
    return `
      usage_codes.created_at as ownerUsageCodeCreatedAt,
      usage_codes.code_encrypted as ownerUsageCodeCodeEncrypted,
      usage_codes.last_used_at as ownerUsageCodeLastUsedAt,
      usage_codes.image_quota as ownerUsageCodeImageQuota,
      usage_codes.used_image_credits as ownerUsageCodeUsedImageCredits,
      usage_codes.provider_image_quotas_json as ownerUsageCodeProviderImageQuotasJson,
      usage_codes.provider_used_image_credits_json as ownerUsageCodeProviderUsedImageCreditsJson,
      usage_codes.video_quota as ownerUsageCodeVideoQuota,
      usage_codes.used_video_credits as ownerUsageCodeUsedVideoCredits,
      usage_codes.provider_video_quotas_json as ownerUsageCodeProviderVideoQuotasJson,
      usage_codes.provider_used_video_credits_json as ownerUsageCodeProviderUsedVideoCreditsJson,
      (
        SELECT COUNT(task_images.id)
        FROM tasks owner_tasks
        INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'output'
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeOutputImageCount,
      (
        SELECT COUNT(task_images.id)
        FROM tasks owner_tasks
        INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'video_output'
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeOutputVideoCount,
      (
        SELECT COUNT(*)
        FROM tasks owner_tasks
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeTaskCount
      ,
      (
        SELECT COUNT(task_images.id)
        FROM tasks owner_tasks
        INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'output'
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
          AND owner_tasks.provider_profile_id = tasks.provider_profile_id
      ) as ownerUsageCodeProviderOutputImageCount
      ,
      (
        SELECT COUNT(task_images.id)
        FROM tasks owner_tasks
        INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'video_output'
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
          AND owner_tasks.provider_profile_id = tasks.provider_profile_id
      ) as ownerUsageCodeProviderOutputVideoCount
    `
  }

  listTasksForUsageCode(usageCodeId: string, limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          COALESCE(usage_codes.name, '已删除使用码') as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        WHERE tasks.owner_kind = 'usage_code'
          AND tasks.owner_usage_code_id = ?
        ORDER BY tasks.created_at DESC
        LIMIT ?
      `)
      .all(usageCodeId, limit) as TaskRecord[]
  }

  listTasksForUsageCodes(usageCodeIds: string[], limit = 50) {
    if (usageCodeIds.length === 0) return []
    const placeholders = usageCodeIds.map(() => '?').join(', ')
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          COALESCE(usage_codes.name, '已删除使用码') as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        WHERE tasks.owner_kind = 'usage_code'
          AND tasks.owner_usage_code_id IN (${placeholders})
        ORDER BY tasks.created_at DESC
        LIMIT ?
      `)
      .all(...usageCodeIds, limit) as TaskRecord[]
  }

  listAllUsageCodeTasks() {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          COALESCE(usage_codes.name, '已删除使用码') as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        WHERE tasks.owner_kind = 'usage_code'
        ORDER BY tasks.created_at DESC
      `)
      .all() as TaskRecord[]
  }

  listUsageCodeTaskMediaCleanupRecords() {
    return this.listTaskMediaCleanupRecords('usage_code')
  }

  listTaskMediaCleanupRecords(ownerKind?: 'usage_code' | 'admin' | 'legacy') {
    const whereClause = ownerKind ? 'WHERE tasks.owner_kind = ?' : ''
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id as taskId,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          task_images.kind,
          task_images.file_path as filePath,
          task_images.bytes as bytes
        FROM tasks
        LEFT JOIN task_images ON task_images.task_id = tasks.id
        ${whereClause}
        ORDER BY tasks.created_at DESC, task_images.created_at ASC, task_images.id ASC
      `)
      .all(...(ownerKind ? [ownerKind] : [])) as UsageCodeTaskMediaCleanupRecord[]
  }

  getTask(id: string) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.task_type as taskType,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
          tasks.upstream_request_id as upstreamRequestId,
          tasks.upstream_usage_json as upstreamUsageJson,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind,
          tasks.reserved_image_credits as reservedImageCredits,
          CASE
            WHEN owner_kind = 'admin' THEN '管理员'
            WHEN owner_kind = 'usage_code' THEN COALESCE(usage_codes.name, '已删除使用码')
            ELSE '历史任务'
          END as ownerLabel,
          ${this.taskOwnerStatsSelect()},
          tasks.created_at as createdAt,
          tasks.updated_at as updatedAt,
          tasks.finished_at as finishedAt,
          tasks.is_favorite as isFavorite,
          tasks.is_archived as isArchived
        FROM tasks
        LEFT JOIN usage_codes ON usage_codes.id = tasks.owner_usage_code_id
        WHERE tasks.id = ?
      `)
      .get(id) as TaskRecord | undefined
  }

  taskExists(id: string) {
    const row = this.sqlite
      .prepare('SELECT 1 as existsFlag FROM tasks WHERE id = ? LIMIT 1')
      .get(id) as { existsFlag: number } | undefined
    return Boolean(row)
  }

  updateTaskProgress(input: {
    id: string
    status: string
    progressPercent: number
    currentStep: string
    errorMessage?: string | null
    finishedAt?: string | null
    upstreamRequestId?: string | null
    upstreamUsageJson?: string | null
  }) {
    const now = new Date().toISOString()
    const result = this.sqlite.prepare(`
      UPDATE tasks
      SET
        status = @status,
        progress_percent = @progressPercent,
        current_step = @currentStep,
        error_message = @errorMessage,
        upstream_request_id = COALESCE(@upstreamRequestId, upstream_request_id),
        upstream_usage_json = COALESCE(@upstreamUsageJson, upstream_usage_json),
        updated_at = @updatedAt,
        finished_at = @finishedAt
      WHERE id = @id
    `).run({
      ...input,
      errorMessage: input.errorMessage ?? null,
      upstreamRequestId: input.upstreamRequestId ?? null,
      upstreamUsageJson: input.upstreamUsageJson ?? null,
      updatedAt: now,
      finishedAt: input.finishedAt ?? null,
    })

    if (!result.changes) return null

    return this.getTask(input.id)
  }

  updateTaskFlags(input: {
    id: string
    isFavorite?: boolean
    isArchived?: boolean
  }) {
    const now = new Date().toISOString()
    const current = this.getTask(input.id)
    if (!current) return null

    const result = this.sqlite.prepare(`
      UPDATE tasks
      SET
        is_favorite = @isFavorite,
        is_archived = @isArchived,
        updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: input.id,
      isFavorite: input.isFavorite == null ? current.isFavorite : input.isFavorite ? 1 : 0,
      isArchived: input.isArchived == null ? current.isArchived : input.isArchived ? 1 : 0,
      updatedAt: now,
    })

    if (!result.changes) return null
    return this.getTask(input.id)
  }

  appendTaskEvent(input: {
    taskId: string
    status: string
    step: string
    percent: number
    message?: string | null
  }) {
    const now = new Date().toISOString()
    let result: Database.RunResult
    try {
      result = this.sqlite.prepare(`
        INSERT INTO task_events (
          task_id,
          status,
          step,
          percent,
          message,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.taskId, input.status, input.step, input.percent, input.message ?? null, now)
    } catch (error) {
      const isForeignKeyError =
        error instanceof Error
        && /FOREIGN KEY constraint failed/i.test(error.message)
      if (isForeignKeyError && !this.taskExists(input.taskId)) {
        return null
      }
      throw error
    }

    return this.sqlite
      .prepare(`
        SELECT
          id,
          task_id as taskId,
          status,
          step,
          percent,
          message,
          created_at as createdAt
        FROM task_events
        WHERE id = ?
      `)
      .get(result.lastInsertRowid) as TaskEventRecord
  }

  listTaskEvents(taskId: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          task_id as taskId,
          status,
          step,
          percent,
          message,
          created_at as createdAt
        FROM task_events
        WHERE task_id = ?
        ORDER BY id ASC
      `)
      .all(taskId) as TaskEventRecord[]
  }

  listAllTaskEvents() {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          task_id as taskId,
          status,
          step,
          percent,
          message,
          created_at as createdAt
        FROM task_events
        ORDER BY id ASC
      `)
      .all() as TaskEventRowRecord[]
  }

  addTaskImage(input: {
    id: string
    taskId: string
    kind: 'input' | 'mask' | 'output' | 'thumb' | 'video_input' | 'video_output'
    filePath: string
    mimeType: string
    width?: number | null
    height?: number | null
    bytes: number
    sha256: string
    metadataJson?: string | null
  }) {
    const now = new Date().toISOString()
    try {
      this.sqlite.prepare(`
        INSERT INTO task_images (
          id,
          task_id,
          kind,
          file_path,
          mime_type,
          width,
          height,
          bytes,
          sha256,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.taskId,
        input.kind,
        input.filePath,
        input.mimeType,
        input.width ?? null,
        input.height ?? null,
        input.bytes,
        input.sha256,
        input.metadataJson ?? null,
        now,
        )
      return true
    } catch (error) {
      const isForeignKeyError =
        error instanceof Error
        && /FOREIGN KEY constraint failed/i.test(error.message)
      if (isForeignKeyError && !this.taskExists(input.taskId)) {
        return false
      }
      throw error
    }
  }

  replaceImportedData(input: {
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
  }) {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM task_events').run()
      this.sqlite.prepare('DELETE FROM task_images').run()
      this.sqlite.prepare('DELETE FROM tasks').run()

      const insertTask = this.sqlite.prepare(`
        INSERT INTO tasks (
          id,
          prompt,
          task_type,
          status,
          progress_percent,
          current_step,
          params_json,
          error_message,
          provider_profile_id,
          upstream_request_id,
          upstream_usage_json,
          owner_usage_code_id,
          owner_kind,
          reserved_image_credits,
          created_at,
          updated_at,
          finished_at,
          is_favorite,
          is_archived
        )
        VALUES (
          @id,
          @prompt,
          @taskType,
          @status,
          @progressPercent,
          @currentStep,
          @paramsJson,
          @errorMessage,
          @providerProfileId,
          @upstreamRequestId,
          @upstreamUsageJson,
          @ownerUsageCodeId,
          @ownerKind,
          @reservedImageCredits,
          @createdAt,
          @updatedAt,
          @finishedAt,
          @isFavorite,
          @isArchived
        )
      `)

      const insertTaskImage = this.sqlite.prepare(`
        INSERT INTO task_images (
          id,
          task_id,
          kind,
          file_path,
          mime_type,
          width,
          height,
          bytes,
          sha256,
          metadata_json,
          created_at
        )
        VALUES (
          @id,
          @taskId,
          @kind,
          @filePath,
          @mimeType,
          @width,
          @height,
          @bytes,
          @sha256,
          @metadataJson,
          @createdAt
        )
      `)

      for (const task of input.tasks) {
        insertTask.run({
          ...task,
          taskType: task.taskType ?? 'image',
          upstreamRequestId: task.upstreamRequestId ?? null,
          upstreamUsageJson: task.upstreamUsageJson ?? null,
          ownerUsageCodeId: task.ownerUsageCodeId ?? null,
          ownerKind: task.ownerKind ?? 'legacy',
          reservedImageCredits: task.reservedImageCredits ?? 0,
          isFavorite: task.isFavorite ? 1 : 0,
          isArchived: task.isArchived ? 1 : 0,
        })
      }
      for (const image of input.taskImages) {
        insertTaskImage.run({
          ...image,
          metadataJson: image.metadataJson ?? null,
        })
      }
    })

    tx()
  }

  replaceFullBackup(input: {
    providerProfiles: ProviderProfileRecord[]
    appSettings: AppSettingRecord[]
    usageCodes: Array<UsageCodeRawRecord>
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
  }) {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM auth_sessions').run()
      this.sqlite.prepare('DELETE FROM usage_quota_events').run()
      this.sqlite.prepare('DELETE FROM usage_code_activity_logs').run()
      this.sqlite.prepare('DELETE FROM task_events').run()
      this.sqlite.prepare('DELETE FROM task_images').run()
      this.sqlite.prepare('DELETE FROM tasks').run()
      this.sqlite.prepare('DELETE FROM app_settings').run()
      this.sqlite.prepare('DELETE FROM provider_profiles').run()
      this.sqlite.prepare('DELETE FROM usage_codes').run()

      const insertProviderProfile = this.sqlite.prepare(`
        INSERT INTO provider_profiles (
          id,
          name,
          remark_name,
          tag_color,
          base_url,
          api_key_encrypted,
          model,
          model_options_json,
          api_mode,
          timeout_seconds,
          codex_cli,
          grok_api_compat,
          xai_image_2k_enabled,
          response_format_b64_json,
          video_max_resolution,
          video_resolution_options_json,
          video_max_duration,
          video_duration_options_json,
          is_default,
          created_at,
          updated_at
        )
        VALUES (
          @id,
          @name,
          @remarkName,
          @tagColor,
          @baseUrl,
          @apiKeyEncrypted,
          @model,
          @modelOptionsJson,
          @apiMode,
          @timeoutSeconds,
          @codexCli,
          @grokApiCompat,
          @xaiImage2kEnabled,
          @responseFormatB64Json,
          @videoMaxResolution,
          @videoResolutionOptionsJson,
          @videoMaxDuration,
          @videoDurationOptionsJson,
          @isDefault,
          @createdAt,
          @updatedAt
        )
      `)

      const insertAppSetting = this.sqlite.prepare(`
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (@key, @valueJson, @updatedAt)
      `)

      const insertUsageCode = this.sqlite.prepare(`
        INSERT INTO usage_codes (
          id,
          code_hash,
          code_encrypted,
          name,
          user_tier,
          allowed_provider_profile_ids_json,
          is_enabled,
          image_quota,
          provider_image_quotas_json,
          used_image_credits,
          provider_used_image_credits_json,
          video_quota,
          provider_video_quotas_json,
          used_video_credits,
          provider_used_video_credits_json,
          output_image_count,
          output_video_count,
          created_at,
          updated_at,
          last_used_at
        )
        VALUES (
          @id,
          @codeHash,
          @codeEncrypted,
          @name,
          @userTier,
          @allowedProviderProfileIdsJson,
          @isEnabled,
          @imageQuota,
          @providerImageQuotasJson,
          @usedImageCredits,
          @providerUsedImageCreditsJson,
          @videoQuota,
          @providerVideoQuotasJson,
          @usedVideoCredits,
          @providerUsedVideoCreditsJson,
          @outputImageCount,
          @outputVideoCount,
          @createdAt,
          @updatedAt,
          @lastUsedAt
        )
      `)

      const insertTask = this.sqlite.prepare(`
        INSERT INTO tasks (
          id,
          prompt,
          task_type,
          status,
          progress_percent,
          current_step,
          params_json,
          error_message,
          provider_profile_id,
          upstream_request_id,
          upstream_usage_json,
          owner_usage_code_id,
          owner_kind,
          reserved_image_credits,
          created_at,
          updated_at,
          finished_at,
          is_favorite,
          is_archived
        )
        VALUES (
          @id,
          @prompt,
          @taskType,
          @status,
          @progressPercent,
          @currentStep,
          @paramsJson,
          @errorMessage,
          @providerProfileId,
          @upstreamRequestId,
          @upstreamUsageJson,
          @ownerUsageCodeId,
          @ownerKind,
          @reservedImageCredits,
          @createdAt,
          @updatedAt,
          @finishedAt,
          @isFavorite,
          @isArchived
        )
      `)

      const insertTaskImage = this.sqlite.prepare(`
        INSERT INTO task_images (
          id,
          task_id,
          kind,
          file_path,
          mime_type,
          width,
          height,
          bytes,
          sha256,
          metadata_json,
          created_at
        )
        VALUES (
          @id,
          @taskId,
          @kind,
          @filePath,
          @mimeType,
          @width,
          @height,
          @bytes,
          @sha256,
          @metadataJson,
          @createdAt
        )
      `)

      const insertTaskEvent = this.sqlite.prepare(`
        INSERT INTO task_events (
          id,
          task_id,
          status,
          step,
          percent,
          message,
          created_at
        )
        VALUES (
          @id,
          @taskId,
          @status,
          @step,
          @percent,
          @message,
          @createdAt
        )
      `)

      const insertUsageQuotaEvent = this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          id,
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          provider_profile_id,
          created_at
        )
        VALUES (
          @id,
          @usageCodeId,
          @taskId,
          @eventType,
          @credits,
          @reason,
          @providerProfileId,
          @createdAt
        )
      `)

      const insertUsageCodeActivityLog = this.sqlite.prepare(`
        INSERT INTO usage_code_activity_logs (
          id,
          usage_code_id,
          task_id,
          actor_kind,
          event_type,
          message,
          created_at
        )
        VALUES (
          @id,
          @usageCodeId,
          @taskId,
          @actorKind,
          @eventType,
          @message,
          @createdAt
        )
      `)

      for (const profile of input.providerProfiles) {
        insertProviderProfile.run({
          ...profile,
          remarkName: profile.remarkName ?? null,
          modelOptionsJson: JSON.stringify(profile.modelOptions ?? [profile.model]),
          videoResolutionOptionsJson: JSON.stringify(normalizeVideoResolutionOptions(profile.videoResolutionOptions ?? [profile.videoMaxResolution])),
          videoDurationOptionsJson: JSON.stringify(normalizeVideoDurationOptions(profile.videoDurationOptions ?? [profile.videoMaxDuration])),
        })
      }
      for (const setting of input.appSettings) {
        insertAppSetting.run(setting)
      }
      for (const usageCode of input.usageCodes) {
        insertUsageCode.run({
          ...usageCode,
          allowedProviderProfileIdsJson: stringifyAllowedProviderProfileIds(usageCode.allowedProviderProfileIds),
          providerImageQuotasJson: stringifyProviderImageQuotaMap(usageCode.providerImageQuotas),
          providerUsedImageCreditsJson: stringifyProviderImageQuotaMap(usageCode.providerUsedImageCredits),
          providerVideoQuotasJson: stringifyProviderImageQuotaMap(usageCode.providerVideoQuotas),
          providerUsedVideoCreditsJson: stringifyProviderImageQuotaMap(usageCode.providerUsedVideoCredits),
          isEnabled: usageCode.isEnabled ? 1 : 0,
        })
      }
      for (const task of input.tasks) {
        insertTask.run({
          ...task,
          taskType: task.taskType ?? 'image',
          upstreamRequestId: task.upstreamRequestId ?? null,
          upstreamUsageJson: task.upstreamUsageJson ?? null,
          ownerUsageCodeId: task.ownerUsageCodeId ?? null,
          ownerKind: task.ownerKind ?? 'legacy',
          reservedImageCredits: task.reservedImageCredits ?? 0,
          isFavorite: task.isFavorite ? 1 : 0,
          isArchived: task.isArchived ? 1 : 0,
        })
      }
      for (const image of input.taskImages) {
        insertTaskImage.run({
          ...image,
          metadataJson: image.metadataJson ?? null,
        })
      }
      for (const event of input.taskEvents) {
        insertTaskEvent.run(event)
      }
      for (const event of input.usageQuotaEvents) {
        insertUsageQuotaEvent.run(event)
      }
      for (const event of input.usageCodeActivityLogs) {
        insertUsageCodeActivityLog.run(event)
      }
    })

    tx()
  }

  clearTaskData() {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM task_events').run()
      this.sqlite.prepare('DELETE FROM task_images').run()
      this.sqlite.prepare('DELETE FROM tasks').run()
    })

    tx()
  }

  clearRuntimeData() {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM auth_sessions').run()
      this.sqlite.prepare('DELETE FROM usage_quota_events').run()
      this.sqlite.prepare('DELETE FROM task_events').run()
      this.sqlite.prepare('DELETE FROM task_images').run()
      this.sqlite.prepare('DELETE FROM tasks').run()
      this.sqlite.prepare('DELETE FROM app_settings').run()
      this.sqlite.prepare('DELETE FROM provider_profiles').run()
      this.sqlite.prepare('DELETE FROM usage_codes').run()
    })

    tx()
  }

  clearUsageCodeTaskData() {
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM task_events
        WHERE task_id IN (
          SELECT id
          FROM tasks
          WHERE owner_kind = 'usage_code'
        )
      `).run()
      this.sqlite.prepare(`
        DELETE FROM task_images
        WHERE task_id IN (
          SELECT id
          FROM tasks
          WHERE owner_kind = 'usage_code'
        )
      `).run()
      this.sqlite.prepare(`
        DELETE FROM tasks
        WHERE owner_kind = 'usage_code'
      `).run()
    })

    tx()
  }

  listTaskImages(taskId: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          task_id as taskId,
          kind,
          file_path as filePath,
          mime_type as mimeType,
          width,
          height,
          bytes,
          sha256,
          metadata_json as metadataJson,
          created_at as createdAt
        FROM task_images
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(taskId) as TaskImageRecord[]
  }

  listTaskImagesForTasks(taskIds: string[]) {
    if (taskIds.length === 0) return []
    const placeholders = taskIds.map(() => '?').join(', ')
    return this.sqlite
      .prepare(`
        SELECT
          id,
          task_id as taskId,
          kind,
          file_path as filePath,
          mime_type as mimeType,
          width,
          height,
          bytes,
          sha256,
          metadata_json as metadataJson,
          created_at as createdAt
        FROM task_images
        WHERE task_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC
      `)
      .all(...taskIds) as TaskImageRecord[]
  }

  summarizeMediaStats() {
    const row = this.sqlite
      .prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'video_output' THEN 0 ELSE 1 END), 0) as imageCount,
          COALESCE(SUM(CASE WHEN kind = 'video_output' THEN 1 ELSE 0 END), 0) as videoCount,
          COALESCE(SUM(bytes), 0) as totalBytes
        FROM task_images
      `)
      .get() as MediaStatsRecord
    return row
  }

  getTaskImageByFilePath(filePath: string) {
    return this.sqlite
      .prepare(`
        SELECT
          task_images.id,
          task_images.task_id as taskId,
          task_images.kind,
          task_images.file_path as filePath,
          task_images.mime_type as mimeType,
          task_images.width,
          task_images.height,
          task_images.bytes,
          task_images.sha256,
          task_images.metadata_json as metadataJson,
          task_images.created_at as createdAt,
          tasks.owner_usage_code_id as ownerUsageCodeId,
          tasks.owner_kind as ownerKind
        FROM task_images
        INNER JOIN tasks ON tasks.id = task_images.task_id
        WHERE replace(task_images.file_path, char(92), '/') = ?
        LIMIT 1
      `)
      .get(filePath) as TaskImageAccessRecord | undefined
  }

  deleteTask(id: string) {
    this.sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
  }
}
