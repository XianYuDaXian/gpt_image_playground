import crypto from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
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

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const auth = await getAuthContext(app, request)
    return buildAuthStatus(app, auth)
  })

  app.post('/api/auth/admin/login', async (request, reply) => {
    const payload = adminLoginSchema.parse(request.body)
    if (!app.config.adminPassword) {
      reply.code(500)
      return { message: '服务端未配置 ADMIN_PASSWORD' }
    }
    if (!verifyAdminPassword(app, payload.password)) {
      reply.code(401)
      return { message: '管理员密码错误' }
    }

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
    const distribution = app.db.getDistributionSettings()
    if (!distribution.enabled) {
      reply.code(403)
      return { message: '管理员尚未开启分发功能' }
    }

    const payload = codeLoginSchema.parse(request.body)
    const codeHash = hashSecret(payload.code.trim(), app.config.appSecret)
    const usageCode = app.db.getUsageCodeByHash(codeHash)
    if (!usageCode || !usageCode.isEnabled) {
      reply.code(401)
      return { message: '使用码无效或已停用' }
    }

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
      reply.code(401)
      return { message: '使用码无效或已停用' }
    }

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
