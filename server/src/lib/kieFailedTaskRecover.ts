import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppDatabase, ProviderProfileRecord, TaskRecord } from './db.js'
import { decryptText } from './crypto.js'
import type { GeneratedImageResult } from './imageApi.js'
import { writeOutputImage, writeOutputImageThumbnail } from './imageApi.js'
import {
  downloadKieResultUrls,
  recoverKieTaskOutputs,
} from './kieApi.js'
import { assertAllOutputImagesPersisted, createOutputImagePersistQueue } from './outputImagePersist.js'
import type { TaskEventBus } from './eventBus.js'

export type KieRecoverCandidate = {
  task: TaskRecord
  reason: 'has_task_id' | 'has_result_urls' | 'missing_upstream_ref'
  upstreamTaskId: string | null
  resultUrls: string[]
}

export type KieRecoverItemResult = {
  taskId: string
  status: 'recovered' | 'skipped' | 'failed'
  message: string
  imageCount?: number
  chargedCredits?: number
}

const NETWORK_FAIL_RE = /fetch failed|远端已出图但本地下载失败|远端图片下载失败|socket hang up|econnreset|etimedout|enotfound|und_err|network|aborted|timeout|terminated/i

export function isKieNetworkFailureMessage(message: string | null | undefined) {
  return NETWORK_FAIL_RE.test(String(message || ''))
}

export function parseUpstreamUsageJson(raw: string | null | undefined): {
  kieTaskId?: string
  kieResultUrls?: string[]
} {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const kieTaskId = typeof parsed.kieTaskId === 'string' ? parsed.kieTaskId.trim() : ''
    const urls = Array.isArray(parsed.kieResultUrls)
      ? parsed.kieResultUrls.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []
    return {
      kieTaskId: kieTaskId || undefined,
      kieResultUrls: urls,
    }
  } catch {
    return {}
  }
}

export function buildKieUpstreamUsageJson(input: {
  kieTaskId?: string | null
  kieResultUrls?: string[] | null
  previousJson?: string | null
}) {
  const prev = parseUpstreamUsageJson(input.previousJson)
  const next: Record<string, unknown> = { ...prev }
  if (input.kieTaskId?.trim()) next.kieTaskId = input.kieTaskId.trim()
  if (input.kieResultUrls && input.kieResultUrls.length > 0) next.kieResultUrls = input.kieResultUrls
  return JSON.stringify(next)
}

export function listKieNetworkFailureCandidates(
  db: AppDatabase,
  options: {
    providerById: Map<string, ProviderProfileRecord>
    limit?: number
    taskIds?: string[]
  },
): KieRecoverCandidate[] {
  const limit = Math.max(1, options.limit ?? 300)
  const tasks = options.taskIds?.length
    ? options.taskIds.map((id) => db.getTask(id)).filter((item): item is TaskRecord => Boolean(item))
    : db.listTasks(Math.max(limit * 8, 800))

  const out: KieRecoverCandidate[] = []
  for (const task of tasks) {
    if (out.length >= limit) break
    if (task.taskType === 'video') continue
    if (task.status !== 'failed') continue
    if (!isKieNetworkFailureMessage(task.errorMessage)) continue

    const provider = task.providerProfileId ? options.providerById.get(task.providerProfileId) : null
    if (!provider || provider.apiMode !== 'kie') continue

    const hasOutput = db.listTaskImages(task.id).some((image) => image.kind === 'output')
    if (hasOutput) continue

    const usage = parseUpstreamUsageJson(task.upstreamUsageJson)
    const upstreamTaskId = (task.upstreamRequestId || usage.kieTaskId || '').trim() || null
    const resultUrls = usage.kieResultUrls ?? []

    if (!upstreamTaskId && resultUrls.length === 0) {
      out.push({
        task,
        reason: 'missing_upstream_ref',
        upstreamTaskId: null,
        resultUrls: [],
      })
      continue
    }

    out.push({
      task,
      reason: upstreamTaskId ? 'has_task_id' : 'has_result_urls',
      upstreamTaskId,
      resultUrls,
    })
  }
  return out
}

