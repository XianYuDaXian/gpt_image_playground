import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UsageCodeRecord } from './db.js'
import { decryptText } from './crypto.js'

const SESSION_COOKIE = 'gip_session'
const SESSION_TTL_DAYS = 30

export interface AuthContext {
  role: 'admin' | 'user'
  sessionId: string
  usageCodeId: string | null
  usageCode: UsageCodeRecord | null
  usageCodeIds: string[]
  usageCodes: UsageCodeRecord[]
}

export function getAllowedProviderProfileIds(auth: AuthContext) {
  if (auth.role === 'admin') return null
  if (auth.usageCodes.some((code) => !code.allowedProviderProfileIds?.length)) return null
  const ids = new Set<string>()
  for (const code of auth.usageCodes) {
    for (const id of code.allowedProviderProfileIds ?? []) {
      ids.add(id)
    }
  }
  return ids.size ? Array.from(ids) : []
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

function getUsageCodeDisplayValue(code: UsageCodeRecord, appSecret: string) {
  if (!code.codeEncrypted) return '无法恢复'
  try {
    return decryptText(code.codeEncrypted, appSecret)
  } catch {
    return '无法恢复'
  }
}

export function serializeUsageQuota(code: UsageCodeRecord, appSecret: string) {
  const hasProviderImageQuotas = Boolean(code.providerImageQuotas)
  const hasProviderVideoQuotas = Boolean(code.providerVideoQuotas)
  const providerRemainingImageCredits = code.providerImageQuotas
    ? Object.fromEntries(
        Object.entries(code.providerImageQuotas).map(([providerProfileId, quota]) => [
          providerProfileId,
          Math.max(0, quota - (code.providerUsedImageCredits?.[providerProfileId] ?? 0)),
        ]),
      )
    : null
  const remainingImageCredits = hasProviderImageQuotas
    ? Object.values(providerRemainingImageCredits ?? {}).reduce((sum, remaining) => sum + remaining, 0)
    : code.imageQuota == null
      ? null
      : Math.max(0, code.imageQuota - code.usedImageCredits)
  const providerRemainingVideoCredits = code.providerVideoQuotas
    ? Object.fromEntries(
        Object.entries(code.providerVideoQuotas).map(([providerProfileId, quota]) => [
          providerProfileId,
          Math.max(0, quota - (code.providerUsedVideoCredits?.[providerProfileId] ?? 0)),
        ]),
      )
    : null
  const remainingVideoCredits = hasProviderVideoQuotas
    ? Object.values(providerRemainingVideoCredits ?? {}).reduce((sum, remaining) => sum + remaining, 0)
    : code.videoQuota == null
      ? null
      : Math.max(0, code.videoQuota - code.usedVideoCredits)

  return {
    id: code.id,
    name: getUsageCodeDisplayValue(code, appSecret),
    allowedProviderProfileIds: code.allowedProviderProfileIds ?? null,
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
  }
}

export function serializeUsageCodeList(codes: UsageCodeRecord[], appSecret: string) {
  return codes.map((code) => serializeUsageQuota(code, appSecret))
}

function serializeAggregatedUser(codes: UsageCodeRecord[], appSecret: string) {
  if (codes.length === 0) return null
  const serializedCodes = codes.map((code) => serializeUsageQuota(code, appSecret))
  const hasUnlimited = serializedCodes.some((code) => code.imageQuota == null)
  const imageQuota = hasUnlimited
    ? null
    : serializedCodes.reduce((sum, code) => sum + (code.imageQuota ?? 0), 0)
  const usedImageCredits = serializedCodes.reduce((sum, code) => sum + code.usedImageCredits, 0)
  const remainingImageCredits = serializedCodes.some((code) => code.remainingImageCredits == null)
    ? null
    : serializedCodes.reduce((sum, code) => sum + (code.remainingImageCredits ?? 0), 0)
  const hasUnlimitedVideo = serializedCodes.some((code) => code.videoQuota == null)
  const videoQuota = hasUnlimitedVideo
    ? null
    : serializedCodes.reduce((sum, code) => sum + (code.videoQuota ?? 0), 0)
  const usedVideoCredits = serializedCodes.reduce((sum, code) => sum + code.usedVideoCredits, 0)
  const remainingVideoCredits = serializedCodes.some((code) => code.remainingVideoCredits == null)
    ? null
    : serializedCodes.reduce((sum, code) => sum + (code.remainingVideoCredits ?? 0), 0)

  return {
    id: codes[0]?.id ?? '',
    name: codes.length === 1 && codes[0] ? getUsageCodeDisplayValue(codes[0], appSecret) : `${codes.length} 个使用码`,
    allowedProviderProfileIds: null,
    imageQuota,
    usedImageCredits,
    remainingImageCredits,
    providerImageQuotas: null,
    providerUsedImageCredits: null,
    providerRemainingImageCredits: null,
    videoQuota,
    usedVideoCredits,
    remainingVideoCredits,
    providerVideoQuotas: null,
    providerUsedVideoCredits: null,
    providerRemainingVideoCredits: null,
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
      usageCodeIds: [],
      usageCodes: [],
    }
  }

  const distribution = app.db.getDistributionSettings()
  const usageCodes = app.db.listAuthSessionUsageCodes(session.id).filter((code) => Boolean(code.isEnabled))
  if (!distribution.enabled || usageCodes.length === 0) {
    app.db.deleteAuthSessionByHash(tokenHash)
    return null
  }

  app.db.touchAuthSession(session.id)
  const primaryCode = usageCodes[0] ?? null
  return {
    role: 'user',
    sessionId: session.id,
    usageCodeId: primaryCode?.id ?? null,
    usageCode: primaryCode,
    usageCodeIds: usageCodes.map((code) => code.id),
    usageCodes,
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
  return task.ownerKind === 'usage_code' && Boolean(task.ownerUsageCodeId && auth.usageCodeIds.includes(task.ownerUsageCodeId))
}

export function buildAuthStatus(app: FastifyInstance, auth: AuthContext | null) {
  const distribution = app.db.getDistributionSettings()
  return {
    authenticated: Boolean(auth),
    role: auth?.role ?? null,
    distributionEnabled: distribution.enabled,
    adminConfigured: Boolean(app.config.adminPassword),
    user: auth?.role === 'user' ? serializeAggregatedUser(auth.usageCodes, app.config.appSecret) : null,
    usageCodes: auth?.role === 'user' ? serializeUsageCodeList(auth.usageCodes, app.config.appSecret) : [],
  }
}
