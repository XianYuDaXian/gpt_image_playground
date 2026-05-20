import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { buildAuthStatus, canAccessTask, getAllowedProviderProfileIds, requireAuth } from '../lib/auth.js'
import { serializeTaskRecord, loadSerializedTask } from '../lib/taskDto.js'
import type { TaskListEventRecord } from '../lib/eventBus.js'

const taskParamsSchema = z.object({
  size: z.string().default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.number().int().min(0).max(100).nullable().default(null),
  moderation: z.enum(['auto', 'low']).default('auto'),
  n: z.number().int().positive().max(16).default(1),
})

const taskFlagsSchema = z.object({
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
}).refine((value) => value.isFavorite !== undefined || value.isArchived !== undefined, {
  message: '至少需要更新一个任务状态',
})

function formatSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildStoredPath(kind: 'uploads' | 'masks', taskId: string, filename: string) {
  return path.join(kind, taskId, filename)
}

function resolveAbsoluteMediaPath(app: Parameters<FastifyPluginAsync>[0], relativePath: string) {
  return path.join(app.config.mediaDir, relativePath)
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  const serializeTask = (
    task: ReturnType<typeof app.db.getTask> extends infer T ? Exclude<T, undefined> : never,
    exposeUsageCodeAlias: boolean,
  ) => {
    const providerProfile = task.providerProfileId ? app.db.getProviderProfile(task.providerProfileId) : null
    return serializeTaskRecord(task, app.db.listTaskImages(task.id), {
      appSecret: app.config.appSecret,
      exposeUsageCodeAlias,
      providerProfile,
    })
  }

  app.post('/api/tasks', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const defaultProfile = app.db.getDefaultProviderProfile()
    if (!defaultProfile) {
      reply.code(400)
      return { message: '后端尚未配置默认 provider profile' }
    }

    const taskId = crypto.randomUUID()
    let prompt = ''
    let providerProfileId = defaultProfile.id
    let selectedUsageCodeId: string | null = null
    let parsedParams = taskParamsSchema.parse({})
    const pendingFiles: Array<{
      fieldname: string
      filename: string
      mimetype: string
      buffer: Buffer
    }> = []

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'prompt') {
          prompt = String(part.value ?? '').trim()
        }
        if (part.fieldname === 'params') {
          try {
            parsedParams = taskParamsSchema.parse(JSON.parse(String(part.value ?? '{}')))
          } catch {
            parsedParams = taskParamsSchema.parse({})
          }
        }
        if (part.fieldname === 'providerProfileId') {
          const value = String(part.value ?? '').trim()
          if (value) providerProfileId = value
        }
        if (part.fieldname === 'usageCodeId') {
          const value = String(part.value ?? '').trim()
          if (value) selectedUsageCodeId = value
        }
        continue
      }

      pendingFiles.push({
        fieldname: part.fieldname,
        filename: part.filename?.replace(/[^\w.-]+/g, '-') || `${crypto.randomUUID()}.png`,
        mimetype: part.mimetype || 'image/png',
        buffer: await part.toBuffer(),
      })
    }

    if (!prompt) {
      reply.code(400)
      return { message: '提示词不能为空' }
    }

    const providerProfile = app.db.getProviderProfile(providerProfileId)
    if (!providerProfile) {
      reply.code(400)
      return { message: 'API 配置不存在' }
    }
    if (auth.role === 'user') {
      const allowedProviderProfileIds = getAllowedProviderProfileIds(auth)
      if (allowedProviderProfileIds && !allowedProviderProfileIds.includes(providerProfile.id)) {
        reply.code(403)
        return { message: '当前使用码无权调用该 API 配置' }
      }
    }

    let reservedImageCredits = 0
    if (auth.role === 'user') {
      selectedUsageCodeId = selectedUsageCodeId || auth.usageCodeIds[0] || null
      if (!selectedUsageCodeId || !auth.usageCodeIds.includes(selectedUsageCodeId)) {
        reply.code(403)
        return { message: '使用码不可用' }
      }
      reservedImageCredits = parsedParams.n
      try {
        app.db.reserveUsageCreditsForTask({
          usageCodeId: selectedUsageCodeId,
          taskId,
          credits: reservedImageCredits,
          providerProfileId: providerProfile.id,
        })
      } catch (error) {
        reply.code(403)
        const baseMessage = error instanceof Error ? error.message : '使用码额度不足'
        if (baseMessage.includes('当前端点')) {
          return { message: `${providerProfile.name} 额度不足。${baseMessage}` }
        }
        return { message: baseMessage }
      }
    }

    const task = app.db.createTask({
      id: taskId,
      prompt,
      paramsJson: JSON.stringify(parsedParams),
      providerProfileId: providerProfile.id,
      ownerUsageCodeId: auth.role === 'user' ? selectedUsageCodeId : null,
      ownerKind: auth.role === 'user' ? 'usage_code' : 'admin',
      reservedImageCredits,
    })

    if (!task) {
      if (auth.role === 'user') {
        app.db.refundUsageCreditsForTask({
          usageCodeId: selectedUsageCodeId ?? '',
          taskId,
          credits: reservedImageCredits,
          reason: 'task_create_failed',
          providerProfileId: providerProfile.id,
        })
      }
      throw new Error('创建任务失败')
    }

    let maskImageId: string | null = null
    try {
      for (const file of pendingFiles) {
        const fileId = crypto.randomUUID()
        const kind = file.fieldname === 'mask' ? 'masks' : 'uploads'
        const relativePath = buildStoredPath(kind, taskId, file.filename)
        const absolutePath = resolveAbsoluteMediaPath(app, relativePath)

        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await fs.writeFile(absolutePath, file.buffer)

        app.db.addTaskImage({
          id: fileId,
          taskId,
          kind: file.fieldname === 'mask' ? 'mask' : 'input',
          filePath: relativePath,
          mimeType: file.mimetype,
          bytes: file.buffer.byteLength,
          sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
        })

        if (file.fieldname === 'mask') {
          maskImageId = fileId
        }
      }
    } catch (error) {
      app.db.refundTaskQuota(taskId, 'task_create_failed')
      throw error
    }

    const event = app.db.appendTaskEvent({
      taskId,
      status: 'queued',
      step: 'queued',
      percent: 5,
      message: maskImageId ? '任务已创建，等待带遮罩处理' : '任务已创建，等待执行',
    })
    if (event) {
      app.taskEvents.emit(taskId, event)
    }
    app.taskWorker.enqueue(taskId)

    reply.code(201)
    return {
      task: loadSerializedTask(app.db, taskId, { appSecret: app.config.appSecret, exposeUsageCodeAlias: auth.role === 'admin' }),
      event,
      auth: buildAuthStatus(app, await requireAuth(app, request, reply)),
    }
  })

  app.get('/api/tasks', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const tasks = auth.role === 'admin'
      ? app.db.listTasks(200)
      : app.db.listTasksForUsageCodes(auth.usageCodeIds, 200)
    return {
      items: tasks.map((task) =>
        serializeTask(task, auth.role === 'admin'),
      ),
    }
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const taskRecord = app.db.getTask(params.taskId)
    if (!taskRecord || !canAccessTask(auth, taskRecord)) {
      reply.code(404)
      return { message: '任务不存在' }
    }
    const task = loadSerializedTask(app.db, params.taskId, { appSecret: app.config.appSecret, exposeUsageCodeAlias: auth.role === 'admin' })

    return {
      task,
      events: app.db.listTaskEvents(params.taskId),
    }
  })

  app.patch('/api/tasks/:taskId', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const body = taskFlagsSchema.parse(request.body)
    const current = app.db.getTask(params.taskId)
    if (!current || !canAccessTask(auth, current)) {
      reply.code(404)
      return { message: '任务不存在' }
    }
    const task = app.db.updateTaskFlags({
      id: params.taskId,
      isFavorite: body.isFavorite,
      isArchived: body.isArchived,
    })

    if (!task) {
      reply.code(404)
      return { message: '任务不存在' }
    }

    const serializedTask = serializeTask(task, auth.role === 'admin')
    app.taskEvents.emitTaskChanged(task.id)
    return { task: serializedTask }
  })

  app.get('/api/tasks/events', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    const buildTaskList = () => {
      const tasks = auth.role === 'admin'
        ? app.db.listTasks(200)
        : app.db.listTasksForUsageCodes(auth.usageCodeIds, 200)
      return tasks.map((task) => serializeTask(task, auth.role === 'admin'))
    }

    reply.raw.write(formatSseEvent('snapshot', { tasks: buildTaskList() }))

    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n')
    }, 15000)

    const unsubscribe = app.taskEvents.subscribeAll((event: TaskListEventRecord) => {
      if (event.type === 'delete') {
        if (auth.role === 'user' && (!event.ownerUsageCodeId || !auth.usageCodeIds.includes(event.ownerUsageCodeId))) return
        reply.raw.write(formatSseEvent('task', event))
        return
      }

      const taskRecord = app.db.getTask(event.taskId)
      if (!taskRecord || !canAccessTask(auth, taskRecord)) {
        if (auth.role === 'user') return
        reply.raw.write(formatSseEvent('task', {
          type: 'delete',
          taskId: event.taskId,
        } satisfies TaskListEventRecord))
        return
      }
      const task = serializeTask(taskRecord, auth.role === 'admin')

      reply.raw.write(formatSseEvent('task', {
        type: 'upsert',
        task,
      }))
    })

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  app.delete('/api/tasks/:taskId', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const task = app.db.getTask(params.taskId)
    if (!task || !canAccessTask(auth, task)) {
      reply.code(404)
      return { message: '任务不存在' }
    }

    const images = app.db.listTaskImages(params.taskId)
    app.taskWorker.cancel(params.taskId)
    if (task.status !== 'succeeded') {
      app.db.refundTaskQuota(params.taskId, 'task_deleted')
    }
    app.db.deleteTask(params.taskId)
    app.taskEvents.emitDeleted(params.taskId, {
      ownerUsageCodeId: task.ownerUsageCodeId,
      ownerKind: task.ownerKind,
    })
    for (const image of images) {
      try {
        await fs.rm(resolveAbsoluteMediaPath(app, image.filePath), { force: true })
      } catch {
        /* ignore */
      }
    }

    return { ok: true }
  })

  app.get('/api/tasks/:taskId/events', async (request, reply) => {
    const auth = await requireAuth(app, request, reply)
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const taskRecord = app.db.getTask(params.taskId)
    if (!taskRecord || !canAccessTask(auth, taskRecord)) {
      reply.code(404)
      return { message: '任务不存在' }
    }
    const task = serializeTask(taskRecord, auth.role === 'admin')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })

    for (const event of app.db.listTaskEvents(params.taskId)) {
      reply.raw.write(formatSseEvent('progress', event))
    }
    reply.raw.write(formatSseEvent('snapshot', { task }))

    const heartbeat = setInterval(() => {
      reply.raw.write(': keep-alive\n\n')
    }, 15000)

    const unsubscribe = app.taskEvents.subscribe(params.taskId, (event) => {
      reply.raw.write(formatSseEvent('progress', event))
      const latestTask = loadSerializedTask(app.db, params.taskId, { appSecret: app.config.appSecret, exposeUsageCodeAlias: auth.role === 'admin' })
      if (latestTask) {
        reply.raw.write(formatSseEvent('snapshot', { task: latestTask }))
      }
    })

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
