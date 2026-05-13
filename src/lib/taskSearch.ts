import type { AuthRole } from './backendAuth'
import { formatImageRatio } from './size'
import type { TaskRecord } from '../types'

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

  const requestedSizeMatch = /^(\d+)x(\d+)$/i.exec(task.params.size.replace(/×/g, 'x'))
  const requestedSizeText = requestedSizeMatch
    ? buildSizeSearchText(Number(requestedSizeMatch[1]), Number(requestedSizeMatch[2]))
    : task.params.size

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
