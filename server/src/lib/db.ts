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
  createdAt: string
  updatedAt: string
  finishedAt: string | null
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
    `)
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
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `).run({
        ...input,
        isDefault: input.isDefault ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
    })

    tx()
    return this.getProviderProfile(input.id)
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

  createTask(input: {
    id: string
    prompt: string
    paramsJson: string
    providerProfileId: string | null
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
        created_at,
        updated_at,
        finished_at
      )
      VALUES (?, ?, 'queued', 5, 'queued', ?, NULL, ?, ?, ?, NULL)
    `).run(input.id, input.prompt, input.paramsJson, input.providerProfileId, now, now)

    return this.getTask(input.id)
  }

  listTasks(limit = 50) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          prompt,
          status,
          progress_percent as progressPercent,
          current_step as currentStep,
          params_json as paramsJson,
          error_message as errorMessage,
          provider_profile_id as providerProfileId,
          created_at as createdAt,
          updated_at as updatedAt,
          finished_at as finishedAt
        FROM tasks
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit) as TaskRecord[]
  }

  getTask(id: string) {
    return this.sqlite
      .prepare(`
        SELECT
          id,
          prompt,
          status,
          progress_percent as progressPercent,
          current_step as currentStep,
          params_json as paramsJson,
          error_message as errorMessage,
          provider_profile_id as providerProfileId,
          created_at as createdAt,
          updated_at as updatedAt,
          finished_at as finishedAt
        FROM tasks
        WHERE id = ?
      `)
      .get(id) as TaskRecord | undefined
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
    this.sqlite.prepare(`
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
    const result = this.sqlite.prepare(`
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
      createdAt: string
      updatedAt: string
      finishedAt: string | null
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
          created_at,
          updated_at,
          finished_at
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
          @createdAt,
          @updatedAt,
          @finishedAt
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
        insertTask.run(task)
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
      this.sqlite.prepare('DELETE FROM task_events').run()
      this.sqlite.prepare('DELETE FROM task_images').run()
      this.sqlite.prepare('DELETE FROM tasks').run()
      this.sqlite.prepare('DELETE FROM app_settings').run()
      this.sqlite.prepare('DELETE FROM provider_profiles').run()
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

  deleteTask(id: string) {
    this.sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
  }
}
