// ===== 设置 =====

export type ApiMode = 'images' | 'responses' | 'videos'
export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  baseUrl: string
  apiKey: string
  apiKeyMasked?: string | null
  apiKeyConfigured?: boolean
  providerProfileId?: string | null
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
  grokApiCompat: boolean
  xaiImage2kEnabled: boolean
  responseFormatB64Json: boolean
  videoMaxResolution?: '480p' | '720p'
  videoMaxDuration?: 6 | 10 | 15
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  showUsageCodeAliasOnTaskCard: boolean
  updatedAt?: number
}

const DEFAULT_BASE_URL = import.meta.env.VITE_DEFAULT_API_URL?.trim() || 'https://api.openai.com/v1'
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  apiKeyMasked: null,
  apiKeyConfigured: false,
  providerProfileId: null,
  model: DEFAULT_IMAGES_MODEL,
  timeout: 300,
  apiMode: 'images',
  codexCli: false,
  grokApiCompat: false,
  xaiImage2kEnabled: false,
  responseFormatB64Json: false,
  videoMaxResolution: '480p',
  videoMaxDuration: 6,
  clearInputAfterSubmit: false,
  persistInputOnRestart: true,
  reuseTaskApiProfileTemporarily: false,
  alwaysShowRetryButton: false,
  showUsageCodeAliasOnTaskCard: false,
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

export interface VideoTaskParams {
  aspect_ratio: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'
  resolution: '480p' | '720p'
  duration: 6 | 10 | 15
}

export const DEFAULT_VIDEO_PARAMS: VideoTaskParams = {
  aspect_ratio: 'auto',
  resolution: '480p',
  duration: 6,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  prompt: string
  taskType?: 'image' | 'video'
  params: TaskParams | VideoTaskParams
  providerProfileId?: string | null
  providerProfileName?: string | null
  providerProfileTagColor?: string | null
  providerProfileModel?: string | null
  /** 最近一次写入时间（ms） */
  updatedAt?: number
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  /** 输出视频的 media store id 列表 */
  outputVideos?: string[]
  imageUrlsById?: Record<string, string>
  imageThumbnailUrlsById?: Record<string, string>
  imagePreviewUrlsById?: Record<string, string>
  mediaUrlsById?: Record<string, string>
  videoPosterUrlsById?: Record<string, string>
  imageSizesById?: Record<string, { width: number | null; height: number | null }>
  imageBytesById?: Record<string, number>
  videoMetadataById?: Record<string, { duration?: number | null }>
  status: TaskStatus
  serverStatus?: string
  queueRuntimeStatus?: 'idle' | 'queued' | 'running'
  queuePosition?: number | null
  queueAhead?: number | null
  runningTaskCount?: number
  pendingTaskCount?: number
  currentStep?: string
  progressPercent?: number
  error: string | null
  ownerUsageCodeId?: string | null
  ownerKind?: 'admin' | 'usage_code' | 'legacy'
  ownerLabel?: string
  ownerUsageCode?: {
    id: string
    name: string
    code: string | null
    createdAt: string | null
    lastUsedAt: string | null
    imageQuota: number | null
    usedImageCredits: number
    remainingImageCredits: number | null
    videoQuota: number | null
    usedVideoCredits: number
    remainingVideoCredits: number | null
    taskCount: number
    outputImageCount: number
    providerOutputImageCount: number
    currentProviderUsedImageCredits: number | null
    currentProviderRemainingImageCredits: number | null
    outputVideoCount: number
    providerOutputVideoCount: number
    currentProviderUsedVideoCredits: number | null
    currentProviderRemainingVideoCredits: number | null
  } | null
  reservedImageCredits?: number
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
  /** 是否归档 */
  isArchived?: boolean
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片最近一次写入时间（ms） */
  updatedAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 */
  source?: 'upload' | 'generated' | 'mask'
  /** 原图宽度 */
  width?: number
  /** 原图高度 */
  height?: number
}

export interface StoredImageThumbnail {
  id: string
  /** 列表缩略图，用于避免历史卡片解码完整大图 */
  thumbnailDataUrl: string
  width?: number
  height?: number
  thumbnailVersion?: number
}

