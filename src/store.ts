import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ThemeMode,
  VideoTaskParams,
} from './types'
import { DEFAULT_SETTINGS, DEFAULT_PARAMS, DEFAULT_VIDEO_PARAMS } from './types'
import {
  CURRENT_THUMBNAIL_VERSION,
  createAndStoreImageThumbnail,
  createAndStoreVideoThumbnail,
  getCachedVideoBlob,
  getImage,
  getStoredFreshImageThumbnail,
  deleteImage,
  clearImages,
  getAllImages,
  putCachedVideoBlob,
  storeImage,
  putImage,
} from './lib/db'
import { fetchBackendRuntimeSettings } from './lib/backendSettings'
import { fetchAuthStatus, logoutAuth, type AuthStatus } from './lib/backendAuth'
import { createBackendTask, deleteBackendTask, fetchBackendTaskPage, updateBackendTaskFlags } from './lib/backendTasks'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask, validateMaskTarget } from './lib/mask'
import { remapImageMentionsForOrder, replaceImageMentionsForApi, replaceImageMentionsForVideoApi } from './lib/promptImageMentions'
import { normalizeImageSize } from './lib/size'
import { clearAnnouncementLocalState } from './lib/announcement'

// ===== Image cache =====
// 内存缓存，id → dataUrl，避免每次从 IndexedDB 读取

const imageCache = new Map<string, string>()
const videoUrlCache = new Map<string, string>()
const thumbnailCache = new Map<string, { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }>()
const thumbnailSubscribers = new Map<string, Set<(thumbnail: { dataUrl: string; width?: number; height?: number }) => void>>()
const thumbnailBackfillIds = new Set<string>()
const thumbnailBackfillRunningIds = new Set<string>()
const videoLoadPromises = new Map<string, Promise<string | undefined>>()
const taskEventSources = new Map<string, EventSource>()
let taskListEventSource: EventSource | null = null
let taskStreamInitialized = false
let taskRefreshLifecycleInitialized = false
let thumbnailBackfillScheduled = false
const MAX_IMAGE_CACHE_ENTRIES = 8
const MAX_THUMBNAIL_CACHE_ENTRIES = 80

function stripInputImageDataUrls(inputImages: InputImage[]) {
  return inputImages.map((image) => ({
    id: image.id,
    dataUrl: '',
  }))
}

function stripMaskDraftDataUrl(maskDraft: MaskDraft | null) {
  if (!maskDraft) return null
  return null
}

function sortTasksForDisplay(tasks: TaskRecord[]) {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt)
}

function mergeLocalTaskFlags(serverTasks: TaskRecord[]) {
  return serverTasks
}

function getAutoLoadedCompletedImageIds(prevTasks: TaskRecord[], nextTasks: TaskRecord[]) {
  const prevById = new Map(prevTasks.map((task) => [task.id, task]))
  const imageIds: string[] = []

  for (const task of nextTasks) {
    const prevTask = prevById.get(task.id)
    if (prevTask?.status !== 'running' || task.status !== 'done') continue
    imageIds.push(...task.outputImages)
  }

  return imageIds
}

export function getCachedImage(id: string): string | undefined {
  const dataUrl = imageCache.get(id)
  if (dataUrl) {
    imageCache.delete(id)
    imageCache.set(id, dataUrl)
  }
  return dataUrl
}

function cacheImage(id: string, dataUrl: string) {
  imageCache.delete(id)
  imageCache.set(id, dataUrl)
  while (imageCache.size > MAX_IMAGE_CACHE_ENTRIES) {
    const oldestKey = imageCache.keys().next().value
    if (oldestKey == null) break
    imageCache.delete(oldestKey)
  }
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  if (imageCache.has(id)) return imageCache.get(id)
  const rec = await getImage(id)
  if (rec) {
    cacheImage(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

function revokeCachedVideoUrl(id: string) {
  const objectUrl = videoUrlCache.get(id)
  if (!objectUrl) return
  URL.revokeObjectURL(objectUrl)
  videoUrlCache.delete(id)
}

function cacheVideoUrl(id: string, objectUrl: string) {
  revokeCachedVideoUrl(id)
  videoUrlCache.set(id, objectUrl)
}

export function getCachedVideoUrl(id: string): string | undefined {
  const objectUrl = videoUrlCache.get(id)
  if (objectUrl) {
    videoUrlCache.delete(id)
    videoUrlCache.set(id, objectUrl)
  }
  return objectUrl
}

export async function ensureVideoCached(id: string): Promise<string | undefined> {
  const cachedObjectUrl = getCachedVideoUrl(id)
  if (cachedObjectUrl) return cachedObjectUrl

  const cachedBlob = await getCachedVideoBlob(id)
  if (!cachedBlob) return undefined

  const objectUrl = URL.createObjectURL(cachedBlob)
  cacheVideoUrl(id, objectUrl)
  return objectUrl
}

export function primeImageCache(images: Array<{ id: string; dataUrl: string }>) {
  for (const img of images) {
    cacheImage(img.id, img.dataUrl)
  }
}

function cacheThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number; thumbnailVersion?: number }) {
  if (thumbnail.thumbnailVersion !== CURRENT_THUMBNAIL_VERSION) return
  thumbnailCache.delete(id)
  thumbnailCache.set(id, thumbnail)
  while (thumbnailCache.size > MAX_THUMBNAIL_CACHE_ENTRIES) {
    const oldestKey = thumbnailCache.keys().next().value
    if (oldestKey == null) break
    thumbnailCache.delete(oldestKey)
  }
}

function getCachedThumbnail(id: string) {
  const thumbnail = thumbnailCache.get(id)
  if (thumbnail?.thumbnailVersion === CURRENT_THUMBNAIL_VERSION) {
    thumbnailCache.delete(id)
    thumbnailCache.set(id, thumbnail)
    return thumbnail
  }
  if (thumbnail) thumbnailCache.delete(id)
  return undefined
}

export async function ensureImageThumbnailCached(id: string): Promise<{ dataUrl: string; width?: number; height?: number } | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) {
    scheduleThumbnailBackfill(id)
    return undefined
  }

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: rec.width,
    height: rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export async function ensureMediaThumbnailCached(id: string): Promise<{ dataUrl: string; width?: number; height?: number } | undefined> {
  const cached = getCachedThumbnail(id)
  if (cached) return cached

  const rec = await getStoredFreshImageThumbnail(id)
  if (!rec?.thumbnailDataUrl) return undefined

  const thumbnail = {
    dataUrl: rec.thumbnailDataUrl,
    width: rec.width,
    height: rec.height,
    thumbnailVersion: rec.thumbnailVersion,
  }
  cacheThumbnail(id, thumbnail)
  return thumbnail
}

