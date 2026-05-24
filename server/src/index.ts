import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { appConfig } from './config.js'
import { AppDatabase } from './lib/db.js'
import { encryptText } from './lib/crypto.js'
import { TaskEventBus } from './lib/eventBus.js'
import { getBackupJobState, getMaintenanceMessage } from './lib/maintenance.js'
import { TaskWorker } from './lib/taskWorker.js'
import { canAccessTask, getAuthContext } from './lib/auth.js'
import { authRoutes } from './routes/auth.js'
import { metaRoutes } from './routes/meta.js'
import { settingsRoutes } from './routes/settings.js'
import { taskRoutes } from './routes/tasks.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: typeof appConfig
    db: AppDatabase
    taskEvents: TaskEventBus
    taskWorker: TaskWorker
  }
}

const app = Fastify({
  logger: true,
  bodyLimit: 4 * 1024 * 1024 * 1024,
})

for (const dir of [
  appConfig.dataDir,
  appConfig.backupsDir,
  appConfig.backupImportsDir,
  appConfig.mediaDir,
  appConfig.uploadsDir,
  appConfig.masksDir,
  appConfig.outputsDir,
  appConfig.thumbsDir,
]) {
  fs.mkdirSync(dir, { recursive: true })
}

app.decorate('config', appConfig)
app.decorate('db', new AppDatabase(appConfig.dbPath))
app.decorate('taskEvents', new TaskEventBus())
app.decorate('taskWorker', new TaskWorker(app.db, app.taskEvents, {
  appSecret: appConfig.appSecret,
  mediaDir: appConfig.mediaDir,
  outputsDir: appConfig.outputsDir,
  thumbsDir: appConfig.thumbsDir,
  maxConcurrentTasks: app.db.getDistributionSettings().maxConcurrentTasks,
}))

app.addHook('preHandler', async (request, reply) => {
  const maintenance = getBackupJobState(app)
  const isReadOnlyMethod = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS'
  const isMaintenanceExempt = request.url.startsWith('/api/auth/admin/login')
    || request.url.startsWith('/api/auth/logout')

  if (maintenance.active && !isReadOnlyMethod && !isMaintenanceExempt) {
    reply.code(503)
    return reply.send({ message: getMaintenanceMessage() })
  }

  if (!request.url.startsWith('/media/')) return

  const url = new URL(request.url, 'http://local')
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/media\/+/, ''))
  const image = app.db.getTaskImageByFilePath(relativePath)
  if (!image) {
    reply.code(404)
    return reply.send({ message: '图片不存在' })
  }

  const auth = await getAuthContext(app, request)
  if (!auth) {
    reply.code(401)
    return reply.send({ message: '请先登录' })
  }

  if (!canAccessTask(auth, image)) {
    reply.code(403)
    return reply.send({ message: '无权访问该图片' })
  }
})

if (appConfig.bootstrapProvider && !app.db.getDefaultProviderProfile()) {
  app.db.upsertProviderProfile({
    id: 'env-default',
    name: '环境变量默认节点',
    baseUrl: appConfig.bootstrapProvider.baseUrl,
    apiKeyEncrypted: encryptText(appConfig.bootstrapProvider.apiKey, appConfig.appSecret),
    model: appConfig.bootstrapProvider.model,
    apiMode: appConfig.bootstrapProvider.apiMode,
    timeoutSeconds: appConfig.bootstrapProvider.timeoutSeconds,
    codexCli: appConfig.bootstrapProvider.codexCli,
    grokApiCompat: false,
    xaiImage2kEnabled: false,
    responseFormatB64Json: false,
    isDefault: true,
  })
}

await app.register(cors, {
  origin: appConfig.corsOrigin === '*' ? true : appConfig.corsOrigin,
})

await app.register(multipart, {
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024,
    files: 32,
  },
})

await app.register(fastifyStatic, {
  root: appConfig.mediaDir,
  prefix: '/media/',
})

const webIndexPath = path.join(appConfig.webDistDir, 'index.html')
const webIndexHtml = fs.existsSync(webIndexPath)
  ? fs.readFileSync(webIndexPath, 'utf8')
  : null
if (webIndexHtml) {
  await app.register(fastifyStatic, {
    root: appConfig.webDistDir,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
    index: false,
    setHeaders: (res, filePath) => {
      const filename = path.basename(filePath)
      if (filename === 'index.html' || filename === 'sw.js' || filename === 'manifest.webmanifest') {
        res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate')
        return
      }

      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  })

  app.get('/', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate')
    return reply.type('text/html; charset=utf-8').send(webIndexHtml)
  })
}

app.get('/health', async () => ({
  ok: true,
  now: new Date().toISOString(),
}))

await app.register(authRoutes)
await app.register(settingsRoutes)
await app.register(taskRoutes)
await app.register(metaRoutes)

if (webIndexHtml) {
  app.get('/*', async (request, reply) => {
    const accept = request.headers.accept ?? ''
    if (!accept.includes('text/html')) {
      return reply.code(404).send({ message: '未找到资源' })
    }
    reply.header('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate')
    return reply.type('text/html; charset=utf-8').send(webIndexHtml)
  })
}

for (const task of app.db.listActiveTasks()) {
  app.taskWorker.enqueue(task.id)
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error)
  const statusCode = reply.statusCode >= 400 ? reply.statusCode : 400
  reply.code(statusCode).send({
    message: error instanceof Error ? error.message : '未知错误',
  })
})

await app.listen({
  port: appConfig.port,
  host: appConfig.host,
})
