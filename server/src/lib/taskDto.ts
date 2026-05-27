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

function buildVideoPosterUrlMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, string>>((acc, image) => {
    if (image.kind !== 'thumb' || !image.metadataJson) return acc
    try {
      const metadata = JSON.parse(image.metadataJson) as { videoId?: string | null }
      if (metadata.videoId) {
        acc[metadata.videoId] = buildMediaUrl(image.filePath)
      }
    } catch {
      return acc
    }
    return acc
  }, {})
}

function buildImageThumbnailUrlMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, string>>((acc, image) => {
    if (image.kind !== 'thumb' || !image.metadataJson) return acc
    try {
      const metadata = JSON.parse(image.metadataJson) as { imageId?: string | null }
      if (metadata.imageId) {
        acc[metadata.imageId] = buildMediaUrl(image.filePath)
      }
    } catch {
      return acc
    }
    return acc
  }, {})
}

const DIRECT_IMAGE_PREVIEW_MAX_BYTES = 1024 * 1024

function buildImagePreviewUrlMap(images: TaskImageRecord[]) {
  const originalUrlMap = buildImageUrlMap(images)
  const thumbnailUrlMap = buildImageThumbnailUrlMap(images)

  return images.reduce<Record<string, string>>((acc, image) => {
    if (image.kind !== 'output') return acc

    if (image.bytes <= DIRECT_IMAGE_PREVIEW_MAX_BYTES) {
      acc[image.id] = originalUrlMap[image.id] || ''
      return acc
    }

    const thumbnailUrl = thumbnailUrlMap[image.id]
    if (thumbnailUrl) {
      acc[image.id] = thumbnailUrl
    }
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

function parseQuotaMap(value: string | null | undefined) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return Object.entries(parsed).reduce<Record<string, number>>((acc, [key, item]) => {
      const nextValue = Number(item)
      if (Number.isFinite(nextValue)) acc[key] = nextValue
      return acc
    }, {})
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

function buildImageBytesMap(images: TaskImageRecord[]) {
  return images.reduce<Record<string, number>>((acc, image) => {
    acc[image.id] = image.bytes
    return acc
  }, {})
}

function getTaskErrorForViewer(task: TaskRecord, exposeDetailedError?: boolean) {
  if (!task.errorMessage) return null
  if (exposeDetailedError) return task.errorMessage
  const httpMatch = task.errorMessage.match(/\bHTTP\s+(\d{3})\b/i)
  if (httpMatch?.[1]) {
    return `HTTP ${httpMatch[1]}`
  }
  return '生成失败，请联系管理员'
}

export function serializeTaskRecord(
  task: TaskRecord,
  images: TaskImageRecord[],
  options: {
    appSecret?: string
    exposeUsageCodeAlias?: boolean
    exposeDetailedError?: boolean
    preferProviderRemark?: boolean
    providerProfile?: Pick<ProviderProfileRecord, 'id' | 'name' | 'remarkName' | 'model' | 'tagColor'> | null
  } = {},
) {
  const inputImages = images.filter((image) => image.kind === 'input' || image.kind === 'video_input')
  const outputImages = images.filter((image) => image.kind === 'output')
  const outputVideos = images.filter((image) => image.kind === 'video_output')
  const maskImage = images.find((image) => image.kind === 'mask') ?? null
  const createdAt = toMs(task.createdAt) ?? Date.now()
  const finishedAt = toMs(task.finishedAt)
  const usageCodePlain = decryptUsageCode(task, options.appSecret)
  const ownerLabel = task.ownerKind === 'usage_code'
    ? options.exposeUsageCodeAlias ? task.ownerLabel : usageCodePlain ?? '使用码'
    : task.ownerLabel
  const ownerUsageCodeProviderImageQuotas = parseQuotaMap(task.ownerUsageCodeProviderImageQuotasJson)
  const ownerUsageCodeProviderUsedImageCredits = parseQuotaMap(task.ownerUsageCodeProviderUsedImageCreditsJson)
  const ownerUsageCodeProviderVideoQuotas = parseQuotaMap(task.ownerUsageCodeProviderVideoQuotasJson)
  const ownerUsageCodeProviderUsedVideoCredits = parseQuotaMap(task.ownerUsageCodeProviderUsedVideoCreditsJson)
  const currentProviderRemainingImageCredits = task.providerProfileId && ownerUsageCodeProviderImageQuotas
    ? Math.max(
      0,
      (ownerUsageCodeProviderImageQuotas[task.providerProfileId] ?? 0)
      - (ownerUsageCodeProviderUsedImageCredits?.[task.providerProfileId] ?? 0),
    )
    : null
  const currentProviderUsedImageCredits = task.providerProfileId
    ? (ownerUsageCodeProviderUsedImageCredits?.[task.providerProfileId] ?? 0)
    : null
  const currentProviderRemainingVideoCredits = task.providerProfileId && ownerUsageCodeProviderVideoQuotas
    ? Math.max(
      0,
      (ownerUsageCodeProviderVideoQuotas[task.providerProfileId] ?? 0)
      - (ownerUsageCodeProviderUsedVideoCredits?.[task.providerProfileId] ?? 0),
    )
    : null
  const currentProviderUsedVideoCredits = task.providerProfileId
    ? (ownerUsageCodeProviderUsedVideoCredits?.[task.providerProfileId] ?? 0)
    : null

  return {
    id: task.id,
    prompt: task.prompt,
    taskType: task.taskType ?? 'image',
    params: JSON.parse(task.paramsJson),
    providerProfileId: task.providerProfileId,
    providerProfileName: options.preferProviderRemark
      ? (options.providerProfile?.remarkName ?? options.providerProfile?.name ?? null)
      : (options.providerProfile?.name ?? null),
    providerProfileTagColor: options.providerProfile?.tagColor ?? null,
    providerProfileModel: options.providerProfile?.model ?? null,
    inputImageIds: inputImages.map((image) => image.id),
    outputImages: outputImages.map((image) => image.id),
    outputVideos: outputVideos.map((video) => video.id),
    maskImageId: maskImage?.id ?? null,
    maskTargetImageId: maskImage ? inputImages[0]?.id ?? null : null,
    imageUrlsById: buildImageUrlMap(images),
    imageThumbnailUrlsById: buildImageThumbnailUrlMap(images),
    imagePreviewUrlsById: buildImagePreviewUrlMap(images),
    mediaUrlsById: buildImageUrlMap(images),
    videoPosterUrlsById: buildVideoPosterUrlMap(images),
    imageSizesById: buildImageSizeMap(images),
    imageBytesById: buildImageBytesMap(images),
    videoMetadataById: buildVideoMetadataMap(outputVideos),
    status: toUiStatus(task.status),
    serverStatus: task.status,
    currentStep: task.currentStep,
    progressPercent: task.progressPercent,
    error: getTaskErrorForViewer(task, options.exposeDetailedError),
    ownerUsageCodeId: task.ownerUsageCodeId,
    ownerKind: task.ownerKind,
    ownerLabel,
    ownerUsageCode: task.ownerKind === 'usage_code' && task.ownerUsageCodeId
      ? {
          id: task.ownerUsageCodeId,
          name: task.ownerLabel,
          code: usageCodePlain,
          createdAt: task.ownerUsageCodeCreatedAt,
          lastUsedAt: task.ownerUsageCodeLastUsedAt,
          imageQuota: task.ownerUsageCodeImageQuota,
          usedImageCredits: task.ownerUsageCodeUsedImageCredits ?? 0,
          remainingImageCredits: task.ownerUsageCodeImageQuota == null
            ? null
            : Math.max(0, task.ownerUsageCodeImageQuota - (task.ownerUsageCodeUsedImageCredits ?? 0)),
          videoQuota: task.ownerUsageCodeVideoQuota,
          usedVideoCredits: task.ownerUsageCodeUsedVideoCredits ?? 0,
          remainingVideoCredits: task.ownerUsageCodeVideoQuota == null
            ? null
            : Math.max(0, task.ownerUsageCodeVideoQuota - (task.ownerUsageCodeUsedVideoCredits ?? 0)),
          taskCount: task.ownerUsageCodeTaskCount ?? 0,
          outputImageCount: task.ownerUsageCodeOutputImageCount ?? 0,
          providerOutputImageCount: task.ownerUsageCodeProviderOutputImageCount ?? 0,
          currentProviderUsedImageCredits,
          currentProviderRemainingImageCredits: currentProviderRemainingImageCredits ?? (
            task.ownerUsageCodeImageQuota == null
              ? null
              : Math.max(0, task.ownerUsageCodeImageQuota - (task.ownerUsageCodeUsedImageCredits ?? 0))
          ),
          outputVideoCount: task.ownerUsageCodeOutputVideoCount ?? 0,
          providerOutputVideoCount: task.ownerUsageCodeProviderOutputVideoCount ?? 0,
          currentProviderUsedVideoCredits,
          currentProviderRemainingVideoCredits: currentProviderRemainingVideoCredits ?? (
            task.ownerUsageCodeVideoQuota == null
              ? null
              : Math.max(0, task.ownerUsageCodeVideoQuota - (task.ownerUsageCodeUsedVideoCredits ?? 0))
          ),
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

export function loadSerializedTask(db: AppDatabase, taskId: string, options: { appSecret?: string; exposeUsageCodeAlias?: boolean; exposeDetailedError?: boolean; preferProviderRemark?: boolean } = {}) {
  const task = db.getTask(taskId)
  if (!task) return null
  const providerProfile = task.providerProfileId ? db.getProviderProfile(task.providerProfileId) : null
  return serializeTaskRecord(task, db.listTaskImages(taskId), { ...options, providerProfile })
}
