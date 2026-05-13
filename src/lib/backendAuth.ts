export type AuthRole = 'admin' | 'user'

export interface AuthStatus {
  authenticated: boolean
  role: AuthRole | null
  distributionEnabled: boolean
  adminConfigured: boolean
  user: {
    id: string
    name: string
    imageQuota: number | null
    usedImageCredits: number
    remainingImageCredits: number | null
  } | null
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

export async function logoutAuth() {
  const response = await fetch('/api/auth/logout', { method: 'POST' })
  return readResponseJson<{ ok: true }>(response)
}
