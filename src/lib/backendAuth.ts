export type AuthRole = 'admin' | 'user'

export interface AuthUsageCode {
  id: string
  /** 普通用户侧显示的是使用码本身，不是管理员备注名。 */
  name: string
  imageQuota: number | null
  usedImageCredits: number
  remainingImageCredits: number | null
}

export interface AuthStatus {
  authenticated: boolean
  role: AuthRole | null
  distributionEnabled: boolean
  adminConfigured: boolean
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