async function persistRecoveredImages(input: {
  db: AppDatabase
  taskId: string
  outputsDir: string
  thumbsDir: string
  images: GeneratedImageResult[]
  isInactive?: () => boolean
}) {
  const outputDir = path.join(input.outputsDir, input.taskId)
  await fs.mkdir(outputDir, { recursive: true })
  const queue = createOutputImagePersistQueue<GeneratedImageResult>({
    isInactive: () => input.isInactive?.() ?? false,
    getItemKey: (image) => crypto.createHash('sha256').update(image.buffer).digest('hex'),
    persistOne: async (image) => {
      const outputImageId = crypto.randomUUID()
      const written = await writeOutputImage(outputDir, outputImageId, image)
      const saved = input.db.addTaskImage({
        id: outputImageId,
        taskId: input.taskId,
        kind: 'output',
        filePath: path.join('outputs', input.taskId, written.fileName),
        mimeType: written.mimeType,
        bytes: written.bytes,
        sha256: written.sha256,
        width: written.width,
        height: written.height,
      })
      if (!saved) return false

      const thumbnailDir = path.join(input.thumbsDir, input.taskId)
      const thumbnail = await writeOutputImageThumbnail(thumbnailDir, outputImageId, image)
      return Boolean(input.db.addTaskImage({
        id: crypto.randomUUID(),
        taskId: input.taskId,
        kind: 'thumb',
        filePath: path.join('thumbs', input.taskId, thumbnail.fileName),
        mimeType: thumbnail.mimeType,
        bytes: thumbnail.bytes,
        sha256: thumbnail.sha256,
        width: thumbnail.width,
        height: thumbnail.height,
        metadataJson: JSON.stringify({ imageId: outputImageId }),
      }))
    },
  })

  const ok = await queue.enqueue(input.images)
  if (!ok) throw new Error('输出图片保存失败')
  await queue.waitForIdle()
  assertAllOutputImagesPersisted(queue.getPersistedCount(), input.images.length)
  return input.images.length
}

function rechargeCreditsIfRefunded(db: AppDatabase, task: TaskRecord, imageCount: number) {
  if (task.ownerKind !== 'usage_code' || !task.ownerUsageCodeId || !task.providerProfileId) {
    return 0
  }
  const credits = Math.max(1, task.reservedImageCredits || imageCount || 1)
  const events = db.listUsageQuotaEventsForTask(task.id)
  const hasRefund = events.some((item) => item.eventType === 'refund')
  const hasRecoverCharge = events.some((item) => item.eventType === 'reserve' && item.reason === 'task_recover')
  if (!hasRefund || hasRecoverCharge) return 0

  db.reserveUsageCreditsForTaskRecover({
    usageCodeId: task.ownerUsageCodeId,
    taskId: task.id,
    credits,
    providerProfileId: task.providerProfileId,
  })
  return credits
}

