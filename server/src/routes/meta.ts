import type { FastifyPluginAsync } from 'fastify'

type VersionSource = 'release' | 'tag'

interface GitHubVersionInfo {
  tag: string
  version: string
  url: string
  source: VersionSource
  checkedAt: string
}

let cachedVersionInfo: GitHubVersionInfo | null = null
let cachedAt = 0
let inflightRequest: Promise<GitHubVersionInfo | null> | null = null

const CACHE_TTL_MS = 15 * 60 * 1000

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

function normalizeVersionTag(tag: string) {
  const normalized = tag.trim().replace(/^v/i, '')
  if (!normalized) return null
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null
  return normalized
}

async function fetchJson(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'gpt-image-playground-server',
    },
    redirect: 'manual',
  })

  return response
}

async function fetchLatestRelease(owner: string, repo: string) {
  const response = await fetchJson(`https://github.com/${owner}/${repo}/releases/latest`)
  const location = response.headers.get('location')?.trim() ?? ''

  if (!location) return null

  const tagMatch = location.match(/\/releases\/tag\/(v?\d+(?:\.\d+)*)$/i)
  if (!tagMatch) return null

  const tag = tagMatch[1]
  const version = normalizeVersionTag(tag)
  if (!version) return null

  return {
    tag,
    version,
    url: location.startsWith('http') ? location : `https://github.com${location}`,
    source: 'release' as const,
    checkedAt: new Date().toISOString(),
  }
}

async function fetchLatestTag(owner: string, repo: string) {
  const response = await fetch(`https://github.com/${owner}/${repo}/tags`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'gpt-image-playground-server',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub Tags 页面响应异常: HTTP ${response.status}`)
  }

  const html = await response.text()
  const matches = html.matchAll(new RegExp(`href="/${owner}/${repo}/releases/tag/(v?\\d+(?:\\.\\d+)*)"`, 'gi'))
  let latest: GitHubVersionInfo | null = null

  for (const match of matches) {
    const tag = match[1]?.trim() ?? ''
    const version = normalizeVersionTag(tag)
    if (!version) continue

    if (!latest || compareVersions(version, latest.version) > 0) {
      latest = {
        tag,
        version,
        url: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
        source: 'tag',
        checkedAt: new Date().toISOString(),
      }
    }
  }

  return latest
}

async function resolveLatestVersion(owner: string, repo: string) {
  try {
    const release = await fetchLatestRelease(owner, repo)
    if (release) return release
  } catch {
    /* 没有 release、被限流或暂时失败时，继续回退到 tag */
  }

  return fetchLatestTag(owner, repo)
}

async function getLatestVersion(owner: string, repo: string) {
  const now = Date.now()
  if (cachedVersionInfo && now - cachedAt < CACHE_TTL_MS) {
    return cachedVersionInfo
  }

  if (!inflightRequest) {
    inflightRequest = resolveLatestVersion(owner, repo)
      .then((result) => {
        if (result) {
          cachedVersionInfo = result
          cachedAt = Date.now()
        }
        return result
      })
      .finally(() => {
        inflightRequest = null
      })
  }

  return inflightRequest
}

export const metaRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/meta/latest-version', async () => {
    let latest: GitHubVersionInfo | null = null

    try {
      latest = await getLatestVersion(app.config.versionCheckRepoOwner, app.config.versionCheckRepoName)
    } catch (error) {
      app.log.warn(error, '获取远端版本信息失败')
    }

    return {
      repo: `${app.config.versionCheckRepoOwner}/${app.config.versionCheckRepoName}`,
      latest,
    }
  })
}
