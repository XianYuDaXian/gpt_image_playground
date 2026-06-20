import type { AuthRole } from './backendAuth'
import { formatImageRatio } from './size'
import type { TaskParams, TaskRecord, VideoTaskParams } from '../types'

export type SearchTagMode = 'include' | 'exclude'

export function matchesTaskFilters(
  task: TaskRecord,
  options: {
    filterStatus: 'all' | 'running' | 'done' | 'error'
    filterTaskType: 'all' | 'image' | 'video'
    filterFavorite: boolean
    filterArchived: boolean
    role: AuthRole | null | undefined
    showUsageCodeTasksForAdmin: boolean
    query: string
    tags?: string[]
    tagMode?: SearchTagMode
  },
) {
  const queryText = options.query.trim()
  const tags = options.tags?.map((tag) => tag.trim()).filter(Boolean) ?? []
  const tagMode = options.tagMode ?? 'include'
  if (options.filterFavorite && !task.isFavorite) return false
  if (options.filterArchived ? !task.isArchived : task.isArchived) return false
  if (options.filterStatus !== 'all' && task.status !== options.filterStatus) return false
  if (options.filterTaskType !== 'all' && (task.taskType ?? 'image') !== options.filterTaskType) return false
  if (
    options.role === 'admin' &&
    !options.showUsageCodeTasksForAdmin &&
    task.ownerKind === 'usage_code' &&
    !queryText &&
    tags.length === 0
  ) {
    return false
  }
  if (!matchesTaskSearch(task, queryText, options.role)) return false
  if (tags.length === 0) return true
  if (tagMode === 'exclude') {
    return !tags.some((tag) => matchesTaskSearch(task, tag, options.role))
  }
  return tags.every((tag) => matchesTaskSearch(task, tag, options.role))
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/：/g, ':')
}

function buildSizeSearchText(width: number, height: number) {
  return [
    `${width}x${height}`,
    `${width}×${height}`,
    formatImageRatio(width, height),
  ].join(' ')
}

function buildOwnerSearchText(task: TaskRecord, role: AuthRole | null | undefined) {
  const ownerTerms = [task.ownerUsageCode?.code]
  if (role === 'admin') {
    ownerTerms.push(task.ownerLabel)
    ownerTerms.push(task.ownerUsageCode?.name)
  }
  return ownerTerms.filter(Boolean).join(' ')
}

function getImageParamDisplayValue(task: TaskRecord, paramKey: keyof TaskParams, actualParams = task.actualParams) {
  const params = task.params as TaskParams
  const requestedValue = params[paramKey]
  const actualValue = paramKey === 'n' && task.outputImages?.length > 0
    ? task.outputImages.length
    : actualParams?.[paramKey]
  return String(actualValue ?? requestedValue ?? '')
}

function buildCardTagSearchText(task: TaskRecord, role: AuthRole | null | undefined) {
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
    const videoParams = task.params as VideoTaskParams
    tagTerms.push(videoParams.aspect_ratio)
    tagTerms.push(videoParams.resolution)
    tagTerms.push(String(videoParams.duration))
    tagTerms.push(`${videoParams.duration}s`)
  } else {
    const aggregateActualParams = task.outputImages?.length > 0
      ? { ...task.actualParams, n: task.outputImages.length }
      : task.actualParams
    tagTerms.push(getImageParamDisplayValue(task, 'quality'))
    tagTerms.push(getImageParamDisplayValue(task, 'size'))
    tagTerms.push(getImageParamDisplayValue(task, 'output_format'))
    tagTerms.push(getImageParamDisplayValue(task, 'n', aggregateActualParams))
  }

  return tagTerms.filter(Boolean).join(' ')
}

export function matchesTaskSearch(task: TaskRecord, query: string, role: AuthRole | null | undefined) {
  const q = normalizeSearchText(query.trim())
  if (!q) return true

  const imageParams = task.taskType === 'video' ? null : task.params as TaskParams
  const requestedSizeMatch = imageParams ? /^(\d+)x(\d+)$/i.exec(imageParams.size.replace(/×/g, 'x')) : null
  const requestedSizeText = imageParams
    ? requestedSizeMatch
      ? buildSizeSearchText(Number(requestedSizeMatch[1]), Number(requestedSizeMatch[2]))
      : imageParams.size
    : ''

  const imageSearchText = task.outputImages
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
    requestedSizeText,
    imageSearchText,
    ownerSearchText,
    buildCardTagSearchText(task, role),
  ].join(' ')

  return normalizeSearchText(searchText).includes(q)
}
