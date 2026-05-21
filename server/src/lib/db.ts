import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { TaskEventRecord } from './eventBus.js'

export interface ProviderProfileRecord {
  id: string
  name: string
  baseUrl: string
  apiKeyEncrypted: string
  model: string
  apiMode: 'images' | 'responses' | 'videos'
  timeoutSeconds: number
  codexCli: number
  grokApiCompat: number
  xaiImage2kEnabled: number
  responseFormatB64Json: number
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
  ownerUsageCodeTaskCount: number | null
  ownerUsageCodeOutputImageCount: number | null
  reservedImageCredits: number
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  isFavorite: number
  isArchived: number
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

export interface UsageCodeRecord {
  id: string
  name: string
  codeHash: string
  codeEncrypted: string | null
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
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface UsageCodeStatsRecord extends UsageCodeRecord {
  taskCount: number
  outputImageCount: number
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

function selectUsageCodeFields() {
  return `
          id,
          code_hash as codeHash,
          code_encrypted as codeEncrypted,
          name,
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
        base_url TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        model TEXT NOT NULL,
        api_mode TEXT NOT NULL,
        timeout_seconds INTEGER NOT NULL,
        codex_cli INTEGER NOT NULL DEFAULT 0,
        grok_api_compat INTEGER NOT NULL DEFAULT 0,
        xai_image_2k_enabled INTEGER NOT NULL DEFAULT 0,
        response_format_b64_json INTEGER NOT NULL DEFAULT 0,
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
    const usageCodeColumns = this.sqlite.prepare('PRAGMA table_info(usage_codes)').all() as Array<{ name: string }>
    const usageCodeColumnNames = new Set(usageCodeColumns.map((column) => column.name))
    if (!usageCodeColumnNames.has('code_encrypted')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN code_encrypted TEXT')
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
  }

  listProviderProfiles() {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        ORDER BY is_default DESC, updated_at DESC
      `)
      .all() as ProviderProfileRecord[]
  }

  getProviderProfile(id: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        WHERE id = ?
      `)
      .get(id) as ProviderProfileRecord | undefined
  }

  getDefaultProviderProfile() {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          name,
          base_url as baseUrl,
          api_key_encrypted as apiKeyEncrypted,
          model,
          api_mode as apiMode,
          timeout_seconds as timeoutSeconds,
          codex_cli as codexCli,
          grok_api_compat as grokApiCompat,
          xai_image_2k_enabled as xaiImage2kEnabled,
          response_format_b64_json as responseFormatB64Json,
          is_default as isDefault,
          created_at as createdAt,
          updated_at as updatedAt
        FROM provider_profiles
        WHERE is_default = 1
        LIMIT 1
      `)
      .get() as ProviderProfileRecord | undefined
  }

