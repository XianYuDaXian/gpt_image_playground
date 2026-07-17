export type TaskListRequestKey = {
  page: number
  pageSize: number
  searchTags: string[]
  searchTagMode: 'include' | 'exclude'
  status: 'all' | 'running' | 'done' | 'error'
  taskType: 'all' | 'image' | 'video'
  favorite: boolean
  archived: boolean
  showUsageCodeTasksForAdmin: boolean
}

export function buildTaskListRequestKey(input: TaskListRequestKey): TaskListRequestKey {
  return {
    page: Math.max(1, Math.floor(input.page) || 1),
    pageSize: Math.max(1, Math.floor(input.pageSize) || 50),
    searchTags: input.searchTags.map((tag) => tag.trim()).filter(Boolean),
    searchTagMode: input.searchTagMode === 'exclude' ? 'exclude' : 'include',
    status: input.status,
    taskType: input.taskType,
    favorite: Boolean(input.favorite),
    archived: Boolean(input.archived),
    showUsageCodeTasksForAdmin: Boolean(input.showUsageCodeTasksForAdmin),
  }
}

export function isSameTaskListRequestKey(
  a: TaskListRequestKey | null | undefined,
  b: TaskListRequestKey | null | undefined,
): boolean {
  if (!a || !b) return false
  if (a.page !== b.page) return false
  if (a.pageSize !== b.pageSize) return false
  if (a.searchTagMode !== b.searchTagMode) return false
  if (a.status !== b.status) return false
  if (a.taskType !== b.taskType) return false
  if (a.favorite !== b.favorite) return false
  if (a.archived !== b.archived) return false
  if (a.showUsageCodeTasksForAdmin !== b.showUsageCodeTasksForAdmin) return false
  if (a.searchTags.length !== b.searchTags.length) return false
  return a.searchTags.every((tag, index) => tag === b.searchTags[index])
}

export function canApplyTaskListResult(input: {
  responseSeq: number
  lastAppliedSeq: number
  inFlightSeq: number | null
  requestKey: TaskListRequestKey
  currentKey: TaskListRequestKey
}): boolean {
  if (input.responseSeq < input.lastAppliedSeq) return false
  if (input.inFlightSeq != null && input.responseSeq !== input.inFlightSeq) return false
  return isSameTaskListRequestKey(input.requestKey, input.currentKey)
}

export function clampTaskPage(input: {
  page: number
  total: number
  pageSize: number
}): number {
  const pageSize = Math.max(1, Math.floor(input.pageSize) || 1)
  const totalPages = Math.max(1, Math.ceil(Math.max(0, input.total) / pageSize))
  const page = Math.max(1, Math.floor(input.page) || 1)
  return Math.min(page, totalPages)
}
