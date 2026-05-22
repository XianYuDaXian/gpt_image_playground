import type { TaskRecord } from '../types'

export function formatUsageCodeTooltip(task: TaskRecord, options: { showAlias?: boolean } = {}) {
  const code = task.ownerUsageCode
  if (!code) return task.ownerLabel ?? ''

  return [
    `使用码别名：${code.name}`,
    `当前 API 已生成图片：${code.providerOutputImageCount}`,
    `当前 API 剩余图片数：${code.currentProviderRemainingImageCredits == null ? '不限' : code.currentProviderRemainingImageCredits}`,
  ].join('\n')
}
