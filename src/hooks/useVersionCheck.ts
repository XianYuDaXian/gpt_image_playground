import { useEffect, useMemo, useState } from 'react'

function compareVersions(a: string, b: string) {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

export interface LatestRelease {
  tag: string
  url: string
  source: 'release' | 'tag'
}

interface LatestVersionResponse {
  repo?: string
  latest?: {
    tag?: string
    version?: string
    url?: string
    source?: 'release' | 'tag'
  } | null
}

/**
 * 检查当前 fork 仓库的最新版本。
 * - 由后端代理查询 GitHub，避免前端直接撞匿名限流。
 * - 优先使用 release，找不到时回退到 tag。
 * - 用户关闭后，仅对当前最新 tag 生效；发现更高版本会重新提示。
 */
export function useVersionCheck() {
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null)
  const [dismissedTag, setDismissedTag] = useState(() => sessionStorage.getItem('version-dismissed-tag'))

  useEffect(() => {
    let cancelled = false

    fetch('/api/meta/latest-version')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<LatestVersionResponse>
      })
      .then((data) => {
        if (cancelled) return

        const tag = data.latest?.tag?.trim() ?? ''
        const version = data.latest?.version?.trim() ?? tag.replace(/^v/i, '')
        const url = data.latest?.url?.trim() ?? ''
        const source = data.latest?.source ?? 'tag'

        if (!tag || !version || !url) return
        if (compareVersions(version, __APP_VERSION__) <= 0) return

        setLatestRelease({
          tag,
          url,
          source,
        })
      })
      .catch(() => {
        /* 静默失败，不影响正常使用 */
      })

    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    if (!latestRelease) return
    setDismissedTag(latestRelease.tag)
    sessionStorage.setItem('version-dismissed-tag', latestRelease.tag)
  }

  const hasUpdate = useMemo(
    () => latestRelease !== null && latestRelease.tag !== dismissedTag,
    [dismissedTag, latestRelease],
  )

  return { hasUpdate, latestRelease, dismiss }
}
