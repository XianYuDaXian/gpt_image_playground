import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  buildAuthStatus,
  clearSessionCookie,
  createSession,
  getAuthContext,
  getSessionToken,
  hashSecret,
  setSessionCookie,
  verifyAdminPassword,
} from '../lib/auth.js'

const adminLoginSchema = z.object({
  password: z.string().min(1),
})

const codeLoginSchema = z.object({
  code: z.string().min(1),
})

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const ADMIN_LOGIN_MAX_FAILURES = 8
const USAGE_CODE_MAX_FAILURES = 12

const authRateLimitStore = new Map<string, number[]>()

function getRateLimitKey(type: 'admin-login' | 'usage-code', ip: string) {
  return `${type}:${ip}`
}

function pruneRateLimitAttempts(attempts: number[], now: number) {
  return attempts.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)
}

function getClientIp(request: FastifyRequest) {
  return String(request.ip ?? '').trim() || 'unknown'
}

function ensureRateLimit(type: 'admin-login' | 'usage-code', ip: string, maxFailures: number) {
  const now = Date.now()
  const key = getRateLimitKey(type, ip)
  const attempts = pruneRateLimitAttempts(authRateLimitStore.get(key) ?? [], now)
  authRateLimitStore.set(key, attempts)
  if (attempts.length < maxFailures) return
  const retryAfterSeconds = Math.max(1, Math.ceil((attempts[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
  throw new Error(`尝试次数过多，请 ${retryAfterSeconds} 秒后再试`)
}

function recordRateLimitFailure(type: 'admin-login' | 'usage-code', ip: string) {
  const now = Date.now()
  const key = getRateLimitKey(type, ip)
  const attempts = pruneRateLimitAttempts(authRateLimitStore.get(key) ?? [], now)
  attempts.push(now)
  authRateLimitStore.set(key, attempts)
}

function clearRateLimitFailures(type: 'admin-login' | 'usage-code', ip: string) {
  authRateLimitStore.delete(getRateLimitKey(type, ip))
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const auth = await getAuthContext(app, request)
    return buildAuthStatus(app, auth)
  })

  app.post('/api/auth/admin/login', async (request, reply) => {
    const clientIp = getClientIp(request)
    try {
      ensureRateLimit('admin-login', clientIp, ADMIN_LOGIN_MAX_FAILURES)
    } catch (error) {
      reply.code(429)
      return { message: error instanceof Error ? error.message : '尝试次数过多，请稍后再试' }
    }
    const payload = adminLoginSchema.parse(request.body)
    if (!app.config.adminPassword) {
      reply.code(500)
      return { message: '服务端未配置 ADMIN_PASSWORD' }
    }
    if (!verifyAdminPassword(app, payload.password)) {
      recordRateLimitFailure('admin-login', clientIp)
      reply.code(401)
      return { message: '管理员密码错误' }
    }
    clearRateLimitFailures('admin-login', clientIp)

    const session = createSession(app, {
      role: 'admin',
      usageCodeId: null,
    })
    setSessionCookie(reply, session.token, session.expiresAt)
    return buildAuthStatus(app, {
      role: 'admin',
      sessionId: crypto.randomUUID(),
      usageCodeId: null,
      usageCode: null,
      usageCodeIds: [],
      usageCodes: [],
    })
  })

  app.post('/api/auth/code/login', async (request, reply) => {
    const clientIp = getClientIp(request)
    try {
      ensureRateLimit('usage-code', clientIp, USAGE_CODE_MAX_FAILURES)
    } catch (error) {
      reply.code(429)
      return { message: error instanceof Error ? error.message : '尝试次数过多，请稍后再试' }
    }
    const distribution = app.db.getDistributionSettings()
    if (!distribution.enabled) {
      reply.code(403)
      return { message: '管理员尚未开启分发功能' }
    }

    const payload = codeLoginSchema.parse(request.body)
    const codeHash = hashSecret(payload.code.trim(), app.config.appSecret)
    const usageCode = app.db.getUsageCodeByHash(codeHash)
    if (!usageCode || !usageCode.isEnabled) {
      recordRateLimitFailure('usage-code', clientIp)
      reply.code(401)
      return { message: '使用码无效或已停用' }
    }

    clearRateLimitFailures('usage-code', clientIp)
    app.db.markUsageCodeUsed(usageCode.id)
    const session = createSession(app, {
      role: 'user',
      usageCodeId: usageCode.id,
    })
    setSessionCookie(reply, session.token, session.expiresAt)
    return buildAuthStatus(app, {
      role: 'user',
      sessionId: crypto.randomUUID(),
      usageCodeId: usageCode.id,
      usageCode: app.db.getUsageCode(usageCode.id) ?? usageCode,
      usageCodeIds: [usageCode.id],
      usageCodes: [app.db.getUsageCode(usageCode.id) ?? usageCode],
    })
  })

  app.post('/api/auth/code/add', async (request, reply) => {
    const clientIp = getClientIp(request)
    try {
      ensureRateLimit('usage-code', clientIp, USAGE_CODE_MAX_FAILURES)
    } catch (error) {
      reply.code(429)
      return { message: error instanceof Error ? error.message : '尝试次数过多，请稍后再试' }
    }
    const auth = await getAuthContext(app, request)
    if (!auth || auth.role !== 'user') {
      reply.code(401)
      return { message: '请先使用使用码登录' }
    }

    const distribution = app.db.getDistributionSettings()
    if (!distribution.enabled) {
      reply.code(403)
      return { message: '管理员尚未开启分发功能' }
    }

    const payload = codeLoginSchema.parse(request.body)
    const codeHash = hashSecret(payload.code.trim(), app.config.appSecret)
    const usageCode = app.db.getUsageCodeByHash(codeHash)
    if (!usageCode || !usageCode.isEnabled) {
      recordRateLimitFailure('usage-code', clientIp)
      reply.code(401)
      return { message: '使用码无效或已停用' }
    }

    clearRateLimitFailures('usage-code', clientIp)
    app.db.addUsageCodeToAuthSession(auth.sessionId, usageCode.id)
    app.db.markUsageCodeUsed(usageCode.id)
    return buildAuthStatus(app, await getAuthContext(app, request))
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = getSessionToken(request)
    if (token) {
      app.db.deleteAuthSessionByHash(hashSecret(token, app.config.appSecret))
    }
    clearSessionCookie(reply)
    return { ok: true }
  })
}
