import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { buildAuthStatus, canAccessTask, getAllowedProviderProfileIds, requireAuth } from '../lib/auth.js'
import { serializeTaskRecord, loadSerializedTask } from '../lib/taskDto.js'
import type { TaskListEventRecord } from '../lib/eventBus.js'

const ADMIN_TASK_LIST_LIMIT = 2000
const USER_TASK_LIST_LIMIT = 500

const taskParamsSchema = z.object({
  size: z.string().default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.number().int().min(0).max(100).nullable().default(null),
  moderation: z.enum(['auto', 'low']).default('auto'),
  n: z.number().int().positive().max(16).default(1),
})

const videoParamsSchema = z.object({
  aspect_ratio: z.enum(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']).default('auto'),
  resolution: z.enum(['480p', '720p']).default('480p'),
  duration: z.union([z.literal(6), z.literal(10), z.literal(15)]).default(6),
})

function clampVideoParamsToProvider(
  params: z.infer<typeof videoParamsSchema>,
  provider: { grokApiCompat?: number | boolean; videoMaxResolution?: '480p' | '720p'; videoMaxDuration?: 6 | 10 | 15 },
) {
  const advancedEnabled = Boolean(provider.grokApiCompat)
  const resolution = advancedEnabled && provider.videoMaxResolution === '720p' ? params.resolution : '480p'
  const maxDuration = advancedEnabled
    ? provider.videoMaxDuration === 15 ? 15 : provider.videoMaxDuration === 10 ? 10 : 6
    : 6
  const duration = params.duration <= maxDuration ? params.duration : maxDuration
  return {
    ...params,
    resolution,
    duration,
  }
}

const taskFlagsSchema = z.object({
  isFavorite: z.boolean().optional(),
  isArchived: z.boolean().optional(),
}).refine((value) => value.isFavorite !== undefined || value.isArchived !== undefined, {
  message: '至少需要更新一个任务状态',
})

const taskListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  query: z.string().optional(),
  searchTag: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.enum(['all', 'running', 'done', 'error']).default('all'),
  taskType: z.enum(['all', 'image', 'video']).default('all'),
  favorite: z.union([z.literal('1'), z.literal('true')]).optional(),
  archived: z.union([z.literal('1'), z.literal('true')]).optional(),
  showUsageCodeTasksForAdmin: z.union([z.literal('1'), z.literal('true')]).optional(),
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

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/：/g, ':')
}