export function subscribeImageThumbnail(id: string, callback: (thumbnail: { dataUrl: string; width?: number; height?: number }) => void) {
  let subscribers = thumbnailSubscribers.get(id)
  if (!subscribers) {
    subscribers = new Set()
    thumbnailSubscribers.set(id, subscribers)
  }
  subscribers.add(callback)
  return () => {
    subscribers?.delete(callback)
    if (subscribers?.size === 0) thumbnailSubscribers.delete(id)
  }
}

export function subscribeMediaThumbnail(id: string, callback: (thumbnail: { dataUrl: string; width?: number; height?: number }) => void) {
  return subscribeImageThumbnail(id, callback)
}

function notifyImageThumbnail(id: string, thumbnail: { dataUrl: string; width?: number; height?: number }) {
  thumbnailSubscribers.get(id)?.forEach((callback) => callback(thumbnail))
}

function scheduleThumbnailBackfill(id: string) {
  if (getCachedThumbnail(id) || thumbnailBackfillRunningIds.has(id)) return
  thumbnailBackfillIds.add(id)
  if (thumbnailBackfillScheduled) return
  thumbnailBackfillScheduled = true

  const run = () => {
    thumbnailBackfillScheduled = false
    void processNextThumbnailBackfill()
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 1500 })
  } else {
    setTimeout(run, 250)
  }
}

async function processNextThumbnailBackfill() {
  const id = thumbnailBackfillIds.values().next().value
  if (!id) return
  thumbnailBackfillIds.delete(id)
  thumbnailBackfillRunningIds.add(id)

  try {
    const dataUrl = await ensureImageCached(id)
    if (!dataUrl) return
    const thumbnail = await createAndStoreImageThumbnail(id, dataUrl)
    cacheThumbnail(id, {
      dataUrl: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    })
    notifyImageThumbnail(id, {
      dataUrl: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
    })
  } catch {
    /* 缩略图生成失败时保留占位，不影响主流程 */
  } finally {
    thumbnailBackfillRunningIds.delete(id)
    const nextId = thumbnailBackfillIds.values().next().value
    if (nextId) scheduleThumbnailBackfill(nextId)
  }
}

// ===== Store 类型 =====

