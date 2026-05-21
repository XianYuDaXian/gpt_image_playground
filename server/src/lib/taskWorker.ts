import path from 'node:path'
import crypto from 'node:crypto'
import { decryptText } from './crypto.js'
import type { AppDatabase } from './db.js'
import { executeImageTask, writeOutputImage } from './imageApi.js'
import { downloadVideoOutput, generateVideoPoster, pollVideoGeneration, submitVideoGeneration } from './videoApi.js'
import type { TaskEventBus } from './eventBus.js'

export class TaskWorker {
  private running = new Set<string>()
  private cancelled = new Set<string>()
  private pending: string[] = []
  private maxConcurrentTasks: number

  constructor(
    private readonly db: AppDatabase,
    private readonly taskEvents: TaskEventBus,
    private readonly config: {
      appSecret: string
      mediaDir: string
      outputsDir: string
      thumbsDir: string
      maxConcurrentTasks: number
    },
  ) {
    this.maxConcurrentTasks = Math.max(1, Math.floor(config.maxConcurrentTasks) || 1)
  }

  enqueue(taskId: string) {
    if (this.running.has(taskId)) return
    if (this.pending.includes(taskId)) return
    this.pending.push(taskId)
    this.drain()
  }

  setMaxConcurrentTasks(value: number) {
    this.maxConcurrentTasks = Math.max(1, Math.floor(value) || 1)
    this.drain()
  }

  private drain() {
    while (this.running.size < this.maxConcurrentTasks && this.pending.length > 0) {
      const taskId = this.pending.shift()
      if (!taskId || this.running.has(taskId)) continue
      if (this.cancelled.has(taskId) || !this.db.taskExists(taskId)) {
        this.cancelled.delete(taskId)
        continue
      }

      this.start(taskId)
    }
  }

  private start(taskId: string) {
    this.running.add(taskId)
    this.cancelled.delete(taskId)
    void this.process(taskId)
      .catch((error) => {
        console.error(`[TaskWorker] 未处理任务异常: ${taskId}`, error)
      })
      .finally(() => {
        this.running.delete(taskId)
        this.cancelled.delete(taskId)
        this.drain()
      })
  }

  cancel(taskId: string) {
    this.cancelled.add(taskId)
    this.pending = this.pending.filter((id) => id !== taskId)
  }

  private isTaskInactive(taskId: string) {
    return this.cancelled.has(taskId) || !this.db.taskExists(taskId)
  }

  private emit(taskId: string, input: { status: string; step: string; percent: number; message?: string | null }) {
    if (this.isTaskInactive(taskId)) return false

    if (input.status === 'failed') {
      this.db.refundTaskQuota(taskId, 'task_failed')
    }

    const updatedTask = this.db.updateTaskProgress({
      id: taskId,
      status: input.status,
      progressPercent: input.percent,
      currentStep: input.step,
      errorMessage: input.status === 'failed' ? input.message ?? null : null,
      finishedAt: input.status === 'succeeded' || input.status === 'failed' ? new Date().toISOString() : null,
    })
    if (!updatedTask) return false

    const event = this.db.appendTaskEvent({
      taskId,
      status: input.status,
      step: input.step,
      percent: input.percent,
      message: input.message ?? null,
    })
    if (!event) return false

    this.taskEvents.emit(taskId, event)
    return true
  }

