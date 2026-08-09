// 任务搜索文本的构建与匹配纯函数模块。
// 过滤阶段（轻量行）与序列化阶段共用同一套规则，保证搜索语义一致。

export type UiTaskStatus = 'done' | 'error' | 'running'

export type AuthRoleForSearch = 'admin' | 'user'

export function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/：/g, ':')
}

export function formatImageRatio(width: number, height: number) {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (!Number.isFinite(roundedWidth) || !Number.isFinite(roundedHeight) || roundedWidth <= 0 || roundedHeight <= 0) {
    return ''
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(roundedWidth, roundedHeight)
  return `${roundedWidth / divisor}:${roundedHeight / divisor}`
}

export function buildSizeSearchText(width: number, height: number) {
  return [`${width}x${height}`, `${width}×${height}`, formatImageRatio(width, height)].join(' ')
}

export function toUiStatus(status: string): UiTaskStatus {
  if (status === 'failed' || status === 'canceled') return 'error'
  if (status === 'succeeded') return 'done'
  return 'running'
}

// 过滤与序列化共用的搜索对象。
export interface SearchableTask {
  prompt: string
  params: Record<string, unknown>
  taskType: 'image' | 'video'
  uiStatus: UiTaskStatus
  currentStep: string | null
  maskImageId: string | null
  providerProfileName: string | null
  providerProfileId: string | null
  providerProfileModel: string | null
  ownerLabel: string
  ownerUsageCodeName: string | null
  ownerUsageCodeCode: string | null
  outputImageCount: number
  outputImageSizes: Array<{ width: number | null; height: number | null }>
}

// 轻量查询行的搜索输入（原始数据库字段）。
export interface SearchableRowInput {
  prompt: string
  paramsJson: string
  taskType: 'image' | 'video'
  status: string
  currentStep: string | null
  providerProfileId: string | null
  providerProfileModel: string | null
  ownerKind: 'admin' | 'usage_code' | 'legacy'
  ownerLabel: string
  ownerUsageCodeCode: string | null
}

// 序列化后任务的搜索输入（用于等价性验证与序列化阶段复用）。
export interface SerializedTaskSearchInput {
  prompt: string
  params: Record<string, unknown> | null
  taskType: 'image' | 'video'
  status: UiTaskStatus
  currentStep: string | null
  maskImageId: string | null
  providerProfileName: string | null
  providerProfileId: string | null
  providerProfileModel: string | null
  ownerKind: 'admin' | 'usage_code' | 'legacy'
  ownerLabel: string
  ownerUsageCode: { code: string | null; name: string } | null
  outputImages: string[]
  imageSizesById: Record<string, { width: number | null; height: number | null }>
}

export function searchableFromRow(
  row: SearchableRowInput,
  images: Array<{ kind: string; id: string; width: number | null; height: number | null }>,
  provider: { name: string; remarkName: string | null } | null,
  role: AuthRoleForSearch,
): SearchableTask {
  let maskImageId: string | null = null
  const outputImageSizes: Array<{ width: number | null; height: number | null }> = []
  for (const image of images) {
    if (image.kind === 'mask') maskImageId = image.id
    if (image.kind === 'output') {
      outputImageSizes.push({ width: image.width, height: image.height })
    }
  }

  let params: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.paramsJson) as unknown
    if (parsed && typeof parsed === 'object') params = parsed as Record<string, unknown>
  } catch {
    // 解析失败时保持空对象，避免影响搜索
  }

  const plainCode = row.ownerUsageCodeCode
  const isUserCodeOwner = row.ownerKind === 'usage_code' && role === 'user'
  return {
    prompt: row.prompt,
    params,
    taskType: row.taskType,
    uiStatus: toUiStatus(row.status),
    currentStep: row.currentStep,
    maskImageId,
    providerProfileName: provider
      ? role === 'admin' ? (provider.remarkName ?? provider.name) : provider.name
      : null,
    providerProfileId: row.providerProfileId,
    providerProfileModel: row.providerProfileModel,
    ownerLabel: isUserCodeOwner ? plainCode ?? '使用码' : row.ownerLabel,
    ownerUsageCodeName: row.ownerKind === 'usage_code'
      ? (role === 'admin' ? row.ownerLabel : plainCode ?? '使用码')
      : null,
    ownerUsageCodeCode: plainCode,
    outputImageCount: outputImageSizes.length,
    outputImageSizes,
  }
}

