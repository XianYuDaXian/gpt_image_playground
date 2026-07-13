import type { AppSettings } from '../types'

export interface ProviderUnusedUsageCodeSource {
  id: string
  name: string
  code?: string | null
  allowedProviderProfileIds?: string[] | null
  providerImageQuotas?: Record<string, number | null> | null
  providerVideoQuotas?: Record<string, number | null> | null
  providerRemainingImageCredits?: Record<string, number | null> | null
  providerRemainingVideoCredits?: Record<string, number | null> | null
  providerUsedImageCredits?: Record<string, number | null> | null
  providerUsedVideoCredits?: Record<string, number | null> | null
}

export interface ProviderUnusedUsageCodeItem {
  id: string
  name: string
  remaining: number | null
  /** 明文使用码，可能为空（旧码不可恢复） */
  code: string | null
}

/** 已用明细项：按已用次数展示 */
export interface ProviderUsedUsageCodeItem {
  id: string
  name: string
  used: number
  code: string | null
}

function isAllowedForProvider(
  allowedProviderProfileIds: string[] | null | undefined,
  profileId: string,
) {
  if (allowedProviderProfileIds == null) return true
  if (allowedProviderProfileIds.length === 0) return false
  return allowedProviderProfileIds.includes(profileId)
}

function isExplicitUnlimited(
  code: ProviderUnusedUsageCodeSource,
  profileId: string,
  apiMode: AppSettings['apiMode'],
) {
  const quotas = apiMode === 'videos' ? code.providerVideoQuotas : code.providerImageQuotas
  if (!quotas || !Object.prototype.hasOwnProperty.call(quotas, profileId)) return false
  return quotas[profileId] == null
}

function readRemaining(
  code: ProviderUnusedUsageCodeSource,
  profileId: string,
  apiMode: AppSettings['apiMode'],
) {
  return apiMode === 'videos'
    ? code.providerRemainingVideoCredits?.[profileId]
    : code.providerRemainingImageCredits?.[profileId]
}

function readUsed(
  code: ProviderUnusedUsageCodeSource,
  profileId: string,
  apiMode: AppSettings['apiMode'],
) {
  return apiMode === 'videos'
    ? code.providerUsedVideoCredits?.[profileId]
    : code.providerUsedImageCredits?.[profileId]
}

function resolveDisplayName(code: ProviderUnusedUsageCodeSource) {
  const name = code.name?.trim()
  if (name) return name
  const fallback = code.code?.trim()
  return fallback || code.id
}

export function listProviderUnusedUsageCodes(
  usageCodes: ProviderUnusedUsageCodeSource[],
  profileId: string,
  apiMode: AppSettings['apiMode'],
): ProviderUnusedUsageCodeItem[] {
  const items: ProviderUnusedUsageCodeItem[] = []

  for (const code of usageCodes) {
    if (!isAllowedForProvider(code.allowedProviderProfileIds, profileId)) continue

    const remaining = readRemaining(code, profileId, apiMode)
    const plainCode = code.code?.trim() || null
    if (typeof remaining === 'number') {
      if (remaining > 0) {
        items.push({ id: code.id, name: resolveDisplayName(code), remaining, code: plainCode })
      }
      continue
    }

    // remaining 为 null/undefined：仅显式不限配额才展示
    if (isExplicitUnlimited(code, profileId, apiMode)) {
      items.push({ id: code.id, name: resolveDisplayName(code), remaining: null, code: plainCode })
    }
  }

  return items.sort((left, right) => {
    if (left.remaining == null && right.remaining != null) return -1
    if (left.remaining != null && right.remaining == null) return 1
    if (left.remaining != null && right.remaining != null && left.remaining !== right.remaining) {
      return right.remaining - left.remaining
    }
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

/**
 * 已用明细：授权该端点且 used>0，按已用降序，同值按备注名 zh-CN
 */
export function listProviderUsedUsageCodes(
  usageCodes: ProviderUnusedUsageCodeSource[],
  profileId: string,
  apiMode: AppSettings['apiMode'],
): ProviderUsedUsageCodeItem[] {
  const items: ProviderUsedUsageCodeItem[] = []

  for (const code of usageCodes) {
    if (!isAllowedForProvider(code.allowedProviderProfileIds, profileId)) continue

    const usedRaw = readUsed(code, profileId, apiMode)
    const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? Math.max(0, usedRaw) : 0
    if (used <= 0) continue

    items.push({
      id: code.id,
      name: resolveDisplayName(code),
      used,
      code: code.code?.trim() || null,
    })
  }

  return items.sort((left, right) => {
    if (left.used !== right.used) return right.used - left.used
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

/** 端点已用合计（仅统计授权码的 used） */
export function sumProviderUsedUsageCodes(
  usageCodes: ProviderUnusedUsageCodeSource[],
  profileId: string,
  apiMode: AppSettings['apiMode'],
) {
  return listProviderUsedUsageCodes(usageCodes, profileId, apiMode)
    .reduce((sum, item) => sum + item.used, 0)
}

export function formatProviderUnusedRemaining(remaining: number | null) {
  return remaining == null ? '不限' : String(remaining)
}

export function formatProviderUsedCount(used: number) {
  return String(used)
}