  upsertProviderProfile(input: {
    id: string
    name: string
    baseUrl: string
    apiKeyEncrypted: string
    model: string
    apiMode: 'images' | 'responses' | 'videos'
    timeoutSeconds: number
    codexCli?: boolean
    grokApiCompat?: boolean
    xaiImage2kEnabled?: boolean
    responseFormatB64Json?: boolean
    isDefault: boolean
  }) {
    const now = new Date().toISOString()
    const tx = this.sqlite.transaction(() => {
      if (input.isDefault) {
        this.sqlite.prepare('UPDATE provider_profiles SET is_default = 0').run()
      }

      this.sqlite.prepare(`
        INSERT INTO provider_profiles (
          id,
          name,
          base_url,
          api_key_encrypted,
          model,
          api_mode,
          timeout_seconds,
          codex_cli,
          grok_api_compat,
          xai_image_2k_enabled,
          response_format_b64_json,
          is_default,
          created_at,
          updated_at
        )
        VALUES (
          @id,
          @name,
          @baseUrl,
          @apiKeyEncrypted,
          @model,
          @apiMode,
          @timeoutSeconds,
          @codexCli,
          @grokApiCompat,
          @xaiImage2kEnabled,
          @responseFormatB64Json,
          @isDefault,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          base_url = excluded.base_url,
          api_key_encrypted = excluded.api_key_encrypted,
          model = excluded.model,
          api_mode = excluded.api_mode,
          timeout_seconds = excluded.timeout_seconds,
          codex_cli = excluded.codex_cli,
          grok_api_compat = excluded.grok_api_compat,
          xai_image_2k_enabled = excluded.xai_image_2k_enabled,
          response_format_b64_json = excluded.response_format_b64_json,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `).run({
        ...input,
        codexCli: input.codexCli ? 1 : 0,
        grokApiCompat: input.grokApiCompat ? 1 : 0,
        xaiImage2kEnabled: input.xaiImage2kEnabled ? 1 : 0,
        responseFormatB64Json: input.responseFormatB64Json ? 1 : 0,
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
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, NULL, ?, ?, 0, NULL, 0, ?, ?, NULL)
    `).run(
      input.id,
      input.codeHash,
      input.codeEncrypted,
      input.name,
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
    const nextImageQuota = input.imageQuota === undefined ? current.imageQuota : input.imageQuota
    const nextVideoQuota = input.videoQuota === undefined ? current.videoQuota : input.videoQuota
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET
        name = ?,
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
      input.allowedProviderProfileIds === undefined
        ? stringifyAllowedProviderProfileIds(current.allowedProviderProfileIds)
        : stringifyAllowedProviderProfileIds(input.allowedProviderProfileIds),
      input.isEnabled == null ? current.isEnabled : input.isEnabled ? 1 : 0,
      nextImageQuota,
      input.providerImageQuotas === undefined
        ? stringifyProviderImageQuotaMap(current.providerImageQuotas)
        : stringifyProviderImageQuotaMap(input.providerImageQuotas),
      nextVideoQuota,
      input.providerVideoQuotas === undefined
        ? stringifyProviderImageQuotaMap(current.providerVideoQuotas)
        : stringifyProviderImageQuotaMap(input.providerVideoQuotas),
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
    apiMode: 'images' | 'responses' | 'videos'
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
          usage_quota_events.created_at as createdAt
        FROM usage_quota_events
        LEFT JOIN provider_profiles ON provider_profiles.id = usage_quota_events.provider_profile_id
        WHERE usage_quota_events.usage_code_id = ?
        ORDER BY usage_quota_events.id DESC
        LIMIT ?
      `)
      .all(usageCodeId, limit) as UsageQuotaEventRecord[]
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
          usage_codes.created_at as createdAt,
          usage_codes.updated_at as updatedAt,
          usage_codes.last_used_at as lastUsedAt,
          auth_session_usage_codes.created_at as sessionUsageCreatedAt
        FROM auth_session_usage_codes
        INNER JOIN usage_codes ON usage_codes.id = auth_session_usage_codes.usage_code_id
        WHERE auth_session_usage_codes.session_id = ?
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
      const remaining = code.imageQuota == null
        ? null
        : code.imageQuota - code.usedImageCredits
      if (remaining != null && remaining < input.credits) {
        throw new Error(`使用码剩余图片额度不足，当前剩余 ${Math.max(0, remaining)} 张`)
      }
      const providerQuota = code.providerImageQuotas?.[input.providerProfileId] ?? null
      const providerUsedCredits = code.providerUsedImageCredits?.[input.providerProfileId] ?? 0
      const providerRemaining = providerQuota == null
        ? null
        : providerQuota - providerUsedCredits
      if (providerRemaining != null && providerRemaining < input.credits) {
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
            remainingImageCredits: nextCode.imageQuota == null
              ? null
              : Math.max(0, nextCode.imageQuota - nextCode.usedImageCredits),
            providerRemainingImageCredits: nextCode.providerImageQuotas?.[input.providerProfileId] == null
              ? null
              : Math.max(
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
      const remaining = code.videoQuota == null
        ? null
        : code.videoQuota - code.usedVideoCredits
      if (remaining != null && remaining < input.credits) {
        throw new Error(`使用码剩余视频额度不足，当前剩余 ${Math.max(0, remaining)} 次`)
      }
      const providerQuota = code.providerVideoQuotas?.[input.providerProfileId] ?? null
      const providerUsedCredits = code.providerUsedVideoCredits?.[input.providerProfileId] ?? 0
      const providerRemaining = providerQuota == null
        ? null
        : providerQuota - providerUsedCredits
      if (providerRemaining != null && providerRemaining < input.credits) {
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
            remainingVideoCredits: nextCode.videoQuota == null
              ? null
              : Math.max(0, nextCode.videoQuota - nextCode.usedVideoCredits),
            providerRemainingVideoCredits: nextCode.providerVideoQuotas?.[input.providerProfileId] == null
              ? null
              : Math.max(
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
        const prevQuota = code.imageQuota
        const prevRemaining = Math.max(0, prevQuota - code.usedImageCredits)
        const nextQuota = input.action === 'increase'
          ? code.imageQuota + input.credits
          : Math.max(code.usedImageCredits, code.imageQuota - input.credits)
        const nextRemaining = Math.max(0, nextQuota - code.usedImageCredits)
        this.sqlite.prepare(`
          UPDATE usage_codes
          SET image_quota = ?, updated_at = ?
          WHERE id = ?
        `).run(nextQuota, now, input.usageCodeId)
        this.insertUsageQuotaEvent({
          usageCodeId: input.usageCodeId,
          eventType: input.action === 'increase' ? 'admin_increase' : 'admin_decrease',
          credits: input.credits,
          reason: `总额度 ${prevQuota} -> ${nextQuota}；总剩余 ${prevRemaining} -> ${nextRemaining}`,
          createdAt: now,
        })
      } else {
        const providerUsedImageCredits = code.providerUsedImageCredits?.[input.providerProfileId] ?? 0
        const nextProviderImageQuotas = { ...(code.providerImageQuotas ?? {}) }
        const currentProviderQuota = nextProviderImageQuotas[input.providerProfileId] ?? providerUsedImageCredits
        const prevImageQuota = code.imageQuota ?? 0
        const prevTotalRemaining = Math.max(0, prevImageQuota - code.usedImageCredits)
        const prevProviderRemaining = Math.max(0, currentProviderQuota - providerUsedImageCredits)
        const nextProviderQuota = input.action === 'increase'
          ? currentProviderQuota + input.credits
          : Math.max(providerUsedImageCredits, currentProviderQuota - input.credits)
        const nextProviderRemaining = Math.max(0, nextProviderQuota - providerUsedImageCredits)
        nextProviderImageQuotas[input.providerProfileId] = nextProviderQuota
        const normalizedProviderImageQuotas = Object.fromEntries(
          Object.entries(nextProviderImageQuotas).filter(([, quota]) => quota > 0),
        )
        const nextImageQuota = Object.values(normalizedProviderImageQuotas).reduce((sum, quota) => sum + quota, 0)
        const nextTotalRemaining = Math.max(0, nextImageQuota - code.usedImageCredits)
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
          reason: `端点额度 ${currentProviderQuota} -> ${nextProviderQuota}；端点剩余 ${prevProviderRemaining} -> ${nextProviderRemaining}；总额度 ${prevImageQuota} -> ${nextImageQuota}；总剩余 ${prevTotalRemaining} -> ${nextTotalRemaining}`,
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

  private taskOwnerStatsSelect() {
    return `
      usage_codes.created_at as ownerUsageCodeCreatedAt,
      usage_codes.code_encrypted as ownerUsageCodeCodeEncrypted,
      usage_codes.last_used_at as ownerUsageCodeLastUsedAt,
      usage_codes.image_quota as ownerUsageCodeImageQuota,
      usage_codes.used_image_credits as ownerUsageCodeUsedImageCredits,
      usage_codes.output_image_count as ownerUsageCodeOutputImageCount,
      (
        SELECT COUNT(*)
        FROM tasks owner_tasks
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeTaskCount
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
