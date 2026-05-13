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
  apiMode: 'images' | 'responses'
  timeoutSeconds: number
  responseFormatB64Json: number
  isDefault: number
  createdAt: string
  updatedAt: string
}

export interface TaskRecord {
  id: string
  prompt: string
  status: string
  progressPercent: number
  currentStep: string
  paramsJson: string
  errorMessage: string | null
  providerProfileId: string | null
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
  kind: 'input' | 'mask' | 'output' | 'thumb'
  filePath: string
  mimeType: string
  width: number | null
  height: number | null
  bytes: number
  sha256: string
  createdAt: string
}

export interface UsageCodeRecord {
  id: string
  name: string
  codeHash: string
  codeEncrypted: string | null
  isEnabled: number
  imageQuota: number | null
  usedImageCredits: number
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface UsageCodeStatsRecord extends UsageCodeRecord {
  taskCount: number
  outputImageCount: number
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

export interface DistributionSettings {
  enabled: boolean
  maxConcurrentTasks: number
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
        status TEXT NOT NULL,
        progress_percent INTEGER NOT NULL,
        current_step TEXT NOT NULL,
        params_json TEXT NOT NULL,
        error_message TEXT,
        provider_profile_id TEXT,
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
        is_enabled INTEGER NOT NULL DEFAULT 1,
        image_quota INTEGER,
        used_image_credits INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS usage_quota_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usage_code_id TEXT NOT NULL,
        task_id TEXT,
        event_type TEXT NOT NULL,
        credits INTEGER NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(usage_code_id) REFERENCES usage_codes(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_quota_events_task_type
      ON usage_quota_events(task_id, event_type) WHERE task_id IS NOT NULL;
    `)

    const taskColumns = this.sqlite.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    const taskColumnNames = new Set(taskColumns.map((column) => column.name))
    if (!taskColumnNames.has('is_favorite')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0')
    }
    if (!taskColumnNames.has('is_archived')) {
      this.sqlite.exec('ALTER TABLE tasks ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0')
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
    if (!profileColumnNames.has('response_format_b64_json')) {
      this.sqlite.exec('ALTER TABLE provider_profiles ADD COLUMN response_format_b64_json INTEGER NOT NULL DEFAULT 0')
    }
    const usageCodeColumns = this.sqlite.prepare('PRAGMA table_info(usage_codes)').all() as Array<{ name: string }>
    const usageCodeColumnNames = new Set(usageCodeColumns.map((column) => column.name))
    if (!usageCodeColumnNames.has('code_encrypted')) {
      this.sqlite.exec('ALTER TABLE usage_codes ADD COLUMN code_encrypted TEXT')
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
    apiMode: 'images' | 'responses'
    timeoutSeconds: number
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
          response_format_b64_json = excluded.response_format_b64_json,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `).run({
        ...input,
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
  }) {
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      INSERT INTO usage_codes (
        id,
        code_hash,
        code_encrypted,
        name,
        is_enabled,
        image_quota,
        used_image_credits,
        created_at,
        updated_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, NULL)
    `).run(input.id, input.codeHash, input.codeEncrypted, input.name, input.imageQuota, now, now)
    return this.getUsageCode(input.id)
  }

  getUsageCode(id: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          code_hash as codeHash,
          code_encrypted as codeEncrypted,
          name,
          is_enabled as isEnabled,
          image_quota as imageQuota,
          used_image_credits as usedImageCredits,
          created_at as createdAt,
          updated_at as updatedAt,
          last_used_at as lastUsedAt
        FROM usage_codes
        WHERE id = ?
      `)
      .get(id) as UsageCodeRecord | undefined
  }

  getUsageCodeByHash(codeHash: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          code_hash as codeHash,
          code_encrypted as codeEncrypted,
          name,
          is_enabled as isEnabled,
          image_quota as imageQuota,
          used_image_credits as usedImageCredits,
          created_at as createdAt,
          updated_at as updatedAt,
          last_used_at as lastUsedAt
        FROM usage_codes
        WHERE code_hash = ?
      `)
      .get(codeHash) as UsageCodeRecord | undefined
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
  }) {
    const current = this.getUsageCode(input.id)
    if (!current) return null
    const now = new Date().toISOString()
    this.sqlite.prepare(`
      UPDATE usage_codes
      SET
        name = ?,
        is_enabled = ?,
        image_quota = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? current.name,
      input.isEnabled == null ? current.isEnabled : input.isEnabled ? 1 : 0,
      input.imageQuota === undefined ? current.imageQuota : input.imageQuota,
      now,
      input.id,
    )
    return this.getUsageCode(input.id)
  }

