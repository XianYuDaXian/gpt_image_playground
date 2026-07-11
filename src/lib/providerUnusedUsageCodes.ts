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
}

export interface ProviderUnusedUsageCodeItem {
  id: string
  name: string
  remaining: number | null
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
    if (typeof remaining === 'number') {
      if (remaining > 0) {
        items.push({ id: code.id, name: resolveDisplayName(code), remaining })
      }
      continue
    }

    // remaining 为 null/undefined：仅显式不限配额才展示
    if (isExplicitUnlimited(code, profileId, apiMode)) {
      items.push({ id: code.id, name: resolveDisplayName(code), remaining: null })
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

export function formatProviderUnusedRemaining(remaining: number | null) {
  return remaining == null ? '不限' : String(remaining)
}
