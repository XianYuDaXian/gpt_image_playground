import type { TaskRecord } from '../types'

export function formatUsageCodeTooltip(task: TaskRecord) {
  const code = task.ownerUsageCode
  if (!code) return task.ownerLabel ?? ''

  const createdAt = code.createdAt ? new Date(code.createdAt).toLocaleString('zh-CN') : '未知'
  const quota = code.imageQuota == null ? '不限' : String(code.imageQuota)
  const remaining = code.remainingImageCredits == null ? '不限' : String(code.remainingImageCredits)

  return [
    `码值：${code.code ?? '无法恢复'}`,
    `创建日期：${createdAt}`,
    `总已生成图片：${code.outputImageCount}`,
    `当前已用/可用：${code.usedImageCredits}/${quota}`,
    `剩余额度：${remaining}`,
  ].join('\n')
}
