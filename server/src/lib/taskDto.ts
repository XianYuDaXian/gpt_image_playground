import path from 'node:path'
import type { AppDatabase, ProviderProfileRecord, TaskImageRecord, TaskRecord } from './db.js'
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

function buildVideoMetadataMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, { duration?: number | null }>>((acc, image) => {
    if (!image.metadataJson) {
      acc[image.id] = {}
      return acc
    }
    try {
      acc[image.id] = JSON.parse(image.metadataJson) as { duration?: number | null }
    } catch {
      acc[image.id] = {}
    }
    return acc
  }, {})
}

function buildImageSizeMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, { width: number | null; height: number | null }>>((acc, image) => {
    acc[image.id] = {
      width: image.width,
      height: image.height,
    }
    return acc
  }, {})
}

export function serializeTaskRecord(
  task: TaskRecord,
  images: TaskImageRecord[],
  options: {
    appSecret?: string
    exposeUsageCodeAlias?: boolean
    providerProfile?: Pick<ProviderProfileRecord, 'id' | 'name' | 'model' | 'tagColor'> | null
  } = {},
) {
  const inputImages = images.filter((image) => image.kind === 'input')
  const outputImages = images.filter((image) => image.kind === 'output')
  const outputVideos = images.filter((image) => image.kind === 'video_output')
  const maskImage = images.find((image) => image.kind === 'mask') ?? null
  const createdAt = toMs(task.createdAt) ?? Date.now()
  const finishedAt = toMs(task.finishedAt)
  const usageCodePlain = decryptUsageCode(task, options.appSecret)
  const ownerLabel = task.ownerKind === 'usage_code'
    ? options.exposeUsageCodeAlias ? task.ownerLabel : usageCodePlain ?? '使用码'
    : task.ownerLabel

  return {
    id: task.id,
    prompt: task.prompt,
    taskType: task.taskType ?? 'image',
    params: JSON.parse(task.paramsJson),
    providerProfileId: task.providerProfileId,
    providerProfileName: options.providerProfile?.name ?? null,
    providerProfileTagColor: options.providerProfile?.tagColor ?? null,
    providerProfileModel: options.providerProfile?.model ?? null,
    inputImageIds: inputImages.map((image) => image.id),
    outputImages: outputImages.map((image) => image.id),
    outputVideos: outputVideos.map((video) => video.id),
    maskImageId: maskImage?.id ?? null,
    maskTargetImageId: maskImage ? inputImages[0]?.id ?? null : null,
    imageUrlsById: buildImageUrlMap(images),
    mediaUrlsById: buildImageUrlMap(images),
    imageSizesById: buildImageSizeMap(images),
    videoMetadataById: buildVideoMetadataMap(outputVideos),
    status: toUiStatus(task.status),
    serverStatus: task.status,
    currentStep: task.currentStep,
    progressPercent: task.progressPercent,
    error: task.errorMessage,
    ownerUsageCodeId: task.ownerUsageCodeId,
    ownerKind: task.ownerKind,
    ownerLabel,
    ownerUsageCode: task.ownerKind === 'usage_code' && task.ownerUsageCodeId
      ? {
          id: task.ownerUsageCodeId,
          name: ownerLabel,
          code: usageCodePlain,
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

export function loadSerializedTask(db: AppDatabase, taskId: string, options: { appSecret?: string; exposeUsageCodeAlias?: boolean } = {}) {
  const task = db.getTask(taskId)
  if (!task) return null
  const providerProfile = task.providerProfileId ? db.getProviderProfile(task.providerProfileId) : null
  return serializeTaskRecord(task, db.listTaskImages(taskId), { ...options, providerProfile })
}
