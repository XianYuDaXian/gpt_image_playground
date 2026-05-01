import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { serializeTaskRecord, loadSerializedTask } from '../lib/taskDto.js'

const taskParamsSchema = z.object({
  size: z.string().default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.number().int().min(0).max(100).nullable().default(null),
  moderation: z.enum(['auto', 'low']).default('auto'),
  n: z.number().int().positive().max(16).default(1),
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
  app.post('/api/tasks', async (request, reply) => {
    const defaultProfile = app.db.getDefaultProviderProfile()
    if (!defaultProfile) {
      reply.code(400)
      return { message: '后端尚未配置默认 provider profile' }
    }

    const taskId = crypto.randomUUID()
    let prompt = ''
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

    const task = app.db.createTask({
      id: taskId,
      prompt,
      paramsJson: JSON.stringify(parsedParams),
      providerProfileId: defaultProfile.id,
    })

    if (!task) {
      throw new Error('创建任务失败')
    }

    let maskImageId: string | null = null
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

    const event = app.db.appendTaskEvent({
      taskId,
      status: 'queued',
      step: 'queued',
      percent: 5,
      message: maskImageId ? '任务已创建，等待带遮罩处理' : '任务已创建，等待执行',
    })
    app.taskEvents.emit(taskId, event)
    app.taskWorker.enqueue(taskId)

    reply.code(201)
    return {
      task: loadSerializedTask(app.db, taskId),
      event,
    }
  })

  app.get('/api/tasks', async () => {
    return {
      items: app.db.listTasks(200).map((task) =>
        serializeTaskRecord(task, app.db.listTaskImages(task.id)),
      ),
    }
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const task = loadSerializedTask(app.db, params.taskId)
    if (!task) {
      reply.code(404)
      return { message: '任务不存在' }
    }

    return {
      task,
      events: app.db.listTaskEvents(params.taskId),
    }
  })

  app.delete('/api/tasks/:taskId', async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const task = app.db.getTask(params.taskId)
    if (!task) {
      reply.code(404)
      return { message: '任务不存在' }
    }

    const images = app.db.listTaskImages(params.taskId)
    app.db.deleteTask(params.taskId)
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
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params)
    const task = loadSerializedTask(app.db, params.taskId)
    if (!task) {
      reply.code(404)
      return { message: '任务不存在' }
    }

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
      const latestTask = loadSerializedTask(app.db, params.taskId)
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