export function searchableFromSerialized(task: SerializedTaskSearchInput): SearchableTask {
  return {
    prompt: task.prompt,
    params: task.params ?? {},
    taskType: task.taskType,
    uiStatus: task.status,
    currentStep: task.currentStep,
    maskImageId: task.maskImageId,
    providerProfileName: task.providerProfileName,
    providerProfileId: task.providerProfileId,
    providerProfileModel: task.providerProfileModel,
    ownerLabel: task.ownerLabel,
    ownerUsageCodeName: task.ownerKind === 'usage_code' ? task.ownerUsageCode?.name ?? null : null,
    ownerUsageCodeCode: task.ownerUsageCode?.code ?? null,
    outputImageCount: task.outputImages.length,
    outputImageSizes: task.outputImages.map((id) => task.imageSizesById[id] ?? { width: null, height: null }),
  }
}

function getImageParamDisplayValue(
  task: SearchableTask,
  paramKey: 'quality' | 'size' | 'output_format' | 'n',
) {
  const requestedValue = task.params[paramKey]
  const actualValue = paramKey === 'n' && task.outputImageCount > 0
    ? task.outputImageCount
    : undefined
  return String(actualValue ?? requestedValue ?? '')
}

function buildOwnerSearchText(task: SearchableTask, role: AuthRoleForSearch) {
  const ownerTerms: Array<string | null | undefined> = [task.ownerUsageCodeCode]
  if (role === 'admin') {
    ownerTerms.push(task.ownerLabel)
    ownerTerms.push(task.ownerUsageCodeName)
  }
  return ownerTerms.filter(Boolean).join(' ')
}

function buildCardTagSearchText(task: SearchableTask, role: AuthRoleForSearch) {
  const isVideoTask = task.taskType === 'video'
  const tagTerms: Array<string | number | null | undefined> = [
    isVideoTask ? '视频 video' : '图片 image',
    task.uiStatus === 'running' ? '生成中 running' : task.uiStatus === 'done' ? '已完成 done' : '失败 error',
    task.maskImageId ? 'mask 遮罩' : '',
    task.currentStep,
    task.providerProfileName,
    task.providerProfileId,
    role === 'admin' ? task.providerProfileModel : null,
    task.ownerLabel,
    task.ownerUsageCodeName,
    task.ownerUsageCodeCode,
  ]

  if (isVideoTask) {
    const videoParams = task.params
    tagTerms.push(String(videoParams.aspect_ratio ?? ''))
    tagTerms.push(String(videoParams.resolution ?? ''))
    tagTerms.push(String(videoParams.duration))
    tagTerms.push(`${String(videoParams.duration)}s`)
  } else {
    tagTerms.push(getImageParamDisplayValue(task, 'quality'))
    tagTerms.push(getImageParamDisplayValue(task, 'size'))
    tagTerms.push(getImageParamDisplayValue(task, 'output_format'))
    tagTerms.push(getImageParamDisplayValue(task, 'n'))
  }

  return tagTerms.filter(Boolean).join(' ')
}

export function buildTaskSearchText(task: SearchableTask, role: AuthRoleForSearch) {
  const imageSearchText = task.outputImageSizes
    .map((size) => {
      if (!size?.width || !size.height) return ''
      return buildSizeSearchText(size.width, size.height)
    })
    .join(' ')

  const ownerSearchText = buildOwnerSearchText(task, role)

  return [
    task.prompt,
    JSON.stringify(task.params),
    imageSearchText,
    ownerSearchText,
    buildCardTagSearchText(task, role),
  ].join(' ')
}

export function matchesTaskSearch(task: SearchableTask, query: string, role: AuthRoleForSearch) {
  const q = normalizeSearchText(query.trim())
  if (!q) return true
  return normalizeSearchText(buildTaskSearchText(task, role)).includes(q)
}

export function matchesSearchTags(
  task: SearchableTask,
  query: string,
  tags: string[],
  mode: 'include' | 'exclude',
  role: AuthRoleForSearch,
) {
  if (!matchesTaskSearch(task, query, role)) return false
  if (tags.length === 0) return true
  if (mode === 'exclude') {
    return !tags.some((tag) => matchesTaskSearch(task, tag, role))
  }
  return tags.every((tag) => matchesTaskSearch(task, tag, role))
}