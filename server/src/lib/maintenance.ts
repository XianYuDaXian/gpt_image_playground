import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

export type BackupPhase = 'idle' | 'preparing' | 'running' | 'completed' | 'failed'
export type MaintenanceOperation =
  | 'backup_export'
  | 'backup_import'
  | 'usage_code_media_export'
  | 'remote_reset_usage_code'
  | 'remote_reset_admin'
  | 'remote_reset_tasks'
  | 'remote_reset_all'
  | null

export interface BackupJobState {
  active: boolean
  operation: MaintenanceOperation
  phase: BackupPhase
  message: string
  progressPercent: number
  startedAt: string | null
  finishedAt: string | null
  totalFiles: number
  processedFiles: number
  totalBytes: number
  processedBytes: number
  waitingRunningTasks: number
  waitingPendingTasks: number
  filename: string | null
  filePath: string | null
  error: string | null
}

export interface ManagementOperationLog {
  id: string
  operation: Exclude<MaintenanceOperation, null>
  status: 'completed' | 'failed'
  title: string
  detail: string
  createdAt: string
}

const BACKUP_JOB_STATE_KEY = 'backup_job_state'
const MANAGEMENT_OPERATION_LOGS_KEY = 'management_operation_logs'
const USAGE_CODE_MEDIA_EXPORT_STATE_KEY_PREFIX = 'usage_code_media_export_state:'

export function getDefaultBackupJobState(): BackupJobState {
  return {
    active: false,
    operation: null,
    phase: 'idle',
    message: '',
    progressPercent: 0,
    startedAt: null,
    finishedAt: null,
    totalFiles: 0,
    processedFiles: 0,
    totalBytes: 0,
    processedBytes: 0,
    waitingRunningTasks: 0,
    waitingPendingTasks: 0,
    filename: null,
    filePath: null,
    error: null,
  }
}

function normalizeBackupJobState(stored: Partial<BackupJobState> | null | undefined) {
  return {
    ...getDefaultBackupJobState(),
    ...stored,
    active: Boolean(stored?.active),
    phase: stored?.phase ?? 'idle',
    message: stored?.message?.trim() ?? '',
    progressPercent: Math.max(0, Math.min(100, Math.floor(Number(stored?.progressPercent) || 0))),
    totalFiles: Math.max(0, Math.floor(Number(stored?.totalFiles) || 0)),
    processedFiles: Math.max(0, Math.floor(Number(stored?.processedFiles) || 0)),
    totalBytes: Math.max(0, Math.floor(Number(stored?.totalBytes) || 0)),
    processedBytes: Math.max(0, Math.floor(Number(stored?.processedBytes) || 0)),
    waitingRunningTasks: Math.max(0, Math.floor(Number(stored?.waitingRunningTasks) || 0)),
    waitingPendingTasks: Math.max(0, Math.floor(Number(stored?.waitingPendingTasks) || 0)),
    filename: stored?.filename?.trim() ?? null,
    filePath: stored?.filePath?.trim() ?? null,
    error: stored?.error?.trim() ?? null,
  }
}

export function getBackupJobState(app: FastifyInstance): BackupJobState {
  const stored = app.db.getAppSetting<Partial<BackupJobState>>(BACKUP_JOB_STATE_KEY)
  return normalizeBackupJobState(stored)
}

export function setBackupJobState(app: FastifyInstance, state: BackupJobState) {
  app.db.setAppSetting(BACKUP_JOB_STATE_KEY, state)
}

export function patchBackupJobState(app: FastifyInstance, patch: Partial<BackupJobState>) {
  const nextState = {
    ...getBackupJobState(app),
    ...patch,
  }
  setBackupJobState(app, nextState)
  return nextState
}

export function getUsageCodeMediaExportStateKey(usageCodeIds: string[]) {
  const normalized = [...usageCodeIds].filter(Boolean).sort().join(',')
  const digest = crypto.createHash('sha256').update(normalized).digest('hex')
  return `${USAGE_CODE_MEDIA_EXPORT_STATE_KEY_PREFIX}${digest}`
}

export function getUsageCodeMediaExportState(app: FastifyInstance, usageCodeIds: string[]): BackupJobState {
  const stored = app.db.getAppSetting<Partial<BackupJobState>>(getUsageCodeMediaExportStateKey(usageCodeIds))
  return normalizeBackupJobState(stored)
}

export function setUsageCodeMediaExportState(app: FastifyInstance, usageCodeIds: string[], state: BackupJobState) {
  app.db.setAppSetting(getUsageCodeMediaExportStateKey(usageCodeIds), state)
}

export function patchUsageCodeMediaExportState(app: FastifyInstance, usageCodeIds: string[], patch: Partial<BackupJobState>) {
  const nextState = {
    ...getUsageCodeMediaExportState(app, usageCodeIds),
    ...patch,
  }
  setUsageCodeMediaExportState(app, usageCodeIds, nextState)
  return nextState
}

export function getMaintenanceMessage() {
  return '管理员正在维护服务器，请稍等几分钟'
}

export function listManagementOperationLogs(app: FastifyInstance, limit = 20) {
  const items = app.db.getAppSetting<ManagementOperationLog[]>(MANAGEMENT_OPERATION_LOGS_KEY)
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is ManagementOperationLog =>
      Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.createdAt === 'string'),
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
}

export function appendManagementOperationLog(app: FastifyInstance, input: Omit<ManagementOperationLog, 'id'>) {
  const nextItem: ManagementOperationLog = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ...input,
  }
  const existing = listManagementOperationLogs(app, 100)
  app.db.setAppSetting(MANAGEMENT_OPERATION_LOGS_KEY, [nextItem, ...existing].slice(0, 100))
  return nextItem
}
