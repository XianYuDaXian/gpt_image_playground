import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UsageCodeRecord } from './db.js'

const SESSION_COOKIE = 'gip_session'
const SESSION_TTL_DAYS = 30

export interface AuthContext {
  role: 'admin' | 'user'
  sessionId: string
  usageCodeId: string | null
  usageCode: UsageCodeRecord | null
}

export function hashSecret(value: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex')
}

export function createPlainUsageCode() {
  return crypto.randomBytes(9).toString('base64url').toUpperCase()
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (!rawName) continue
    cookies.set(rawName, decodeURIComponent(rawValue.join('=')))
  }

  return cookies
}

export function getSessionToken(request: FastifyRequest) {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE) ?? null
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}; Expires=${expiresAt.toUTCString()}`,
  )
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  )
}

export function createSession(app: FastifyInstance, input: {
  role: 'admin' | 'user'
  usageCodeId: string | null
}) {
  const token = createSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  app.db.createAuthSession({
    id: crypto.randomUUID(),
    tokenHash: hashSecret(token, app.config.appSecret),
    role: input.role,
    usageCodeId: input.usageCodeId,
    expiresAt: expiresAt.toISOString(),
  })

  return { token, expiresAt }
}

export function verifyAdminPassword(app: FastifyInstance, password: string) {
  const expected = app.config.adminPassword
  if (!expected) return false

  const actualBuffer = Buffer.from(password)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

export function serializeUsageQuota(code: UsageCodeRecord) {
  const remainingImageCredits = code.imageQuota == null
    ? null
    : Math.max(0, code.imageQuota - code.usedImageCredits)

  return {
    id: code.id,
    name: code.name,
    imageQuota: code.imageQuota,
    usedImageCredits: code.usedImageCredits,
    remainingImageCredits,
  }
}

export async function getAuthContext(app: FastifyInstance, request: FastifyRequest): Promise<AuthContext | null> {
  const token = getSessionToken(request)
  if (!token) return null

  app.db.deleteExpiredAuthSessions()
  const tokenHash = hashSecret(token, app.config.appSecret)
  const session = app.db.getAuthSessionByHash(tokenHash)
  if (!session) return null

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    app.db.deleteAuthSessionByHash(tokenHash)
    return null
  }

  if (session.role === 'admin') {
    app.db.touchAuthSession(session.id)
    return {
      role: 'admin',
      sessionId: session.id,
      usageCodeId: null,
      usageCode: null,
    }
  }

  const distribution = app.db.getDistributionSettings()
  const usageCode = session.usageCodeId ? app.db.getUsageCode(session.usageCodeId) : null
  if (!distribution.enabled || !usageCode?.isEnabled) {
    app.db.deleteAuthSessionByHash(tokenHash)
    return null
  }

  app.db.touchAuthSession(session.id)
  return {
    role: 'user',
    sessionId: session.id,
    usageCodeId: usageCode.id,
    usageCode,
  }
}

export async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  const auth = await getAuthContext(app, request)
  if (!auth) {
    reply.code(401)
    throw new Error('请先登录')
  }
  return auth
}

export async function requireAdmin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  const auth = await requireAuth(app, request, reply)
  if (auth.role !== 'admin') {
    reply.code(403)
    throw new Error('需要管理员权限')
  }
  return auth
}

export function canAccessTask(auth: AuthContext, task: { ownerKind: string; ownerUsageCodeId: string | null }) {
  if (auth.role === 'admin') return true
  return task.ownerKind === 'usage_code' && task.ownerUsageCodeId === auth.usageCodeId
}

export function buildAuthStatus(app: FastifyInstance, auth: AuthContext | null) {
  const distribution = app.db.getDistributionSettings()
  return {
    authenticated: Boolean(auth),
    role: auth?.role ?? null,
    distributionEnabled: distribution.enabled,
    adminConfigured: Boolean(app.config.adminPassword),
    user: auth?.usageCode ? serializeUsageQuota(auth.usageCode) : null,
  }
}
