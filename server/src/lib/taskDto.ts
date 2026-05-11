import path from 'node:path'
import type { AppDatabase, TaskImageRecord, TaskRecord } from './db.js'

function toUiStatus(status: string) {
  if (status === 'failed' || status === 'canceled') return 'error'
  if (status === 'succeeded') return 'done'
  return 'running'
}

function toMs(value: string | null) {
  return value ? new Date(value).getTime() : null
}

function buildMediaUrl(filePath: string) {
  const normalized = filePath.split(path.sep).join('/')
  return `/media/${normalized.replace(/^\/+/, '')}`
}

function buildImageUrlMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, string>>((acc, image) => {
    acc[image.id] = buildMediaUrl(image.filePath)
    return acc
  }, {})
}

export function serializeTaskRecord(task: TaskRecord, images: TaskImageRecord[]) {
  const inputImages = images.filter((image) => image.kind === 'input')
  const outputImages = images.filter((image) => image.kind === 'output')
  const maskImage = images.find((image) => image.kind === 'mask') ?? null
  const createdAt = toMs(task.createdAt) ?? Date.now()
  const finishedAt = toMs(task.finishedAt)

  return {
    id: task.id,
    prompt: task.prompt,
    params: JSON.parse(task.paramsJson),
    inputImageIds: inputImages.map((image) => image.id),
    outputImages: outputImages.map((image) => image.id),
    maskImageId: maskImage?.id ?? null,
    maskTargetImageId: maskImage ? inputImages[0]?.id ?? null : null,
    imageUrlsById: buildImageUrlMap(images),
    status: toUiStatus(task.status),
    serverStatus: task.status,
    currentStep: task.currentStep,
    progressPercent: task.progressPercent,
    error: task.errorMessage,
    createdAt,
    finishedAt,
    elapsed: finishedAt != null ? finishedAt - createdAt : null,
    updatedAt: toMs(task.updatedAt) ?? createdAt,
    isFavorite: Boolean(task.isFavorite),
    isArchived: Boolean(task.isArchived),
  }
}

export function loadSerializedTask(db: AppDatabase, taskId: string) {
  const task = db.getTask(taskId)
  if (!task) return null
  return serializeTaskRecord(task, db.listTaskImages(taskId))
}
