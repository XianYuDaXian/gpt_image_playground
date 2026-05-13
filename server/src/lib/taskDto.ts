import path from 'node:path'
import type { AppDatabase, TaskImageRecord, TaskRecord } from './db.js'
import { decryptText } from './crypto.js'

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

function decryptUsageCode(task: TaskRecord, appSecret?: string) {
  if (!appSecret || !task.ownerUsageCodeCodeEncrypted) return null
  try {
    return decryptText(task.ownerUsageCodeCodeEncrypted, appSecret)
  } catch {
    return null
  }
}

export function serializeTaskRecord(task: TaskRecord, images: TaskImageRecord[], options: { appSecret?: string } = {}) {
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
    ownerUsageCodeId: task.ownerUsageCodeId,
    ownerKind: task.ownerKind,
    ownerLabel: task.ownerLabel,
    ownerUsageCode: task.ownerKind === 'usage_code' && task.ownerUsageCodeId
      ? {
          id: task.ownerUsageCodeId,
          name: task.ownerLabel,
          code: decryptUsageCode(task, options.appSecret),
          createdAt: task.ownerUsageCodeCreatedAt,
          lastUsedAt: task.ownerUsageCodeLastUsedAt,
          imageQuota: task.ownerUsageCodeImageQuota,
          usedImageCredits: task.ownerUsageCodeUsedImageCredits ?? 0,
          remainingImageCredits: task.ownerUsageCodeImageQuota == null
            ? null
            : Math.max(0, task.ownerUsageCodeImageQuota - (task.ownerUsageCodeUsedImageCredits ?? 0)),
          taskCount: task.ownerUsageCodeTaskCount ?? 0,
          outputImageCount: task.ownerUsageCodeOutputImageCount ?? 0,
        }
      : null,
    reservedImageCredits: task.reservedImageCredits,
    createdAt,
    finishedAt,
    elapsed: finishedAt != null ? finishedAt - createdAt : null,
    updatedAt: toMs(task.updatedAt) ?? createdAt,
    isFavorite: Boolean(task.isFavorite),
    isArchived: Boolean(task.isArchived),
  }
}

export function loadSerializedTask(db: AppDatabase, taskId: string, options: { appSecret?: string } = {}) {
  const task = db.getTask(taskId)
  if (!task) return null
  return serializeTaskRecord(task, db.listTaskImages(taskId), options)
}
