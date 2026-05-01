import path from 'node:path'
import crypto from 'node:crypto'
import { decryptText } from './crypto.js'
import type { AppDatabase } from './db.js'
import { executeImageTask, writeOutputImage } from './imageApi.js'
import type { TaskEventBus } from './eventBus.js'

export class TaskWorker {
  private running = new Set<string>()

  constructor(
    private readonly db: AppDatabase,
    private readonly taskEvents: TaskEventBus,
    private readonly config: {
      appSecret: string
      mediaDir: string
      outputsDir: string
    },
  ) {}

  enqueue(taskId: string) {
    if (this.running.has(taskId)) return
    this.running.add(taskId)
    void this.process(taskId).finally(() => {
      this.running.delete(taskId)
    })
  }

  private emit(taskId: string, input: { status: string; step: string; percent: number; message?: string | null }) {
    this.db.updateTaskProgress({
      id: taskId,
      status: input.status,
      progressPercent: input.percent,
      currentStep: input.step,
      errorMessage: input.status === 'failed' ? input.message ?? null : null,
      finishedAt: input.status === 'succeeded' || input.status === 'failed' ? new Date().toISOString() : null,
    })
    const event = this.db.appendTaskEvent({
      taskId,
      status: input.status,
      step: input.step,
      percent: input.percent,
      message: input.message ?? null,
    })
    this.taskEvents.emit(taskId, event)
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

    try {
      const runtime = this.db.getAppSetting<{ codexCli?: boolean }>('runtime')
      const inputImages = this.db.listTaskImages(taskId).filter((image) => image.kind === 'input')
      const maskImage = this.db.listTaskImages(taskId).find((image) => image.kind === 'mask') ?? null
      const apiKey = decryptText(provider.apiKeyEncrypted, this.config.appSecret)

      this.emit(taskId, { status: 'submitted', step: 'submitted', percent: 35, message: '已提交到上游接口' })
      this.emit(taskId, { status: 'processing', step: 'processing', percent: 60, message: '正在生成图片' })

      const images = await executeImageTask(
        this.db,
        {
          prompt: task.prompt,
          params: JSON.parse(task.paramsJson),
          provider,
          runtime,
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
      )

      this.emit(taskId, { status: 'downloading', step: 'downloading', percent: 85, message: '正在下载输出图片' })

      const outputDir = path.join(this.config.outputsDir, taskId)
      for (let index = 0; index < images.length; index++) {
        const written = await writeOutputImage(outputDir, index, images[index])
        this.db.addTaskImage({
          id: crypto.randomUUID(),
          taskId,
          kind: 'output',
          filePath: path.join('outputs', taskId, written.fileName),
          mimeType: written.mimeType,
          bytes: written.bytes,
          sha256: written.sha256,
        })
      }

      this.emit(taskId, { status: 'succeeded', step: 'succeeded', percent: 100, message: `生成完成，共 ${images.length} 张图片` })
    } catch (error) {
      this.emit(taskId, {
        status: 'failed',
        step: 'failed',
        percent: 60,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
