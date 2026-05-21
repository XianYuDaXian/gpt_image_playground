import type { TaskRecord } from '../types'

export function formatUsageCodeTooltip(task: TaskRecord, options: { showAlias?: boolean } = {}) {
  const code = task.ownerUsageCode
  if (!code) return task.ownerLabel ?? ''

  const createdAt = code.createdAt ? new Date(code.createdAt).toLocaleString('zh-CN') : '未知'
  return [
    ...(options.showAlias ? [`别名：${code.name}`] : []),
    `码值：${code.code ?? '无法恢复'}`,
    `创建日期：${createdAt}`,
    `总已生成图片：${code.outputImageCount}`,
    `当前 API 已生成图片：${code.providerOutputImageCount}`,
    `图片剩余额度：${code.remainingImageCredits ?? 0}`,
  ].join('\n')
}