interface AppState {
  // 鉴权
  authStatus: AuthStatus | null
  authInitialized: boolean
  setAuthStatus: (status: AuthStatus | null) => void
  setAuthInitialized: (value: boolean) => void

  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  replaceInputImage: (currentId: string, nextImage: InputImage, options?: { equivalentImageIds?: Record<string, string> }) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 参数
  taskMode: 'image' | 'video'
  setTaskMode: (mode: 'image' | 'video') => void
  videoAspectRatio: VideoTaskParams['aspect_ratio']
  setVideoAspectRatio: (ratio: VideoTaskParams['aspect_ratio']) => void
  videoResolution: VideoTaskParams['resolution']
  setVideoResolution: (resolution: VideoTaskParams['resolution']) => void
  videoDuration: VideoTaskParams['duration']
  setVideoDuration: (duration: VideoTaskParams['duration']) => void
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  visibleTaskIds: string[]
  setVisibleTaskIds: (ids: string[]) => void
  taskPage: number
  setTaskPage: (page: number) => void
  taskPageSize: number
  setTaskPageSize: (pageSize: number) => void
  taskTotal: number
  setTaskPaginationMeta: (input: { page?: number; pageSize?: number; total?: number }) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterTaskType: 'all' | 'image' | 'video'
  setFilterTaskType: (taskType: AppState['filterTaskType']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void
  filterArchived: boolean
  setFilterArchived: (f: boolean) => void
  showUsageCodeTasksForAdmin: boolean
  setShowUsageCodeTasksForAdmin: (value: boolean) => void
  blurLoadedImages: boolean
  setBlurLoadedImages: (value: boolean) => void
  taskImageBlurOverrides: Record<string, boolean>
  toggleTaskImageBlur: (taskId: string) => void
  loadedTaskImageIds: string[]
  markTaskImageLoaded: (imageId: string) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  lightboxStartEditor: boolean
  setLightboxImageId: (id: string | null, list?: string[]) => void
  setLightboxStartEditor: (v: boolean) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Auth
      authStatus: null,
      authInitialized: false,
      setAuthStatus: (authStatus) => set({ authStatus }),
      setAuthInitialized: (authInitialized) => set({ authInitialized }),

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => ({
        settings: {
          ...st.settings,
          ...s,
          apiMode:
            s.apiMode === 'images' || s.apiMode === 'responses' || s.apiMode === 'videos'
              ? s.apiMode
              : st.settings.apiMode ?? DEFAULT_SETTINGS.apiMode,
          codexCli: s.codexCli ?? st.settings.codexCli ?? DEFAULT_SETTINGS.codexCli,
          grokApiCompat: s.grokApiCompat ?? st.settings.grokApiCompat ?? DEFAULT_SETTINGS.grokApiCompat,
          responseFormatB64Json:
            s.responseFormatB64Json ?? st.settings.responseFormatB64Json ?? DEFAULT_SETTINGS.responseFormatB64Json,
          videoMaxResolution:
            s.videoMaxResolution ?? st.settings.videoMaxResolution ?? DEFAULT_SETTINGS.videoMaxResolution,
          videoMaxDuration:
            s.videoMaxDuration ?? st.settings.videoMaxDuration ?? DEFAULT_SETTINGS.videoMaxDuration,
          clearInputAfterSubmit:
            s.clearInputAfterSubmit ?? st.settings.clearInputAfterSubmit ?? DEFAULT_SETTINGS.clearInputAfterSubmit,
          persistInputOnRestart:
            s.persistInputOnRestart ?? st.settings.persistInputOnRestart ?? DEFAULT_SETTINGS.persistInputOnRestart,
          reuseTaskApiProfileTemporarily:
            s.reuseTaskApiProfileTemporarily ?? st.settings.reuseTaskApiProfileTemporarily ?? DEFAULT_SETTINGS.reuseTaskApiProfileTemporarily,
          alwaysShowRetryButton:
            s.alwaysShowRetryButton ?? st.settings.alwaysShowRetryButton ?? DEFAULT_SETTINGS.alwaysShowRetryButton,
          showUsageCodeAliasOnTaskCard:
            s.showUsageCodeAliasOnTaskCard ?? st.settings.showUsageCodeAliasOnTaskCard ?? DEFAULT_SETTINGS.showUsageCodeAliasOnTaskCard,
          apiKeyMasked:
            s.apiKeyMasked === undefined
              ? st.settings.apiKeyMasked ?? DEFAULT_SETTINGS.apiKeyMasked
              : s.apiKeyMasked,
          apiKeyConfigured:
            s.apiKeyConfigured === undefined
              ? st.settings.apiKeyConfigured ?? DEFAULT_SETTINGS.apiKeyConfigured
              : s.apiKeyConfigured,
          providerProfileId:
            s.providerProfileId === undefined
              ? st.settings.providerProfileId ?? DEFAULT_SETTINGS.providerProfileId
              : s.providerProfileId,
          updatedAt: Date.now(),
        },
      })),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),
      themeMode: 'system',
      setThemeMode: (themeMode) => set({ themeMode }),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const nextImages = s.inputImages.filter((_, i) => i !== idx)
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages: nextImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, nextImages),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          if (
            fromIdx === toIdx ||
            fromIdx < 0 ||
            toIdx < 0 ||
            fromIdx >= s.inputImages.length ||
            toIdx >= s.inputImages.length
          ) {
            return s
          }
          if (
            s.maskDraft &&
            s.inputImages[0]?.id === s.maskDraft.targetImageId &&
            fromIdx !== 0 &&
            toIdx === 0
          ) {
            return s
          }

          const nextImages = [...s.inputImages]
          const [moved] = nextImages.splice(fromIdx, 1)
          if (!moved) return s
          nextImages.splice(toIdx, 0, moved)
          return {
            inputImages: nextImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, nextImages),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return {
            inputImages: [],
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, []),
            maskDraft: null,
            maskEditorImageId: null,
          }
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const shouldClearMask =
            Boolean(s.maskDraft) && !imgs.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages: imgs,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, imgs, options?.equivalentImageIds),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      replaceInputImage: (currentId, nextImage, options) =>
        set((s) => {
          const shouldClearMask = s.maskDraft?.targetImageId === currentId
          const nextImages = s.inputImages.map((img) => (img.id === currentId ? nextImage : img))
          return {
            inputImages: nextImages,
            prompt: remapImageMentionsForOrder(
              s.prompt,
              s.inputImages,
              nextImages,
              options?.equivalentImageIds ?? { [currentId]: nextImage.id },
            ),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          if (!maskDraft) return { maskDraft: null }
          const target = validateMaskTarget(s.inputImages, maskDraft.targetImageId)
          if (s.inputImages[0]?.id === target.id) {
            return { maskDraft }
          }
          const nextImages = orderInputImagesForMask(s.inputImages, maskDraft.targetImageId)
          return {
            inputImages: nextImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, nextImages),
            maskDraft,
          }
        }),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => set({ maskEditorImageId }),

      // Params
      taskMode: 'image',
      setTaskMode: (taskMode) => set((s) => ({
        taskMode,
        ...(taskMode === 'video' ? { maskDraft: null, maskEditorImageId: null } : {}),
      })),
      videoAspectRatio: DEFAULT_VIDEO_PARAMS.aspect_ratio,
      setVideoAspectRatio: (videoAspectRatio) => set({ videoAspectRatio }),
      videoResolution: DEFAULT_VIDEO_PARAMS.resolution,
      setVideoResolution: (videoResolution) => set({ videoResolution }),
      videoDuration: DEFAULT_VIDEO_PARAMS.duration,
      setVideoDuration: (videoDuration) => set({ videoDuration }),
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set((state) => {
        const autoLoadedImageIds = getAutoLoadedCompletedImageIds(state.tasks, tasks)
        if (!autoLoadedImageIds.length) return { tasks }

        const loadedTaskImageIds = [...state.loadedTaskImageIds]
        for (const imageId of autoLoadedImageIds) {
          if (!loadedTaskImageIds.includes(imageId)) loadedTaskImageIds.push(imageId)
        }

        return { tasks, loadedTaskImageIds }
      }),
      visibleTaskIds: [],
      setVisibleTaskIds: (visibleTaskIds) => set({ visibleTaskIds }),
      taskPage: 1,
      setTaskPage: (taskPage) => set({ taskPage: Math.max(1, Math.floor(taskPage) || 1) }),
      taskPageSize: 50,
      setTaskPageSize: (pageSize) =>
        set((state) => {
          const nextPageSize = Math.max(1, Math.floor(pageSize) || 50)
          if (nextPageSize === state.taskPageSize) return state
          const firstItemIndex = Math.max(0, (state.taskPage - 1) * state.taskPageSize)
          return {
            taskPageSize: nextPageSize,
            taskPage: Math.floor(firstItemIndex / nextPageSize) + 1,
          }
        }),
      taskTotal: 0,
      setTaskPaginationMeta: ({ page, pageSize, total }) => set((state) => ({
        taskPage: page == null ? state.taskPage : Math.max(1, Math.floor(page) || 1),
        taskPageSize: pageSize == null ? state.taskPageSize : Math.max(1, Math.floor(pageSize) || 50),
        taskTotal: total == null ? state.taskTotal : Math.max(0, Math.floor(total) || 0),
      })),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterTaskType: 'all',
      setFilterTaskType: (filterTaskType) => set({ filterTaskType }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),
      filterArchived: false,
      setFilterArchived: (filterArchived) => set({ filterArchived }),
      showUsageCodeTasksForAdmin: false,
      setShowUsageCodeTasksForAdmin: (showUsageCodeTasksForAdmin) => set({ showUsageCodeTasksForAdmin }),
      blurLoadedImages: false,
      setBlurLoadedImages: (blurLoadedImages) => set({ blurLoadedImages, taskImageBlurOverrides: {} }),
      taskImageBlurOverrides: {},
      toggleTaskImageBlur: (taskId) => set((s) => ({
        taskImageBlurOverrides: {
          ...s.taskImageBlurOverrides,
          [taskId]: !(s.taskImageBlurOverrides[taskId] ?? s.blurLoadedImages),
        },
      })),
      loadedTaskImageIds: [],
      markTaskImageLoaded: (imageId) =>
        set((s) => (
          s.loadedTaskImageIds.includes(imageId)
            ? s
            : { loadedTaskImageIds: [...s.loadedTaskImageIds, imageId] }
        )),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => set({ detailTaskId }),
      lightboxImageId: null,
      lightboxImageList: [],
      lightboxStartEditor: false,
      setLightboxImageId: (lightboxImageId, list) =>
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) }),
      setLightboxStartEditor: (lightboxStartEditor) => set({ lightboxStartEditor }),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => set({ confirmDialog }),
    }),
    {
      name: 'gpt-image-playground',
      partialize: (state) => ({
        settings: state.settings,
        taskMode: state.taskMode,
        videoAspectRatio: state.videoAspectRatio,
        videoResolution: state.videoResolution,
        videoDuration: state.videoDuration,
        params: state.params,
        tasks: state.tasks,
        ...(state.settings.persistInputOnRestart
          ? {
              prompt: state.prompt,
              inputImages: stripInputImageDataUrls(state.inputImages),
              maskDraft: stripMaskDraftDataUrl(state.maskDraft),
            }
          : {}),
        dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
        themeMode: state.themeMode,
        showUsageCodeTasksForAdmin: state.showUsageCodeTasksForAdmin,
        blurLoadedImages: state.blurLoadedImages,
        taskImageBlurOverrides: state.taskImageBlurOverrides,
        loadedTaskImageIds: state.loadedTaskImageIds,
      }),
    },
  ),
)

