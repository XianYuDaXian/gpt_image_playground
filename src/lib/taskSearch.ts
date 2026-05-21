import type { AuthRole } from './backendAuth'
import { formatImageRatio } from './size'
import type { TaskParams, TaskRecord } from '../types'

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
  },
) {
  const queryText = options.query.trim()
  if (options.filterFavorite && !task.isFavorite) return false
  if (options.filterArchived ? !task.isArchived : task.isArchived) return false
  if (options.filterStatus !== 'all' && task.status !== options.filterStatus) return false
  if (options.filterTaskType !== 'all' && (task.taskType ?? 'image') !== options.filterTaskType) return false
  if (
    options.role === 'admin' &&
    !options.showUsageCodeTasksForAdmin &&
    task.ownerKind === 'usage_code' &&
    !queryText
  ) {
    return false
  }
  return matchesTaskSearch(task, queryText, options.role)
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

  const ownerSearchText = [
    task.ownerUsageCode?.code,
    role === 'admin' ? task.ownerLabel : null,
    role === 'admin' ? task.ownerUsageCode?.name : null,
  ].filter(Boolean).join(' ')

  const searchText = [
    task.prompt,
    JSON.stringify(task.params),
    requestedSizeText,
    imageSearchText,
    ownerSearchText,
  ].join(' ')

  return normalizeSearchText(searchText).includes(q)
}
