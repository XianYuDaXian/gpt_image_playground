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
import { TaskWorker } from './lib/taskWorker.js'
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
  bodyLimit: 512 * 1024 * 1024,
})

for (const dir of [
  appConfig.dataDir,
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
}))

if (appConfig.bootstrapProvider) {
  app.db.upsertProviderProfile({
    id: 'env-default',
    name: '环境变量默认节点',
    baseUrl: appConfig.bootstrapProvider.baseUrl,
    apiKeyEncrypted: encryptText(appConfig.bootstrapProvider.apiKey, appConfig.appSecret),
    model: appConfig.bootstrapProvider.model,
    apiMode: appConfig.bootstrapProvider.apiMode,
    timeoutSeconds: appConfig.bootstrapProvider.timeoutSeconds,
    isDefault: true,
  })
  app.db.setAppSetting('runtime', {
    codexCli: appConfig.bootstrapProvider.codexCli,
  })
}

await app.register(cors, {
  origin: appConfig.corsOrigin === '*' ? true : appConfig.corsOrigin,
})

await app.register(multipart, {
  limits: {
    fileSize: 512 * 1024 * 1024,
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
  })

  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(webIndexHtml)
  })
}

app.get('/health', async () => ({
  ok: true,
  now: new Date().toISOString(),
}))

await app.register(settingsRoutes)
await app.register(taskRoutes)
await app.register(metaRoutes)

if (webIndexHtml) {
  app.get('/*', async (request, reply) => {
    const accept = request.headers.accept ?? ''
    if (!accept.includes('text/html')) {
      return reply.code(404).send({ message: '未找到资源' })
    }
    return reply.type('text/html; charset=utf-8').send(webIndexHtml)
  })
}

for (const task of app.db.listTasks(200)) {
  if (['queued', 'submitted', 'processing', 'downloading'].includes(task.status)) {
    app.taskWorker.enqueue(task.id)
  }
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error)
  reply.code(400).send({
    message: error instanceof Error ? error.message : '未知错误',
  })
})

await app.listen({
  port: appConfig.port,
  host: appConfig.host,
})