  private async process(taskId: string) {
    const task = this.db.getTask(taskId)
    if (!task) return

    const providerId = task.providerProfileId
    if (!providerId) {
      this.emit(taskId, { status: 'failed', step: 'config', percent: 5, message: '缺少默认 provider 配置' })
      return
    }

    const provider = this.db.getProviderProfile(providerId)
    if (!provider) {
      this.emit(taskId, { status: 'failed', step: 'config', percent: 5, message: 'provider 配置不存在' })
      return
    }

    if (task.taskType === 'video') {
      await this.processVideoTask(taskId, task, provider)
      return
    }

    try {
      const inputImages = this.db.listTaskImages(taskId).filter((image) => image.kind === 'input')
      const maskImage = this.db.listTaskImages(taskId).find((image) => image.kind === 'mask') ?? null
      const apiKey = decryptText(provider.apiKeyEncrypted, this.config.appSecret)

      if (!this.emit(taskId, { status: 'submitted', step: 'submitted', percent: 35, message: '已提交到上游接口' })) return
      if (!this.emit(taskId, { status: 'processing', step: 'processing', percent: 60, message: '正在生成图片' })) return

      const params = JSON.parse(task.paramsJson) as {
        size: string
        quality: 'auto' | 'low' | 'medium' | 'high'
        output_format: 'png' | 'jpeg' | 'webp'
        output_compression: number | null
        moderation: 'auto' | 'low'
        n: number
      }
      const shouldPersistIncrementally = params.n > 1
      const outputDir = path.join(this.config.outputsDir, taskId)
      let persistedImages = 0

      const persistOutputImages = async (images: Awaited<ReturnType<typeof executeImageTask>>) => {
        for (const image of images) {
          if (this.isTaskInactive(taskId)) return false

          const written = await writeOutputImage(outputDir, persistedImages, image)
          const saved = this.db.addTaskImage({
            id: crypto.randomUUID(),
            taskId,
            kind: 'output',
            filePath: path.join('outputs', taskId, written.fileName),
            mimeType: written.mimeType,
            bytes: written.bytes,
            sha256: written.sha256,
            width: written.width,
            height: written.height,
          })
          if (!saved) return false
          persistedImages += 1
        }

        return true
      }

      const images = await executeImageTask(
        this.db,
        {
          prompt: task.prompt,
          params,
          provider,
          inputImages: inputImages.map((image) => ({
            filePath: path.join(this.config.mediaDir, image.filePath),
            mimeType: image.mimeType,
          })),
          maskImage: maskImage
            ? {
                filePath: path.join(this.config.mediaDir, maskImage.filePath),
                mimeType: maskImage.mimeType,
              }
            : null,
        },
        apiKey,
        {
          onImagesReady: shouldPersistIncrementally
            ? async (readyImages, state) => {
                const ok = await persistOutputImages(readyImages)
                if (!ok) return
                void this.emit(taskId, {
                  status: 'downloading',
                  step: 'downloading',
                  percent: Math.min(95, 82 + Math.floor((state.completed / state.total) * 13)),
                  message: `已收到并保存第 ${state.completed}/${state.total} 张图片`,
                })
              }
            : undefined,
          onImageComplete: (completed, total) => {
            if (total <= 1 || shouldPersistIncrementally) return
            const percent = Math.min(80, 60 + Math.floor((completed / total) * 20))
            void this.emit(taskId, {
              status: 'processing',
              step: 'processing',
              percent,
              message: `正在生成图片（${completed}/${total}）`,
            })
          },
        },
      )
      if (this.isTaskInactive(taskId)) return

      if (!shouldPersistIncrementally) {
        if (!this.emit(
          taskId,
          {
            status: 'downloading',
            step: 'downloading',
            percent: 85,
            message: images.length > 1 ? `正在保存输出图片（${images.length} 张）` : '正在保存输出图片',
          },
        )) return

        const ok = await persistOutputImages(images)
        if (!ok) return
      } else if (persistedImages < images.length) {
        const remainingImages = images.slice(persistedImages)
        const ok = await persistOutputImages(remainingImages)
        if (!ok) return
      }

      if (this.isTaskInactive(taskId)) return
      if (task.ownerKind === 'usage_code' && task.ownerUsageCodeId) {
        this.db.recordUsageCodeOutputImages({
          usageCodeId: task.ownerUsageCodeId,
          count: images.length,
        })
        this.db.insertUsageCodeActivityLog({
          usageCodeId: task.ownerUsageCodeId,
          taskId,
          actorKind: 'user',
          eventType: 'image_task_succeeded',
          message: `使用码用户生成图片 ${images.length} 张`,
        })
      }
      this.emit(taskId, { status: 'succeeded', step: 'succeeded', percent: 100, message: `生成完成，共 ${images.length} 张图片` })
    } catch (error) {
      if (this.isTaskInactive(taskId)) return
      this.emit(taskId, {
        status: 'failed',
        step: 'failed',
        percent: 60,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async processVideoTask(
    taskId: string,
    task: NonNullable<ReturnType<AppDatabase['getTask']>>,
    provider: NonNullable<ReturnType<AppDatabase['getProviderProfile']>>,
  ) {
    try {
      const inputImages = this.db.listTaskImages(taskId).filter((image) => image.kind === 'input' || image.kind === 'video_input')
      const apiKey = decryptText(provider.apiKeyEncrypted, this.config.appSecret)
      const params = JSON.parse(task.paramsJson) as {
        aspect_ratio?: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
        resolution: '480p' | '720p'
        duration: 6 | 10 | 15
      }

      if (!this.emit(taskId, { status: 'submitted', step: 'submitted', percent: 10, message: '已提交到视频接口' })) return
      const requestId = await submitVideoGeneration(
        {
          prompt: task.prompt,
          params,
          provider,
          inputImages: inputImages.map((image) => ({
            filePath: path.join(this.config.mediaDir, image.filePath),
            mimeType: image.mimeType,
          })),
        },
        apiKey,
      )
      this.db.updateTaskProgress({
        id: taskId,
        status: 'processing',
        progressPercent: 15,
        currentStep: 'processing',
        upstreamRequestId: requestId,
      })

      const startedAt = Date.now()
      const timeoutMs = Math.max(30, provider.timeoutSeconds) * 1000
      let finalVideoUrl = ''
      let finalDuration: number | null = null
      let finalUsage: unknown = null

      while (!this.isTaskInactive(taskId)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error('视频生成超时')
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const result = await pollVideoGeneration(provider, apiKey, requestId)
        finalUsage = result.usage ?? null

        if (result.status === 'failed') {
          throw new Error(result.error?.message || '视频生成失败')
        }

        const progress = Math.max(15, Math.min(95, Number(result.progress) || 15))
        if (result.status !== 'done') {
          if (!this.emit(taskId, {
            status: 'processing',
            step: 'processing',
            percent: progress,
            message: `视频生成中 ${progress}%`,
          })) return
          continue
        }

        if (result.video?.respect_moderation === false || !result.video?.url) {
          throw new Error('视频未通过审核或未返回可下载地址')
        }
        finalVideoUrl = result.video.url
        finalDuration = result.video.duration ?? null
        break
      }

      if (!finalVideoUrl || this.isTaskInactive(taskId)) return
      if (!this.emit(taskId, { status: 'downloading', step: 'downloading', percent: 96, message: '正在保存视频' })) return

      const outputDir = path.join(this.config.outputsDir, taskId)
      const written = await downloadVideoOutput(outputDir, finalVideoUrl, finalDuration)
      const outputVideoId = crypto.randomUUID()
      const saved = this.db.addTaskImage({
        id: outputVideoId,
        taskId,
        kind: 'video_output',
        filePath: path.join('outputs', taskId, written.fileName),
        mimeType: written.mimeType,
        bytes: written.bytes,
        sha256: written.sha256,
        metadataJson: written.metadataJson,
      })
      if (!saved) return
      try {
        const posterDir = path.join(this.config.thumbsDir, taskId)
        const poster = await generateVideoPoster(path.join(outputDir, written.fileName), posterDir)
        this.db.addTaskImage({
          id: crypto.randomUUID(),
          taskId,
          kind: 'thumb',
          filePath: path.join('thumbs', taskId, poster.fileName),
          mimeType: poster.mimeType,
          bytes: poster.bytes,
          sha256: poster.sha256,
          metadataJson: JSON.stringify({ videoId: outputVideoId }),
        })
      } catch (error) {
        console.warn('生成视频预览图失败', error)
      }

      this.db.updateTaskProgress({
        id: taskId,
        status: 'downloading',
        progressPercent: 98,
        currentStep: 'downloading',
        upstreamUsageJson: finalUsage ? JSON.stringify(finalUsage) : null,
      })
      if (task.ownerKind === 'usage_code' && task.ownerUsageCodeId) {
        this.db.insertUsageCodeActivityLog({
          usageCodeId: task.ownerUsageCodeId,
          taskId,
          actorKind: 'user',
          eventType: 'video_task_succeeded',
          message: '使用码用户生成视频 1 个',
        })
      }
      this.emit(taskId, { status: 'succeeded', step: 'succeeded', percent: 100, message: '视频生成完成' })
    } catch (error) {
      if (this.isTaskInactive(taskId)) return
      this.emit(taskId, {
        status: 'failed',
        step: 'failed',
        percent: 60,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