  deleteUsageCode(id: string) {
    const current = this.getUsageCode(id)
    if (!current) return false
    const tx = this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM auth_sessions WHERE usage_code_id = ?').run(id)
      this.sqlite.prepare(`
        UPDATE tasks
        SET owner_usage_code_id = NULL,
            owner_kind = 'usage_code',
            updated_at = ?
        WHERE owner_usage_code_id = ?
      `).run(new Date().toISOString(), id)
      this.sqlite.prepare('DELETE FROM usage_quota_events WHERE usage_code_id = ?').run(id)
      this.sqlite.prepare('DELETE FROM usage_codes WHERE id = ?').run(id)
    })
    tx()
    return true
  }

  listUsageCodesWithStats() {
    return this.sqlite
      .prepare(`
        SELECT
          usage_codes.id,
          usage_codes.code_hash as codeHash,
          usage_codes.code_encrypted as codeEncrypted,
          usage_codes.name,
          usage_codes.is_enabled as isEnabled,
          usage_codes.image_quota as imageQuota,
          usage_codes.used_image_credits as usedImageCredits,
          usage_codes.created_at as createdAt,
          usage_codes.updated_at as updatedAt,
          usage_codes.last_used_at as lastUsedAt,
          COUNT(DISTINCT tasks.id) as taskCount,
          COUNT(task_images.id) as outputImageCount
        FROM usage_codes
        LEFT JOIN tasks ON tasks.owner_usage_code_id = usage_codes.id
        LEFT JOIN task_images ON task_images.task_id = tasks.id AND task_images.kind = 'output'
        GROUP BY usage_codes.id
        ORDER BY usage_codes.created_at DESC
      `)
      .all() as UsageCodeStatsRecord[]
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
    return this.getAuthSessionByHash(input.tokenHash)
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
        throw new Error(`使用码剩余额度不足，当前剩余 ${Math.max(0, remaining)} 次`)
      }

      const now = new Date().toISOString()
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_image_credits = used_image_credits + ?, updated_at = ?, last_used_at = ?
        WHERE id = ?
      `).run(input.credits, now, now, input.usageCodeId)
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          created_at
        )
        VALUES (?, ?, 'reserve', ?, 'task_create', ?)
      `).run(input.usageCodeId, input.taskId, input.credits, now)

      const nextCode = this.getUsageCode(input.usageCodeId)
      return nextCode
        ? {
            usedImageCredits: nextCode.usedImageCredits,
            remainingImageCredits: nextCode.imageQuota == null
              ? null
              : Math.max(0, nextCode.imageQuota - nextCode.usedImageCredits),
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
      this.sqlite.prepare(`
        UPDATE usage_codes
        SET used_image_credits = MAX(0, used_image_credits - ?), updated_at = ?
        WHERE id = ?
      `).run(input.credits, now, input.usageCodeId)
      this.sqlite.prepare(`
        INSERT INTO usage_quota_events (
          usage_code_id,
          task_id,
          event_type,
          credits,
          reason,
          created_at
        )
        VALUES (?, ?, 'refund', ?, ?, ?)
      `).run(input.usageCodeId, input.taskId, input.credits, input.reason, now)
      return true
    })

    return tx()
  }

  refundTaskQuota(taskId: string, reason: string) {
    const task = this.getTask(taskId)
    if (!task?.ownerUsageCodeId || task.ownerKind !== 'usage_code' || task.reservedImageCredits <= 0) {
      return false
    }
    return this.refundUsageCreditsForTask({
      usageCodeId: task.ownerUsageCodeId,
      taskId,
      credits: task.reservedImageCredits,
      reason,
    })
  }

  createTask(input: {
    id: string
    prompt: string
    paramsJson: string
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
      VALUES (?, ?, 'queued', 5, 'queued', ?, NULL, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      input.id,
      input.prompt,
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

  listTasks(limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
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
      (
        SELECT COUNT(*)
        FROM tasks owner_tasks
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeTaskCount,
      (
        SELECT COUNT(task_images.id)
        FROM tasks owner_tasks
        INNER JOIN task_images ON task_images.task_id = owner_tasks.id AND task_images.kind = 'output'
        WHERE owner_tasks.owner_usage_code_id = tasks.owner_usage_code_id
      ) as ownerUsageCodeOutputImageCount
    `
  }

  listTasksForUsageCode(usageCodeId: string, limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
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

  getTask(id: string) {
    return this.sqlite
      .prepare(`
        SELECT
          tasks.id,
          tasks.prompt,
          tasks.status,
          tasks.progress_percent as progressPercent,
          tasks.current_step as currentStep,
          tasks.params_json as paramsJson,
          tasks.error_message as errorMessage,
          tasks.provider_profile_id as providerProfileId,
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
  }) {
    const now = new Date().toISOString()
    const result = this.sqlite.prepare(`
      UPDATE tasks
      SET
        status = @status,
        progress_percent = @progressPercent,
        current_step = @currentStep,
        error_message = @errorMessage,
        updated_at = @updatedAt,
        finished_at = @finishedAt
      WHERE id = @id
    `).run({
      ...input,
      errorMessage: input.errorMessage ?? null,
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
    kind: 'input' | 'mask' | 'output' | 'thumb'
    filePath: string
    mimeType: string
    width?: number | null
    height?: number | null
    bytes: number
    sha256: string
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
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      status: string
      progressPercent: number
      currentStep: string
      paramsJson: string
      errorMessage: string | null
      providerProfileId: string | null
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
      kind: 'input' | 'mask' | 'output' | 'thumb'
      filePath: string
      mimeType: string
      width: number | null
      height: number | null
      bytes: number
      sha256: string
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
          finished_at,
          is_favorite,
          is_archived
        )
        VALUES (
          @id,
          @prompt,
          @status,
          @progressPercent,
          @currentStep,
          @paramsJson,
          @errorMessage,
          @providerProfileId,
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
          @createdAt
        )
      `)

      for (const task of input.tasks) {
        insertTask.run({
          ...task,
          ownerUsageCodeId: task.ownerUsageCodeId ?? null,
          ownerKind: task.ownerKind ?? 'legacy',
          reservedImageCredits: task.reservedImageCredits ?? 0,
          isFavorite: task.isFavorite ? 1 : 0,
          isArchived: task.isArchived ? 1 : 0,
        })
      }
      for (const image of input.taskImages) {
        insertTaskImage.run(image)
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
