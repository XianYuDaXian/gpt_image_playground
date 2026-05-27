export type AuthRole = 'admin' | 'user'

export interface MaintenanceStatus {
  active: boolean
  operation:
    | 'backup_export'
    | 'backup_import'
    | 'remote_reset_usage_code'
    | 'remote_reset_tasks'
    | 'remote_reset_all'
    | null
  phase: 'idle' | 'preparing' | 'running' | 'completed' | 'failed'
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

export interface AuthUsageCode {
  id: string
  /** 普通用户侧显示的是使用码本身，不是管理员备注名。 */
  name: string
  userTier: 'free' | 'paid'
  allowedProviderProfileIds: string[] | null
  imageQuota: number | null
  usedImageCredits: number
  remainingImageCredits: number | null
  providerImageQuotas: Record<string, number> | null
  providerUsedImageCredits: Record<string, number> | null
  providerRemainingImageCredits: Record<string, number> | null
  videoQuota: number | null
  usedVideoCredits: number
  remainingVideoCredits: number | null
  providerVideoQuotas: Record<string, number> | null
  providerUsedVideoCredits: Record<string, number> | null
  providerRemainingVideoCredits: Record<string, number> | null
  outputImageCount: number
  outputVideoCount: number
}

export interface AuthStatus {
  authenticated: boolean
  role: AuthRole | null
  distributionEnabled: boolean
  adminConfigured: boolean
  maintenance: MaintenanceStatus
  user: AuthUsageCode | null
  usageCodes: AuthUsageCode[]
}

async function readResponseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const payload = await response.json() as { message?: string }
      if (payload.message) message = payload.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export async function fetchAuthStatus() {
  const response = await fetch('/api/auth/status', { cache: 'no-store' })
  return readResponseJson<AuthStatus>(response)
}

export async function loginAdmin(password: string) {
  const response = await fetch('/api/auth/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return readResponseJson<AuthStatus>(response)
}

export async function loginWithCode(code: string) {
  const response = await fetch('/api/auth/code/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return readResponseJson<AuthStatus>(response)
}

export async function addSessionUsageCode(code: string) {
  const response = await fetch('/api/auth/code/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  return readResponseJson<AuthStatus>(response)
}

export async function logoutAuth() {
  const response = await fetch('/api/auth/logout', { method: 'POST' })
  return readResponseJson<{ ok: true }>(response)
}