// ===== Actions =====

let uid = 0

function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return `${settings.baseUrl}\n${settings.apiKey}`
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

async function restorePersistedInputDrafts() {
  const state = useStore.getState()
  const restoredInputImages: InputImage[] = []
  let inputImagesChanged = false

  for (const image of state.inputImages) {
    if (image.dataUrl) {
      restoredInputImages.push(image)
      continue
    }

    const dataUrl = await ensureImageCached(image.id)
    if (dataUrl) {
      restoredInputImages.push({ ...image, dataUrl })
    }
    inputImagesChanged = true
  }

  if (inputImagesChanged) {
    state.setInputImages(restoredInputImages)
  }

  if (useStore.getState().maskDraft && !useStore.getState().maskDraft?.maskDataUrl) {
    useStore.getState().clearMaskDraft()
  }
}

/** 初始化：从 IndexedDB 加载任务和图片缓存，清理孤立图片 */
export async function initStore() {
  let authStatus: AuthStatus | null = null
  try {
    authStatus = await fetchAuthStatus()
    useStore.getState().setAuthStatus(authStatus)
  } catch (err) {
    useStore.getState().setAuthStatus({
      authenticated: false,
      role: null,
      distributionEnabled: false,
      adminConfigured: false,
      user: null,
      usageCodes: [],
    })
    useStore.getState().showToast(
      `读取登录状态失败：${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  } finally {
    useStore.getState().setAuthInitialized(true)
  }

  if (!authStatus?.authenticated) {
    closeAllTaskEventSources()
    closeTaskListEventSource()
    taskStreamInitialized = false
    useStore.getState().setTasks([])
    return
  }

  try {
    const runtimeSettings = await fetchBackendRuntimeSettings()
    if (runtimeSettings) {
      const currentSettings = useStore.getState().settings
      useStore.getState().setSettings({
        baseUrl: runtimeSettings.baseUrl,
        apiKey: runtimeSettings.apiKey,
        apiKeyMasked: runtimeSettings.apiKeyMasked ?? null,
        apiKeyConfigured: runtimeSettings.apiKeyConfigured,
        providerProfileId: currentSettings.providerProfileId ?? runtimeSettings.id ?? null,
        model: runtimeSettings.model,
        apiMode: runtimeSettings.apiMode,
        timeout: runtimeSettings.timeoutSeconds,
        codexCli: runtimeSettings.codexCli,
        grokApiCompat: runtimeSettings.grokApiCompat,
        responseFormatB64Json: runtimeSettings.responseFormatB64Json,
        clearInputAfterSubmit: runtimeSettings.clearInputAfterSubmit,
        persistInputOnRestart: runtimeSettings.persistInputOnRestart,
        reuseTaskApiProfileTemporarily: runtimeSettings.reuseTaskApiProfileTemporarily,
        alwaysShowRetryButton: runtimeSettings.alwaysShowRetryButton,
        showUsageCodeAliasOnTaskCard: runtimeSettings.showUsageCodeAliasOnTaskCard,
      })
    }
  } catch (err) {
    useStore.getState().showToast(
      `读取后端运行设置失败：${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }

  try {
    await refreshTasksFromServer({ silent: true })
  } catch (err) {
    useStore.getState().showToast(
      `读取后端任务失败：${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }

  const images = await getAllImages()
  for (const img of images) {
    cacheImage(img.id, img.dataUrl)
  }

  await restorePersistedInputDrafts()

  setupTaskStreams()
}

export async function refreshAuthStatus(options: { silent?: boolean } = {}) {
  try {
    const status = await fetchAuthStatus()
    useStore.getState().setAuthStatus(status)
    if (!status.authenticated) {
      closeAllTaskEventSources()
      closeTaskListEventSource()
      taskStreamInitialized = false
      useStore.getState().setTasks([])
    }
  } catch (err) {
    if (!options.silent) {
      useStore.getState().showToast(
        `刷新登录状态失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }
}

export async function logout() {
  await logoutAuth().catch(() => undefined)
  closeAllTaskEventSources()
  closeTaskListEventSource()
  taskStreamInitialized = false
  useStore.getState().setTasks([])
  useStore.getState().setDetailTaskId(null)
  try {
    const status = await fetchAuthStatus()
    useStore.getState().setAuthStatus(status)
  } catch {
    useStore.getState().setAuthStatus({
      authenticated: false,
      role: null,
      distributionEnabled: false,
      adminConfigured: true,
      user: null,
      usageCodes: [],
    })
  }
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; usageCodeId?: string | null } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, taskMode, videoAspectRatio, videoResolution, videoDuration, showToast, setConfirmDialog } =
    useStore.getState()

  if (!settings.apiKey && !settings.apiKeyConfigured) {
    showToast('请先在设置中完成后端 API 配置', 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (taskMode === 'image' && maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true, usageCodeId: options.usageCodeId })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    quality: settings.codexCli ? DEFAULT_PARAMS.quality : params.quality,
  }
  if (normalizedParams.size !== params.size || normalizedParams.quality !== params.quality) {
    useStore.getState().setParams({ size: normalizedParams.size, quality: normalizedParams.quality })
  }

  try {
    const inputDataUrls: string[] = []
    for (const img of orderedInputImages) {
      inputDataUrls.push(img.dataUrl)
    }
    const result = await createBackendTask({
      prompt: taskMode === 'video'
        ? replaceImageMentionsForVideoApi(prompt.trim(), orderedInputImages.length)
        : replaceImageMentionsForApi(prompt.trim(), orderedInputImages.length),
      params: normalizedParams,
      taskType: taskMode,
      videoParams: taskMode === 'video'
        ? {
            aspect_ratio: orderedInputImages.length > 0 ? 'auto' : videoAspectRatio,
            resolution: videoResolution,
            duration: videoDuration,
          }
        : undefined,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl: taskMode === 'image' ? maskDraft?.maskDataUrl : undefined,
      providerProfileId: settings.providerProfileId,
      usageCodeId: options.usageCodeId,
    })
    const task = result.task
    await cacheSubmittedTaskImages(task, orderedInputImages, taskMode === 'image' ? maskDraft?.maskDataUrl : undefined)
    if (result.auth) {
      useStore.getState().setAuthStatus(result.auth)
    }

    const latestTasks = useStore.getState().tasks
    useStore.getState().setTasks(sortTasksForDisplay([task, ...latestTasks.filter((item) => item.id !== task.id)]))
    useStore.getState().showToast('任务已提交到后端队列', 'success')
    if (settings.clearInputAfterSubmit) {
      useStore.getState().setPrompt('')
      useStore.getState().clearInputImages()
    } else {
      useStore.getState().clearMaskDraft()
    }
    syncTaskEventSources([task, ...latestTasks.filter((item) => item.id !== task.id)])
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks, showToast } = useStore.getState()
  const normalizedPatch = {
    ...patch,
    ...(patch.isFavorite === true ? { isArchived: false } : {}),
    ...(patch.isArchived === true ? { isFavorite: false } : {}),
  }
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizedPatch, updatedAt: Date.now() } : t,
  )
  setTasks(sortTasksForDisplay(updated))

  if ('isFavorite' in normalizedPatch || 'isArchived' in normalizedPatch) {
    void updateBackendTaskFlags(taskId, {
      ...('isFavorite' in normalizedPatch ? { isFavorite: normalizedPatch.isFavorite } : {}),
      ...('isArchived' in normalizedPatch ? { isArchived: normalizedPatch.isArchived } : {}),
    }).catch((err) => {
      showToast(`同步任务状态失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      void refreshTasksFromServer({ silent: true })
    })
  }
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setTaskMode, setVideoAspectRatio } = useStore.getState()
  setPrompt(task.prompt)
  if (task.taskType === 'video') {
    setTaskMode('video')
    setVideoAspectRatio((task.params as VideoTaskParams).aspect_ratio ?? DEFAULT_VIDEO_PARAMS.aspect_ratio)
  } else {
    setTaskMode('image')
    setParams(task.params as TaskParams)
  }

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await loadTaskImageDataUrl(task, imgId)
    if (dataUrl) imgs.push({ id: imgId, dataUrl })
  }
  setInputImages(imgs)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await loadTaskImageDataUrl(task, task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  showToast('已复用配置到输入框', 'success')
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, clearMaskDraft, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  clearMaskDraft()
  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await loadTaskImageDataUrl(task, imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
      for (const id of t.outputVideos || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    try {
      await deleteBackendTask(id)
    } catch {
      /* ignore */
    }
    closeTaskEventSource(id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
    for (const id of t.outputVideos || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      revokeCachedVideoUrl(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  // 如果删除的任务在选中列表中，则移除
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
    ...(task.outputVideos || []),
  ])

  // 从列表移除
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  try {
    await deleteBackendTask(task.id)
  } catch {
    /* ignore */
  }
  closeTaskEventSource(task.id)

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
    for (const id of t.outputVideos || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
      revokeCachedVideoUrl(imgId)
      thumbnailCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 清空所有数据（含配置重置） */
export async function clearAllData(options: { silent?: boolean } = {}) {
  await clearImages()
  imageCache.clear()
  thumbnailCache.clear()
  clearAnnouncementLocalState()
  for (const videoId of Array.from(videoUrlCache.keys())) {
    revokeCachedVideoUrl(videoId)
  }
  closeAllTaskEventSources()
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  setTasks([])
  clearInputImages()
  useStore.setState({ dismissedCodexCliPrompts: [] })
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  if (!options.silent) {
    showToast('所有数据已清空', 'success')
  }
}

export async function clearLocalTaskCache(options: { silent?: boolean } = {}) {
  closeAllTaskEventSources()
  for (const videoId of Array.from(videoUrlCache.keys())) {
    revokeCachedVideoUrl(videoId)
  }
  const {
    setTasks,
    clearSelection,
    setDetailTaskId,
    setLightboxImageId,
    setLightboxStartEditor,
    showToast,
  } = useStore.getState()

  setTasks([])
  clearSelection()
  setDetailTaskId(null)
  setLightboxImageId(null, [])
  setLightboxStartEditor(false)

  if (!options.silent) {
    showToast('本地任务缓存已清空', 'success')
  }
}

/** 添加图片到输入（文件上传）—— 仅放入内存缓存，不写 IndexedDB */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl)
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

export async function replaceInputImageWithDataUrl(currentId: string, dataUrl: string): Promise<string> {
  const id = await storeImage(dataUrl)
  cacheImage(id, dataUrl)
  useStore.getState().replaceInputImage(
    currentId,
    { id, dataUrl },
    { equivalentImageIds: { [currentId]: id } },
  )
  return id
}

export async function addInputImageWithDataUrl(dataUrl: string): Promise<string> {
  const id = await storeImage(dataUrl)
  cacheImage(id, dataUrl)
  const state = useStore.getState()
  if (!state.inputImages.some((image) => image.id === id)) {
    state.addInputImage({ id, dataUrl })
  }
  return id
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl)
  cacheImage(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

async function loadTaskImageDataUrl(task: TaskRecord, imageId: string): Promise<string | undefined> {
  const cached = await ensureImageCached(imageId)
  if (cached) return cached

  const remoteUrl = task.imageUrlsById?.[imageId]
  if (!remoteUrl) return undefined

  return cacheTaskImageForEditing(imageId, remoteUrl)
}

async function loadTaskVideoUrl(task: TaskRecord, videoId: string): Promise<string | undefined> {
  const cached = await ensureVideoCached(videoId)
  if (cached) return cached

  const remoteUrl = task.mediaUrlsById?.[videoId] || task.imageUrlsById?.[videoId]
  if (!remoteUrl) return undefined

  return cacheTaskVideoForPlayback(videoId, remoteUrl)
}

async function cacheSubmittedTaskImages(
  task: TaskRecord,
  inputImages: InputImage[],
  maskDataUrl?: string,
) {
  for (let index = 0; index < task.inputImageIds.length; index += 1) {
    const imageId = task.inputImageIds[index]
    const inputImage = inputImages[index]
    if (!imageId || !inputImage?.dataUrl) continue
    cacheImage(imageId, inputImage.dataUrl)
    await putImage({
      id: imageId,
      dataUrl: inputImage.dataUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'upload',
    })
  }

  if (task.maskImageId && maskDataUrl) {
    cacheImage(task.maskImageId, maskDataUrl)
    await putImage({
      id: task.maskImageId,
      dataUrl: maskDataUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'mask',
    })
  }
}

export async function ensureTaskImageAvailable(imageId: string): Promise<string | undefined> {
  const cached = await ensureImageCached(imageId)
  if (cached) return cached

  const task = useStore.getState().tasks.find((item) =>
    item.inputImageIds.includes(imageId) ||
    item.outputImages.includes(imageId) ||
    item.maskImageId === imageId,
  )
  if (!task) return undefined
  return loadTaskImageDataUrl(task, imageId)
}

export async function ensureTaskVideoAvailable(videoId: string): Promise<string | undefined> {
  const cached = await ensureVideoCached(videoId)
  if (cached) return cached

  const task = useStore.getState().tasks.find((item) => item.outputVideos?.includes(videoId))
  if (!task) return undefined
  return loadTaskVideoUrl(task, videoId)
}

export async function cacheTaskImageForEditing(
  imageId: string,
  remoteUrl: string,
  imageElement?: HTMLImageElement | null,
): Promise<string | undefined> {
  const cached = await ensureImageCached(imageId)
  if (cached) return cached

  let dataUrl: string | undefined

  if (imageElement && imageElement.complete && imageElement.naturalWidth > 0 && imageElement.naturalHeight > 0) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = imageElement.naturalWidth
      canvas.height = imageElement.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.drawImage(imageElement, 0, 0)
        dataUrl = canvas.toDataURL('image/png')
      }
    } catch {
      dataUrl = undefined
    }
  }

  if (!dataUrl) {
    const res = await fetch(remoteUrl)
    const blob = await res.blob()
    dataUrl = await blobToDataUrl(blob)
  }

  cacheImage(imageId, dataUrl)
  await putImage({
    id: imageId,
    dataUrl,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'generated',
  })
  scheduleThumbnailBackfill(imageId)
  return dataUrl
}

export async function cacheTaskVideoForPlayback(
  videoId: string,
  remoteUrl: string,
): Promise<string | undefined> {
  const cached = await ensureVideoCached(videoId)
  if (cached) {
    const thumbnail = await getStoredFreshImageThumbnail(videoId)
    if (!thumbnail?.thumbnailDataUrl) {
      const cachedBlob = await getCachedVideoBlob(videoId)
      if (cachedBlob) {
        try {
          const generatedThumbnail = await createAndStoreVideoThumbnail(videoId, cachedBlob)
          cacheThumbnail(videoId, {
            dataUrl: generatedThumbnail.thumbnailDataUrl,
            width: generatedThumbnail.width,
            height: generatedThumbnail.height,
            thumbnailVersion: generatedThumbnail.thumbnailVersion,
          })
          notifyImageThumbnail(videoId, {
            dataUrl: generatedThumbnail.thumbnailDataUrl,
            width: generatedThumbnail.width,
            height: generatedThumbnail.height,
          })
        } catch {
          /* 视频首帧生成失败时保留占位，不影响播放 */
        }
      }
    }
    return cached
  }

  const loading = videoLoadPromises.get(videoId)
  if (loading) return loading

  const loadPromise = (async () => {
    const response = await fetch(remoteUrl)
    const blob = await response.blob()
    await putCachedVideoBlob(videoId, blob)

    const objectUrl = URL.createObjectURL(blob)
    cacheVideoUrl(videoId, objectUrl)

    const thumbnail = await getStoredFreshImageThumbnail(videoId)
    if (!thumbnail?.thumbnailDataUrl) {
      try {
        const generatedThumbnail = await createAndStoreVideoThumbnail(videoId, blob)
        cacheThumbnail(videoId, {
          dataUrl: generatedThumbnail.thumbnailDataUrl,
          width: generatedThumbnail.width,
          height: generatedThumbnail.height,
          thumbnailVersion: generatedThumbnail.thumbnailVersion,
        })
        notifyImageThumbnail(videoId, {
          dataUrl: generatedThumbnail.thumbnailDataUrl,
          width: generatedThumbnail.width,
          height: generatedThumbnail.height,
        })
      } catch {
        /* 视频首帧生成失败时保留占位，不影响播放 */
      }
    }

    return objectUrl
  })()

  videoLoadPromises.set(videoId, loadPromise)

  try {
    return await loadPromise
  } finally {
    videoLoadPromises.delete(videoId)
  }
}

function upsertTaskFromServer(task: TaskRecord) {
  const tasks = useStore.getState().tasks
  const nextTasks = sortTasksForDisplay([
    task,
    ...tasks.filter((item) => item.id !== task.id),
  ])
  useStore.getState().setTasks(nextTasks)
}

function closeTaskEventSource(taskId: string) {
  const source = taskEventSources.get(taskId)
  if (!source) return
  source.close()
  taskEventSources.delete(taskId)
}

function closeAllTaskEventSources() {
  for (const source of taskEventSources.values()) {
    source.close()
  }
  taskEventSources.clear()
}

function closeTaskListEventSource() {
  taskListEventSource?.close()
  taskListEventSource = null
}

function removeTaskFromStore(taskId: string) {
  const state = useStore.getState()
  const nextTasks = state.tasks.filter((task) => task.id !== taskId)
  if (nextTasks.length !== state.tasks.length) {
    state.setTasks(sortTasksForDisplay(nextTasks))
  }
  if (state.selectedTaskIds.includes(taskId)) {
    state.setSelectedTaskIds((prev) => prev.filter((id) => id !== taskId))
  }
  if (state.detailTaskId === taskId) {
    state.setDetailTaskId(null)
  }
}

export async function refreshTasksFromServer(options: { silent?: boolean } = {}) {
  try {
    const state = useStore.getState()
    const taskPageResult = await fetchBackendTaskPage({
      page: state.taskPage,
      pageSize: state.taskPageSize,
      query: state.searchQuery,
      status: state.filterStatus,
      taskType: state.filterTaskType,
      favorite: state.filterFavorite,
      archived: state.filterArchived,
      showUsageCodeTasksForAdmin: state.showUsageCodeTasksForAdmin,
    })
    const mergedTasks = mergeLocalTaskFlags(taskPageResult.items)
    state.setTaskPaginationMeta({
      page: taskPageResult.page,
      pageSize: taskPageResult.pageSize,
      total: taskPageResult.total,
    })
    useStore.getState().setTasks(sortTasksForDisplay(mergedTasks))
    syncTaskEventSources(mergedTasks)
  } catch (err) {
    if (!options.silent) {
      useStore.getState().showToast(
        `刷新后端任务失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }
}

function syncTaskEventSources(tasks: TaskRecord[]) {
  const runningTaskIds = new Set(tasks.filter((task) => task.status === 'running').map((task) => task.id))

  for (const taskId of Array.from(taskEventSources.keys())) {
    if (!runningTaskIds.has(taskId)) {
      closeTaskEventSource(taskId)
    }
  }

  for (const task of tasks) {
    if (task.status !== 'running' || taskEventSources.has(task.id)) continue

    const source = new EventSource(`/api/tasks/${task.id}/events`)
    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { task?: TaskRecord }
      if (!payload.task) return
      upsertTaskFromServer(payload.task)
      if (payload.task.status !== 'running') {
        closeTaskEventSource(payload.task.id)
        void refreshAuthStatus({ silent: true })
      }
    })
    source.onerror = () => {
      closeTaskEventSource(task.id)
      window.setTimeout(async () => {
        await refreshTasksFromServer({ silent: true })
      }, 1500)
    }
    taskEventSources.set(task.id, source)
  }
}

