import type { TaskRecord } from '../types'
import { findTaskByImageId } from './resolveTaskImageDisplay'

export interface LightboxCompareTarget {
  compareImageId: string
  primaryLabel: string
  compareLabel: string
}

/** 解析大图叠图对比的另一侧图片 */
export function resolveLightboxCompareTarget(
  imageId: string,
  tasks: TaskRecord[],
): LightboxCompareTarget | null {
  const task = findTaskByImageId(imageId, tasks)
  if (!task || task.taskType === 'video') return null

  const isOutput = task.outputImages.includes(imageId)
  if (isOutput) {
    if (task.inputImageIds.length === 0) return null
    const compareImageId = task.maskTargetImageId && task.inputImageIds.includes(task.maskTargetImageId)
      ? task.maskTargetImageId
      : task.inputImageIds[0]
    return {
      compareImageId,
      primaryLabel: '生成图',
      compareLabel: '参考图',
    }
  }

  if (task.inputImageIds.includes(imageId)) {
    if (task.outputImages.length === 0) return null
    const inputIndex = task.inputImageIds.indexOf(imageId)
    const compareImageId = task.outputImages[Math.min(inputIndex, task.outputImages.length - 1)]
    return {
      compareImageId,
      primaryLabel: '参考图',
      compareLabel: '生成图',
    }
  }

  return null
}