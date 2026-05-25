import type { TaskRecord } from '../types'

export function formatUsageCodeTooltip(task: TaskRecord) {
  const code = task.ownerUsageCode
  if (!code) return task.ownerLabel ?? ''

  const isVideoTask = task.taskType === 'video'
  return [
    `使用码：${code.code ?? task.ownerLabel ?? '未知'}`,
    isVideoTask
      ? `当前 API 已生成视频：${code.providerOutputVideoCount}`
      : `当前 API 已生成图片：${code.providerOutputImageCount}`,
    isVideoTask
      ? `当前 API 剩余视频数：${code.currentProviderRemainingVideoCredits == null ? '不限' : code.currentProviderRemainingVideoCredits}`
      : `当前 API 剩余图片数：${code.currentProviderRemainingImageCredits == null ? '不限' : code.currentProviderRemainingImageCredits}`,
  ].join('\n')
}