function formatImageRatio(width: number, height: number) {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (!Number.isFinite(roundedWidth) || !Number.isFinite(roundedHeight) || roundedWidth <= 0 || roundedHeight <= 0) {
    return ''
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(roundedWidth, roundedHeight)
  return `${roundedWidth / divisor}:${roundedHeight / divisor}`
}

function buildSizeSearchText(width: number, height: number) {
  return [`${width}x${height}`, `${width}×${height}`, formatImageRatio(width, height)].join(' ')
}

function buildOwnerSearchText(
  task: ReturnType<typeof loadSerializedTask> extends infer T ? Exclude<T, null> : never,
  role: 'admin' | 'user',
) {
  const ownerTerms = [task.ownerUsageCode?.code]
  if (role === 'admin') {
    ownerTerms.push(task.ownerLabel)
    ownerTerms.push(task.ownerUsageCode?.name)
  }
  return ownerTerms.filter(Boolean).join(' ')
}

function getImageParamDisplayValue(
  task: ReturnType<typeof loadSerializedTask> extends infer T ? Exclude<T, null> : never,
  paramKey: keyof z.infer<typeof taskParamsSchema>,
) {
  const params = task.params as z.infer<typeof taskParamsSchema>
  const requestedValue = params[paramKey]
  const actualValue = paramKey === 'n' && task.outputImages?.length > 0
    ? task.outputImages.length
    : undefined
  return String(actualValue ?? requestedValue ?? '')
}

function buildCardTagSearchText(
  task: ReturnType<typeof loadSerializedTask> extends infer T ? Exclude<T, null> : never,
  role: 'admin' | 'user',
) {
  const isVideoTask = task.taskType === 'video'
  const tagTerms = [
    isVideoTask ? '视频 video' : '图片 image',
    task.status === 'running' ? '生成中 running' : task.status === 'done' ? '已完成 done' : '失败 error',
    task.maskImageId ? 'mask 遮罩' : '',
    task.currentStep,
    task.providerProfileName,
    task.providerProfileId,
    role === 'admin' ? task.providerProfileModel : null,
    task.ownerLabel,
    task.ownerUsageCode?.name,
    task.ownerUsageCode?.code,
  ]

  if (isVideoTask) {
    const videoParams = task.params as z.infer<typeof videoParamsSchema>
    tagTerms.push(videoParams.aspect_ratio)
    tagTerms.push(videoParams.resolution)
    tagTerms.push(String(videoParams.duration))
    tagTerms.push(`${videoParams.duration}s`)
  } else {
    tagTerms.push(getImageParamDisplayValue(task, 'quality'))
    tagTerms.push(getImageParamDisplayValue(task, 'size'))
    tagTerms.push(getImageParamDisplayValue(task, 'output_format'))
    tagTerms.push(getImageParamDisplayValue(task, 'n'))
  }

  return tagTerms.filter(Boolean).join(' ')
}

function matchesTaskSearch(task: ReturnType<typeof loadSerializedTask> extends infer T ? Exclude<T, null> : never, query: string, role: 'admin' | 'user') {
  const q = normalizeSearchText(query.trim())
  if (!q) return true

  const imageSearchText = (task.outputImages ?? [])
    .map((imageId) => {
      const size = task.imageSizesById?.[imageId]
      if (!size?.width || !size.height) return ''
      return buildSizeSearchText(size.width, size.height)
    })
    .join(' ')

  const ownerSearchText = buildOwnerSearchText(task, role)

  const searchText = [
    task.prompt,
    JSON.stringify(task.params),
    imageSearchText,
    ownerSearchText,
    buildCardTagSearchText(task, role),
  ].join(' ')

  return normalizeSearchText(searchText).includes(q)
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

    const taskId = crypto.randomUUID()
    let prompt = ''
    let providerProfileId = ''
    let selectedUsageCodeId: string | null = null
    let taskType: 'image' | 'video' = 'image'
    let parsedParams = taskParamsSchema.parse({})
    let parsedVideoParams = videoParamsSchema.parse({})
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
        if (part.fieldname === 'taskType') {
          taskType = String(part.value ?? '').trim() === 'video' ? 'video' : 'image'
        }
        if (part.fieldname === 'videoParams') {
          try {
            parsedVideoParams = videoParamsSchema.parse(JSON.parse(String(part.value ?? '{}')))
          } catch {
            parsedVideoParams = videoParamsSchema.parse({})
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

    if (!providerProfileId) {
      const defaultProfile = app.db.getDefaultProviderProfile()
      if (!defaultProfile) {
        reply.code(400)
        return { message: '后端尚未配置默认 provider profile' }
      }
      providerProfileId = defaultProfile.id
    }

    const providerProfile = app.db.getProviderProfile(providerProfileId)
    if (!providerProfile) {
      reply.code(400)
      return { message: 'API 配置不存在' }
    }
    if (taskType === 'video' && providerProfile.apiMode !== 'videos') {
      reply.code(400)
      return { message: '请选择视频 API 配置' }
    }
    if (taskType === 'image' && providerProfile.apiMode === 'videos') {
      reply.code(400)
      return { message: '请选择图片 API 配置' }
    }
    if (taskType === 'video') {
      parsedVideoParams = clampVideoParamsToProvider(parsedVideoParams, providerProfile)
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
      reservedImageCredits = taskType === 'video' ? 1 : parsedParams.n
      try {
        if (taskType === 'video') {
          app.db.reserveVideoCreditsForTask({
            usageCodeId: selectedUsageCodeId,
            taskId,
            credits: reservedImageCredits,
            providerProfileId: providerProfile.id,
          })
        } else {
          app.db.reserveUsageCreditsForTask({
            usageCodeId: selectedUsageCodeId,
            taskId,
            credits: reservedImageCredits,
            providerProfileId: providerProfile.id,
          })
        }
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
      taskType,
      paramsJson: JSON.stringify(taskType === 'video' ? parsedVideoParams : parsedParams),
      providerProfileId: providerProfile.id,
      ownerUsageCodeId: auth.role === 'user' ? selectedUsageCodeId : null,
      ownerKind: auth.role === 'user' ? 'usage_code' : 'admin',
      reservedImageCredits,
    })

    if (!task) {
      if (auth.role === 'user') {
        if (taskType === 'video') {
          app.db.refundVideoCreditsForTask({
            usageCodeId: selectedUsageCodeId ?? '',
            taskId,
            credits: reservedImageCredits,
            reason: 'task_create_failed',
            providerProfileId: providerProfile.id,
          })
        } else {
          app.db.refundUsageCreditsForTask({
            usageCodeId: selectedUsageCodeId ?? '',
            taskId,
            credits: reservedImageCredits,
            reason: 'task_create_failed',
            providerProfileId: providerProfile.id,
          })
        }
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
          kind: file.fieldname === 'mask' ? 'mask' : taskType === 'video' ? 'video_input' : 'input',
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
      message: taskType === 'video'
        ? '视频任务已创建，等待执行'
        : maskImageId ? '任务已创建，等待带遮罩处理' : '任务已创建，等待执行',
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
    const query = taskListQuerySchema.parse(request.query)
    const searchTags = Array.isArray(query.searchTag)
      ? query.searchTag
      : query.searchTag ? [query.searchTag] : []
    const rawTasks = auth.role === 'admin'
      ? app.db.listTasks(ADMIN_TASK_LIST_LIMIT)
      : app.db.listTasksForUsageCodes(auth.usageCodeIds, ADMIN_TASK_LIST_LIMIT)
    const filteredTasks = rawTasks
      .map((task) => serializeTask(task, auth.role === 'admin'))
      .filter((task) => {
        if (query.favorite && !task.isFavorite) return false
        if (query.archived ? !task.isArchived : task.isArchived) return false
        if (query.status !== 'all' && task.status !== query.status) return false
        if (query.taskType !== 'all' && (task.taskType ?? 'image') !== query.taskType) return false
        if (
          auth.role === 'admin'
          && !query.showUsageCodeTasksForAdmin
          && task.ownerKind === 'usage_code'
          && !query.query?.trim()
          && searchTags.length === 0
        ) {
          return false
        }
        if (!matchesTaskSearch(task, query.query ?? '', auth.role)) return false
        return searchTags.every((tag) => matchesTaskSearch(task, tag, auth.role))
      })
    const total = filteredTasks.length
    const start = (query.page - 1) * query.pageSize
    const items = filteredTasks.slice(start, start + query.pageSize)
    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
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
        ? app.db.listTasks(ADMIN_TASK_LIST_LIMIT)
        : app.db.listTasksForUsageCodes(auth.usageCodeIds, USER_TASK_LIST_LIMIT)
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
    if (auth.role === 'user' && task.ownerUsageCodeId) {
      const outputImageCount = images.filter((image) => image.kind === 'output').length
      const outputVideoCount = images.filter((image) => image.kind === 'video_output').length
      app.db.insertUsageCodeActivityLog({
        usageCodeId: task.ownerUsageCodeId,
        taskId: params.taskId,
        actorKind: 'user',
        eventType: 'task_deleted',
        message: `使用码用户删除任务，清理图片 ${outputImageCount} 张，视频 ${outputVideoCount} 个`,
      })
    }
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