export async function recoverOneKieFailedTask(input: {
  db: AppDatabase
  taskEvents?: TaskEventBus
  appSecret: string
  mediaDir: string
  outputsDir: string
  thumbsDir: string
  task: TaskRecord
  provider: ProviderProfileRecord
  upstreamTaskId?: string | null
  resultUrls?: string[]
}): Promise<KieRecoverItemResult> {
  const taskId = input.task.id
  try {
    if (input.db.listTaskImages(taskId).some((image) => image.kind === 'output')) {
      return { taskId, status: 'skipped', message: '已有输出图，跳过' }
    }

    const usage = parseUpstreamUsageJson(input.task.upstreamUsageJson)
    const upstreamTaskId = (input.upstreamTaskId || input.task.upstreamRequestId || usage.kieTaskId || '').trim()
    const resultUrls = (input.resultUrls && input.resultUrls.length > 0)
      ? input.resultUrls
      : (usage.kieResultUrls ?? [])

    if (!upstreamTaskId && resultUrls.length === 0) {
      return {
        taskId,
        status: 'skipped',
        message: '缺少上游 taskId / 结果 URL，无法自动重拉（历史任务兼容限制）',
      }
    }

    const apiKey = decryptText(input.provider.apiKeyEncrypted, input.appSecret)
    const runtimeProvider = input.task.providerProfileModel?.trim()
      ? { ...input.provider, model: input.task.providerProfileModel.trim() }
      : input.provider

    input.db.updateTaskProgress({
      id: taskId,
      status: 'processing',
      progressPercent: 70,
      currentStep: 'recovering',
      errorMessage: null,
      finishedAt: null,
      upstreamRequestId: upstreamTaskId || null,
      upstreamUsageJson: buildKieUpstreamUsageJson({
        kieTaskId: upstreamTaskId || null,
        kieResultUrls: resultUrls,
        previousJson: input.task.upstreamUsageJson,
      }),
    })
    const recoveringEvent = input.db.appendTaskEvent({
      taskId,
      status: 'processing',
      step: 'recovering',
      percent: 70,
      message: upstreamTaskId
        ? `按上游任务 ID 重新拉取：${upstreamTaskId}`
        : '按已缓存结果 URL 重新下载',
    })
    if (recoveringEvent && input.taskEvents) input.taskEvents.emit(taskId, recoveringEvent)

    let images: GeneratedImageResult[]
    if (upstreamTaskId) {
      images = await recoverKieTaskOutputs(runtimeProvider, apiKey, upstreamTaskId)
    } else {
      images = await downloadKieResultUrls(resultUrls)
    }

    input.db.updateTaskProgress({
      id: taskId,
      status: 'downloading',
      progressPercent: 90,
      currentStep: 'downloading',
      errorMessage: null,
      finishedAt: null,
    })

    const imageCount = await persistRecoveredImages({
      db: input.db,
      taskId,
      outputsDir: input.outputsDir,
      thumbsDir: input.thumbsDir,
      images,
    })

    let chargedCredits = 0
    let chargeNote = ''
    try {
      chargedCredits = rechargeCreditsIfRefunded(input.db, input.task, imageCount)
    } catch (chargeError) {
      chargeNote = chargeError instanceof Error ? chargeError.message : String(chargeError)
    }

    if (input.task.ownerKind === 'usage_code' && input.task.ownerUsageCodeId) {
      input.db.recordUsageCodeOutputImages({
        usageCodeId: input.task.ownerUsageCodeId,
        count: imageCount,
      })
      input.db.insertUsageCodeActivityLog({
        usageCodeId: input.task.ownerUsageCodeId,
        taskId,
        actorKind: 'system',
        eventType: 'image_task_succeeded',
        message: `网络失败任务恢复成功，图片 ${imageCount} 张`,
      })
    }

    const updated = input.db.updateTaskProgress({
      id: taskId,
      status: 'succeeded',
      progressPercent: 100,
      currentStep: 'succeeded',
      errorMessage: null,
      finishedAt: new Date().toISOString(),
      upstreamRequestId: upstreamTaskId || null,
      upstreamUsageJson: buildKieUpstreamUsageJson({
        kieTaskId: upstreamTaskId || null,
        kieResultUrls: resultUrls,
        previousJson: input.task.upstreamUsageJson,
      }),
    })
    const doneEvent = input.db.appendTaskEvent({
      taskId,
      status: 'succeeded',
      step: 'succeeded',
      percent: 100,
      message: `恢复完成，共 ${imageCount} 张图片`,
    })
    if (doneEvent && input.taskEvents) input.taskEvents.emit(taskId, doneEvent)

    if (!updated) {
      return { taskId, status: 'failed', message: '任务状态更新失败' }
    }

    return {
      taskId,
      status: 'recovered',
      message: chargeNote
        ? `恢复成功（图片已保存，但重新扣额度失败：${chargeNote}）`
        : chargedCredits > 0
          ? `恢复成功（重新扣回额度 ${chargedCredits}）`
          : '恢复成功',
      imageCount,
      chargedCredits,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 若恢复过程中图片已落盘，不再回写成 failed
    if (input.db.listTaskImages(taskId).some((image) => image.kind === 'output')) {
      return {
        taskId,
        status: 'recovered',
        message: `图片已保存，收尾异常：${message}`,
      }
    }
    input.db.updateTaskProgress({
      id: taskId,
      status: 'failed',
      progressPercent: 60,
      currentStep: 'failed',
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    })
    const failEvent = input.db.appendTaskEvent({
      taskId,
      status: 'failed',
      step: 'failed',
      percent: 60,
      message,
    })
    if (failEvent && input.taskEvents) input.taskEvents.emit(taskId, failEvent)
    return { taskId, status: 'failed', message }
  }
}

export async function recoverKieNetworkFailedTasks(input: {
  db: AppDatabase
  taskEvents?: TaskEventBus
  appSecret: string
  mediaDir: string
  outputsDir: string
  thumbsDir: string
  limit?: number
  taskIds?: string[]
  upstreamTaskIdByLocalId?: Record<string, string>
}): Promise<{
  total: number
  recovered: number
  skipped: number
  failed: number
  items: KieRecoverItemResult[]
}> {
  const providers = input.db.listProviderProfiles()
  const providerById = new Map(providers.map((item) => [item.id, item]))
  const candidates = listKieNetworkFailureCandidates(input.db, {
    providerById,
    limit: input.limit,
    taskIds: input.taskIds,
  })

  const items: KieRecoverItemResult[] = []
  for (const candidate of candidates) {
    const provider = candidate.task.providerProfileId
      ? providerById.get(candidate.task.providerProfileId)
      : null
    if (!provider) {
      items.push({
        taskId: candidate.task.id,
        status: 'skipped',
        message: 'provider 不存在',
      })
      continue
    }

    const overrideId = input.upstreamTaskIdByLocalId?.[candidate.task.id]?.trim() || ''
    const result = await recoverOneKieFailedTask({
      db: input.db,
      taskEvents: input.taskEvents,
      appSecret: input.appSecret,
      mediaDir: input.mediaDir,
      outputsDir: input.outputsDir,
      thumbsDir: input.thumbsDir,
      task: candidate.task,
      provider,
      upstreamTaskId: overrideId || candidate.upstreamTaskId,
      resultUrls: candidate.resultUrls,
    })
    items.push(result)
  }

  return {
    total: items.length,
    recovered: items.filter((item) => item.status === 'recovered').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items,
  }
}