function setupGlobalTaskListStream() {
  if (taskListEventSource || typeof window === 'undefined') return

  const source = new EventSource('/api/tasks/events')
  source.addEventListener('snapshot', (event) => {
    void event
    void refreshTasksFromServer({ silent: true })
  })
  source.addEventListener('task', (event) => {
    void event
    void refreshTasksFromServer({ silent: true })
  })
  source.onerror = () => {
    closeTaskListEventSource()
    window.setTimeout(() => {
      setupGlobalTaskListStream()
      void refreshTasksFromServer({ silent: true })
    }, 1500)
  }

  taskListEventSource = source
}

function setupTaskRefreshLifecycle() {
  if (taskRefreshLifecycleInitialized || typeof window === 'undefined') return
  taskRefreshLifecycleInitialized = true

  const handleResume = () => {
    void refreshTasksFromServer({ silent: true })
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      void refreshTasksFromServer({ silent: true })
    }
  }

  window.addEventListener('focus', handleResume)
  window.addEventListener('pageshow', handleResume)
  window.addEventListener('online', handleResume)
  document.addEventListener('visibilitychange', handleVisibilityChange)
}

function setupTaskStreams() {
  if (taskStreamInitialized || typeof window === 'undefined') return
  taskStreamInitialized = true

  setupGlobalTaskListStream()
  syncTaskEventSources(useStore.getState().tasks)
  setupTaskRefreshLifecycle()
  useStore.subscribe((state, prevState) => {
    if (state.tasks !== prevState.tasks) {
      syncTaskEventSources(state.tasks)
    }
  })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
