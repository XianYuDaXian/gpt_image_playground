import { Fragment, useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { useStore, submitTask, addImageFromFile, updateTaskInStore, removeMultipleTasks, ensureTaskImageAvailable } from '../store'
import { DEFAULT_PARAMS, DEFAULT_VIDEO_PARAMS, type InputImage, type TaskParams, type VideoTaskParams } from '../types'
import {
  getAtImageQuery,
  getImageMentionLabel,
  getPromptMentionParts,
  getSelectedImageMentionLabel,
  insertImageMentionAtVisibleRange,
  isCursorInSelectedImageMention,
  imageMentionMatches,
  stripImageMentionMarkers,
} from '../lib/promptImageMentions'
import { normalizeImageSize } from '../lib/size'
import { matchesTaskFilters } from '../lib/taskSearch'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { fetchBackendProviderOptions, type BackendProviderOption } from '../lib/backendSettings'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useHintTooltip } from '../hooks/useHintTooltip'
import { useKeyboardVisible } from '../hooks/useKeyboardVisible'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import Select from './Select'
import ProviderProfileTag from './ProviderProfileTag'
import SizePickerModal from './SizePickerModal'
import VideoAspectModal from './VideoAspectModal'

/** 通用悬浮气泡提示 */
function ButtonTooltip({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pointer-events-none z-10 whitespace-nowrap">
      <div className="relative bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg">
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
      </div>
    </div>
  )
}

function CompactSegmentedSlider({
  label,
  value,
  labels,
  suffix = '',
  onChange,
}: {
  label: string
  value: string
  labels: readonly string[]
  suffix?: string
  onChange: (value: string) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-10 shrink-0 items-center rounded-xl border border-gray-200/60 bg-white/70 p-1 text-sm shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
      {labels.map((item) => {
        const selected = item === value
        return (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(item)}
            className={`inline-flex h-full min-w-12 items-center justify-center rounded-lg px-3 leading-none transition ${
              selected
                ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                : 'text-gray-500 hover:text-gray-800 dark:text-gray-300 dark:hover:text-white'
            }`}
          >
            {item}{suffix}
          </button>
        )
      })}
    </div>
  )
}

function getMentionTagTextLength(el: Element) {
  return el.textContent?.length ?? 0
}

function getNodeVisibleTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
    return getMentionTagTextLength(node)
  }
  return Array.from(node.childNodes).reduce((sum, child) => sum + getNodeVisibleTextLength(child), 0)
}

function getVisibleOffsetBeforeNode(root: HTMLElement, target: Node): number {
  let offset = 0
  let found = false

  const walk = (node: Node) => {
    if (found) return
    if (node === target) {
      found = true
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      offset += getMentionTagTextLength(node)
      return
    }
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
  return offset
}

function getMentionTagForBoundary(root: HTMLElement, container: Node) {
  const el = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement
  const tag = el?.closest('.mention-tag')
  return tag && root.contains(tag) ? tag : null
}

function getBoundaryOffsetInMention(tag: Element, container: Node, offset: number) {
  try {
    const range = document.createRange()
    range.selectNodeContents(tag)
    range.setEnd(container, offset)
    return range.toString().length
  } catch {
    return getMentionTagTextLength(tag)
  }
}

function getContentEditableBoundaryOffset(
  root: HTMLElement,
  container: Node,
  offset: number,
  edge: 'start' | 'end',
  collapsed: boolean,
) {
  if (container === root) {
    let visibleOffset = 0
    for (const child of Array.from(root.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  if (!root.contains(container)) {
    return edge === 'start' ? 0 : root.textContent?.length ?? 0
  }

  const mentionTag = getMentionTagForBoundary(root, container)
  if (mentionTag) {
    const mentionStart = getVisibleOffsetBeforeNode(root, mentionTag)
    const mentionLength = getMentionTagTextLength(mentionTag)
    if (!collapsed) return edge === 'start' ? mentionStart : mentionStart + mentionLength
    const mentionOffset = getBoundaryOffsetInMention(mentionTag, container, offset)
    return mentionStart + (mentionOffset < mentionLength / 2 ? 0 : mentionLength)
  }

  if (container.nodeType === Node.TEXT_NODE) {
    return getVisibleOffsetBeforeNode(root, container) + offset
  }

  const element = container.nodeType === Node.ELEMENT_NODE ? container as Element : null
  if (element) {
    let visibleOffset = element === root ? 0 : getVisibleOffsetBeforeNode(root, element)
    for (const child of Array.from(element.childNodes).slice(0, offset)) {
      visibleOffset += getNodeVisibleTextLength(child)
    }
    return visibleOffset
  }

  return root.textContent?.length ?? 0
}

function getContentEditableSelection(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    const end = el.textContent?.length ?? 0
    return { start: end, end }
  }
  try {
    const range = sel.getRangeAt(0)
    const start = getContentEditableBoundaryOffset(el, range.startContainer, range.startOffset, 'start', range.collapsed)
    const end = range.collapsed
      ? start
      : getContentEditableBoundaryOffset(el, range.endContainer, range.endOffset, 'end', false)
    return { start, end }
  } catch {
    const end = el.textContent?.length ?? 0
    return { start: end, end }
  }
}

function getContentEditableCursor(el: HTMLElement) {
  return getContentEditableSelection(el).start
}

function getContentEditablePlainText(el: HTMLElement) {
  let text = ''
  const appendNodeText = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node instanceof HTMLElement && node.classList.contains('mention-tag')) {
      text += node.dataset.mentionText ?? node.textContent ?? ''
      return
    }
    node.childNodes.forEach(appendNodeText)
  }
  el.childNodes.forEach(appendNodeText)
  return text.replace(/\r\n?/g, '\n')
}

function getPlainTextFromNode(node: Node) {
  let text = ''
  const appendNodeText = (current: Node) => {
    if (current.nodeType === Node.TEXT_NODE) {
      text += current.textContent ?? ''
      return
    }
    if (current instanceof HTMLBRElement) {
      text += '\n'
      return
    }
    if (current instanceof HTMLElement && current.classList.contains('mention-tag')) {
      text += current.dataset.mentionText ?? current.textContent ?? ''
      return
    }
    current.childNodes.forEach(appendNodeText)
  }
  appendNodeText(node)
  return text.replace(/\r\n?/g, '\n')
}

function syncMentionTagSelection(el: HTMLElement) {
  const tags = el.querySelectorAll<HTMLElement>('.mention-tag')
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  const range = sel.getRangeAt(0)
  if (range.collapsed) {
    tags.forEach((tag) => tag.classList.remove('selected'))
    return
  }

  tags.forEach((tag) => {
    let isSelected = false
    try {
      isSelected = range.intersectsNode(tag)
    } catch {
      isSelected = false
    }
    tag.classList.toggle('selected', isSelected)
  })
}

function setContentEditableCursor(el: HTMLElement, offset: number) {
  const sel = window.getSelection()
  if (!sel) return
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node: Text | null = null
  while (walker.nextNode()) {
    node = walker.currentNode as Text
    const mentionTag = node.parentElement?.closest('.mention-tag')
    if (mentionTag) {
      if (remaining <= node.length) {
        const range = document.createRange()
        if (remaining < node.length / 2) range.setStartBefore(mentionTag)
        else range.setStartAfter(mentionTag)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return
      }
      remaining -= node.length
      continue
    }
    if (remaining <= node.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      return
    }
    remaining -= node.length
  }
  if (node) {
    const range = document.createRange()
    range.setStart(node, node.length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

function renderPromptEditor(el: HTMLDivElement, prompt: string, inputImages: InputImage[]) {
  const parts = getPromptMentionParts(prompt, inputImages)
  const fragment = document.createDocumentFragment()

  for (const part of parts) {
    if (part.type === 'text') {
      fragment.appendChild(document.createTextNode(part.text))
      continue
    }
    const tag = document.createElement('span')
    tag.className = 'mention-tag inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300'
    tag.dataset.mentionText = getSelectedImageMentionLabel(part.imageIndex)
    tag.contentEditable = 'false'
    tag.textContent = part.text
    fragment.appendChild(tag)
  }

  el.replaceChildren(fragment)
}

/** API 支持的最大参考图数量 */
const API_MAX_IMAGES = 16
type MobileParamSheet = 'quality' | 'format' | 'moderation' | 'videoResolution' | 'videoDuration'

function useIsMobile() {
  const getIsMobile = () => {
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    const isIpadOS = platform === 'MacIntel' && navigator.maxTouchPoints > 1
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua) || isIpadOS
  }
  const [isMobile, setIsMobile] = useState(getIsMobile)
  useEffect(() => {
    const onResize = () => setIsMobile(getIsMobile())
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return isMobile
}

export default function InputBar() {
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const moveInputImage = useStore((s) => s.moveInputImage)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const taskMode = useStore((s) => s.taskMode)
  const setTaskMode = useStore((s) => s.setTaskMode)
  const videoAspectRatio = useStore((s) => s.videoAspectRatio)
  const setVideoAspectRatio = useStore((s) => s.setVideoAspectRatio)
  const videoResolution = useStore((s) => s.videoResolution)
  const setVideoResolution = useStore((s) => s.setVideoResolution)
  const videoDuration = useStore((s) => s.videoDuration)
  const setVideoDuration = useStore((s) => s.setVideoDuration)
  const settings = useStore((s) => s.settings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const visibleTaskIds = useStore((s) => s.visibleTaskIds)
  const tasks = useStore((s) => s.tasks)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterTaskType = useStore((s) => s.filterTaskType)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const filterArchived = useStore((s) => s.filterArchived)
  const showUsageCodeTasksForAdmin = useStore((s) => s.showUsageCodeTasksForAdmin)
  const searchQuery = useStore((s) => s.searchQuery)
  const authStatus = useStore((s) => s.authStatus)

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    return sorted.filter((t) =>
      matchesTaskFilters(t, {
        filterStatus,
        filterTaskType,
        filterFavorite,
        filterArchived,
        role: authStatus?.role,
        showUsageCodeTasksForAdmin,
        query: q,
      }),
    )
  }, [authStatus?.role, tasks, searchQuery, filterStatus, filterTaskType, filterFavorite, filterArchived, showUsageCodeTasksForAdmin])
  const visibleTasks = useMemo(
    () => filteredTasks.filter((task) => visibleTaskIds.includes(task.id)),
    [filteredTasks, visibleTaskIds],
  )

  const isIOS = useMemo(() => {
    const ua = navigator.userAgent || ''
    const platform = navigator.platform || ''
    return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  }, [])

  const handleSelectAllToggle = useCallback(() => {
    if (selectedTaskIds.length === visibleTasks.length && visibleTasks.length > 0) {
      clearSelection()
    } else {
      setSelectedTaskIds(visibleTasks.map((t) => t.id))
    }
  }, [selectedTaskIds.length, visibleTasks, clearSelection, setSelectedTaskIds])

  const handleToggleFavorite = useCallback(() => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const allFavorite = selectedTasks.length > 0 && selectedTasks.every((t) => t.isFavorite)
    const newFavoriteState = !allFavorite
    setConfirmDialog({
      title: newFavoriteState ? '批量收藏' : '批量取消收藏',
      message: newFavoriteState
        ? `确定要收藏选中的 ${selectedTaskIds.length} 条记录吗？`
        : `确定要取消收藏选中的 ${selectedTaskIds.length} 条记录吗？`,
      confirmText: newFavoriteState ? '确认收藏' : '确认取消',
      action: () => {
        selectedTaskIds.forEach((id) => {
          updateTaskInStore(id, { isFavorite: newFavoriteState })
        })
        clearSelection()
      },
    })
  }, [tasks, selectedTaskIds, clearSelection, setConfirmDialog])

  const handleToggleArchived = useCallback(() => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const allArchived = selectedTasks.length > 0 && selectedTasks.every((t) => t.isArchived)
    const newArchivedState = !allArchived
    setConfirmDialog({
      title: newArchivedState ? '批量归档' : '批量取消归档',
      message: newArchivedState
        ? `确定要归档选中的 ${selectedTaskIds.length} 条记录吗？归档后默认列表不再显示。`
        : `确定要取消归档选中的 ${selectedTaskIds.length} 条记录吗？`,
      confirmText: newArchivedState ? '确认归档' : '确认取消',
      action: () => {
        selectedTaskIds.forEach((id) => {
          updateTaskInStore(id, { isArchived: newArchivedState })
        })
        clearSelection()
      },
    })
  }, [tasks, selectedTaskIds, clearSelection, setConfirmDialog])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedTaskIds.length} 条记录吗？`,
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog])

  const handleBatchDownload = useCallback(async () => {
    if (isIOS) {
      useStore.getState().showToast('iOS 暂不支持批量下载，请长按单张图片保存', 'info')
      return
    }

    const selectedTasks = tasks.filter((task) => selectedTaskIds.includes(task.id))
    const targets: Array<{ url: string; filename: string }> = []

    for (const task of selectedTasks) {
      const baseName = (task.prompt || task.id)
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48) || task.id

      for (let index = 0; index < task.outputImages.length; index += 1) {
        const imageId = task.outputImages[index]
        const remoteUrl = task.imageUrlsById?.[imageId]
        const url = remoteUrl || await ensureTaskImageAvailable(imageId)
        if (!url) continue

        const extFromParams = task.taskType === 'video' ? 'png' : ((task.params as TaskParams).output_format || 'png')
        targets.push({
          url,
          filename: `${baseName}-${index + 1}.${extFromParams}`,
        })
      }
      for (let index = 0; index < (task.outputVideos || []).length; index += 1) {
        const videoId = task.outputVideos?.[index]
        if (!videoId) continue
        const url = task.mediaUrlsById?.[videoId] || task.imageUrlsById?.[videoId]
        if (!url) continue
        targets.push({
          url,
          filename: `${baseName}-${index + 1}.mp4`,
        })
      }
    }

    if (targets.length === 0) {
      useStore.getState().showToast('选中的记录里没有可下载媒体', 'error')
      return
    }

    for (const item of targets) {
      const anchor = document.createElement('a')
      anchor.href = item.url
      anchor.download = item.filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      await new Promise((resolve) => window.setTimeout(resolve, 120))
    }

    useStore.getState().showToast(`已开始下载 ${targets.length} 个文件`, 'success')
  }, [isIOS, selectedTaskIds, tasks])
  const maskDraft = useStore((s) => s.maskDraft)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const imagesRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(42)

  const [isDragging, setIsDragging] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [mobileCollapsed, setMobileCollapsed] = useState(false)
  const [selectedInputImageId, setSelectedInputImageId] = useState<string | null>(null)
  const [dragInputImageIndex, setDragInputImageIndex] = useState<number | null>(null)
  const [dragOverInputImageIndex, setDragOverInputImageIndex] = useState<number | null>(null)
  const [imageHintId, setImageHintId] = useState<string | null>(null)
  const [showSizePicker, setShowSizePicker] = useState(false)
  const [showVideoAspectPicker, setShowVideoAspectPicker] = useState(false)
  const [showParamsModal, setShowParamsModal] = useState(false)
  const [mobileParamSheet, setMobileParamSheet] = useState<MobileParamSheet | null>(null)
  const [showUsageCodePicker, setShowUsageCodePicker] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [atImageMenuIndex, setAtImageMenuIndex] = useState(0)
  const handleRef = useRef<HTMLDivElement>(null)
  const mobileHandleGestureRef = useRef({ startY: 0, moved: false })
  const suppressHandleClickRef = useRef(false)
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [providerOptions, setProviderOptions] = useState<BackendProviderOption[]>([])
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)
  const dragCounter = useRef(0)
  const isComposingRef = useRef(false)
  const isMobile = useIsMobile()
  const keyboardVisible = useKeyboardVisible()

  const hasConfiguredProvider = Boolean(settings.apiKeyConfigured || settings.apiKey)
  const canSubmit = Boolean(prompt.trim() && hasConfiguredProvider && !isSubmitting)
  const quotaCost = taskMode === 'video' ? 1 : params.n
  const userUsageCodes = authStatus?.role === 'user' ? authStatus.usageCodes : []
  const modeProviderOptions = useMemo(
    () => providerOptions.filter((option) => taskMode === 'video' ? option.apiMode === 'videos' : option.apiMode !== 'videos'),
    [providerOptions, taskMode],
  )
  const activeProviderProfileId = modeProviderOptions.some((option) => option.id === settings.providerProfileId)
    ? settings.providerProfileId
    : modeProviderOptions.find((option) => option.isDefault)?.id
      ?? modeProviderOptions[0]?.id
      ?? null
  const activeProviderOption = modeProviderOptions.find((option) => option.id === activeProviderProfileId) ?? null
  const currentUsageCodesForProvider = useMemo(() => (
    authStatus?.role === 'user' && activeProviderProfileId
      ? userUsageCodes.filter((code) =>
          (!code.allowedProviderProfileIds?.length || code.allowedProviderProfileIds.includes(activeProviderProfileId))
          && ((taskMode === 'video'
            ? code.providerRemainingVideoCredits?.[activeProviderProfileId]
            : code.providerRemainingImageCredits?.[activeProviderProfileId]) ?? 0) > 0,
        )
      : []
  ), [activeProviderProfileId, authStatus?.role, taskMode, userUsageCodes])
  const canShowVideoAdvancedControls = Boolean(
    taskMode === 'video'
    && activeProviderOption?.grokApiCompat
    && (authStatus?.role === 'admin' || currentUsageCodesForProvider.length > 0)
    && (activeProviderOption.videoMaxResolution === '720p' || (activeProviderOption.videoMaxDuration ?? 6) > 6),
  )
  const allowedVideoResolutions: Array<VideoTaskParams['resolution']> = activeProviderOption?.grokApiCompat && activeProviderOption.videoMaxResolution === '720p'
    ? ['480p', '720p']
    : ['480p']
  const maxVideoDuration = activeProviderOption?.grokApiCompat ? activeProviderOption.videoMaxDuration ?? 6 : 6
  const allowedVideoDurations: Array<VideoTaskParams['duration']> = maxVideoDuration >= 15
    ? [6, 10, 15]
    : maxVideoDuration >= 10
      ? [6, 10]
      : [6]
  const allowedVideoDurationLabels = allowedVideoDurations.map(String)
  const canShowVideoResolutionControl = canShowVideoAdvancedControls && allowedVideoResolutions.length > 1
  const canShowVideoDurationControl = canShowVideoAdvancedControls && allowedVideoDurations.length > 1
  const getProviderQuotaSummary = useCallback((providerProfileId: string) => {
    if (authStatus?.role !== 'user') return null
    const availableCodes = userUsageCodes.filter((code) => (
      !code.allowedProviderProfileIds?.length || code.allowedProviderProfileIds.includes(providerProfileId)
    ))
    if (availableCodes.length === 0) {
      return {
        kind: 'unavailable' as const,
        text: '当前使用码不可调用该端点',
      }
    }
    const hasSplitQuota = availableCodes.some((code) => (
      taskMode === 'video'
        ? Boolean(code.providerVideoQuotas)
        : Boolean(code.providerImageQuotas)
    ))
    if (hasSplitQuota) {
      const hasUnlimited = availableCodes.some((code) => {
        if (taskMode === 'video') {
          if (code.providerVideoQuotas) return false
          if (code.providerVideoQuotas?.[providerProfileId] != null) {
            return code.providerRemainingVideoCredits?.[providerProfileId] == null
          }
          return code.remainingVideoCredits == null
        }
        if (code.providerImageQuotas) return false
        if (code.providerImageQuotas?.[providerProfileId] != null) {
          return code.providerRemainingImageCredits?.[providerProfileId] == null
        }
        return code.remainingImageCredits == null
      })
      const remaining = hasUnlimited
        ? null
        : availableCodes.reduce((sum, code) => {
            if (taskMode === 'video') {
              if (code.providerVideoQuotas) return sum + (code.providerRemainingVideoCredits?.[providerProfileId] ?? 0)
              return sum + (code.remainingVideoCredits ?? 0)
            }
            if (code.providerImageQuotas) return sum + (code.providerRemainingImageCredits?.[providerProfileId] ?? 0)
            return sum + (code.remainingImageCredits ?? 0)
          }, 0)
      return {
        kind: 'provider' as const,
        text: remaining == null ? '端点剩余不限' : `端点剩余 ${remaining}`,
      }
    }
    const hasUnlimited = availableCodes.some((code) => (
      taskMode === 'video' ? code.remainingVideoCredits == null : code.remainingImageCredits == null
    ))
    const remaining = hasUnlimited
      ? null
      : availableCodes.reduce((sum, code) => sum + (
          taskMode === 'video' ? (code.remainingVideoCredits ?? 0) : (code.remainingImageCredits ?? 0)
        ), 0)
    return {
      kind: 'total' as const,
      text: remaining == null ? '剩余不限' : `剩余 ${remaining}`,
    }
  }, [authStatus?.role, taskMode, userUsageCodes])
  const codeHasQuota = useCallback((code: {
    allowedProviderProfileIds?: string[] | null
    remainingImageCredits: number | null
    providerRemainingImageCredits?: Record<string, number> | null
    providerImageQuotas?: Record<string, number> | null
    remainingVideoCredits?: number | null
    providerRemainingVideoCredits?: Record<string, number> | null
    providerVideoQuotas?: Record<string, number> | null
  }) => {
    if (
      activeProviderProfileId
      && code.allowedProviderProfileIds?.length
      && !code.allowedProviderProfileIds.includes(activeProviderProfileId)
    ) {
      return false
    }
    const remainingTotal = taskMode === 'video' ? code.remainingVideoCredits : code.remainingImageCredits
    if (remainingTotal != null && remainingTotal < quotaCost) {
      return false
    }
    if (!activeProviderProfileId) {
      return true
    }
    const providerRemaining = taskMode === 'video'
      ? code.providerVideoQuotas ? code.providerRemainingVideoCredits?.[activeProviderProfileId] ?? 0 : code.providerRemainingVideoCredits?.[activeProviderProfileId]
      : code.providerImageQuotas ? code.providerRemainingImageCredits?.[activeProviderProfileId] ?? 0 : code.providerRemainingImageCredits?.[activeProviderProfileId]
    return providerRemaining == null || providerRemaining >= quotaCost
  }, [activeProviderProfileId, quotaCost, taskMode])

  const getCodeQuotaErrorMessage = useCallback((code: {
    allowedProviderProfileIds?: string[] | null
    remainingImageCredits: number | null
    providerRemainingImageCredits?: Record<string, number> | null
    providerImageQuotas?: Record<string, number> | null
    remainingVideoCredits?: number | null
    providerRemainingVideoCredits?: Record<string, number> | null
    providerVideoQuotas?: Record<string, number> | null
  }) => {
    if (
      activeProviderProfileId
      && code.allowedProviderProfileIds?.length
      && !code.allowedProviderProfileIds.includes(activeProviderProfileId)
    ) {
      return `当前使用码无权调用 ${activeProviderOption?.name ?? '当前端点'}`
    }
    const unit = taskMode === 'video' ? '次' : '张'
    const remainingTotal = taskMode === 'video' ? code.remainingVideoCredits : code.remainingImageCredits
    if (remainingTotal != null && remainingTotal < quotaCost) {
      return `当前使用码额度不足，剩余 ${remainingTotal} ${unit}`
    }
    if (!activeProviderProfileId) {
      return '当前使用码额度不足'
    }
    const providerRemaining = taskMode === 'video'
      ? code.providerVideoQuotas ? code.providerRemainingVideoCredits?.[activeProviderProfileId] ?? 0 : code.providerRemainingVideoCredits?.[activeProviderProfileId]
      : code.providerImageQuotas ? code.providerRemainingImageCredits?.[activeProviderProfileId] ?? 0 : code.providerRemainingImageCredits?.[activeProviderProfileId]
    if (providerRemaining != null && providerRemaining < quotaCost) {
      return `${activeProviderOption?.name ?? '当前端点'}额度不足，剩余 ${providerRemaining} ${unit}`
    }
    return '当前使用码额度不足'
  }, [activeProviderOption?.name, activeProviderProfileId, quotaCost, taskMode])

  const applyProviderOption = useCallback((option: BackendProviderOption | null) => {
    if (!option) return
    useStore.getState().setSettings({
      providerProfileId: option.id,
      apiMode: option.apiMode,
      model: option.model,
      timeout: option.timeoutSeconds,
      codexCli: option.codexCli,
      grokApiCompat: option.grokApiCompat,
      xaiImage2kEnabled: option.xaiImage2kEnabled,
      responseFormatB64Json: option.responseFormatB64Json,
      videoMaxResolution: option.videoMaxResolution ?? '480p',
      videoMaxDuration: option.videoMaxDuration ?? 6,
    })
  }, [])

  const submitWithUsageCode = useCallback(async (usageCodeId?: string | null) => {
    const nextProvider = activeProviderOption
    if (nextProvider && useStore.getState().settings.providerProfileId !== nextProvider.id) {
      applyProviderOption(nextProvider)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
    setShowUsageCodePicker(false)
    setIsSubmitting(true)
    try {
      await submitTask({ usageCodeId })
    } finally {
      setIsSubmitting(false)
    }
  }, [activeProviderOption, applyProviderOption])

  const handleSubmit = useCallback(async () => {
    if (!hasConfiguredProvider) {
      setShowSettings(true)
      return
    }
    if (!activeProviderOption) {
      useStore.getState().showToast(taskMode === 'video' ? '请先配置视频 API' : '请先配置图片 API', 'error')
      setShowSettings(true)
      return
    }
    if (!canSubmit) return
    if (authStatus?.role === 'user') {
      if (userUsageCodes.length === 0) {
        useStore.getState().showToast('当前没有可用使用码', 'error')
        return
      }
      if (userUsageCodes.length > 1) {
        setShowUsageCodePicker((value) => !value)
        return
      }
      const onlyCode = userUsageCodes[0]
      if (!onlyCode || !codeHasQuota(onlyCode)) {
        useStore.getState().showToast(getCodeQuotaErrorMessage(onlyCode ?? {
          remainingImageCredits: null,
          providerRemainingImageCredits: null,
          allowedProviderProfileIds: null,
        }), 'error')
        return
      }
      await submitWithUsageCode(onlyCode.id)
      return
    }
    await submitWithUsageCode(null)
  }, [activeProviderOption, authStatus?.role, canSubmit, codeHasQuota, getCodeQuotaErrorMessage, hasConfiguredProvider, setShowSettings, submitWithUsageCode, taskMode, userUsageCodes])

  const renderUsageCodePicker = () => {
    if (!showUsageCodePicker || authStatus?.role !== 'user' || userUsageCodes.length <= 1) return null
    return (
      <div className="absolute bottom-full right-0 z-30 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-2 text-sm shadow-xl dark:border-white/[0.08] dark:bg-gray-900">
        <div className="px-2 pb-2 text-xs text-gray-500 dark:text-gray-400">选择本次使用码</div>
        <div className="space-y-1">
          {userUsageCodes.map((code) => {
            const enabled = codeHasQuota(code)
            return (
              <button
                key={code.id}
                type="button"
                disabled={!enabled || isSubmitting}
                onClick={() => void submitWithUsageCode(code.id)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition ${
                  enabled
                    ? 'bg-gray-50 text-gray-800 hover:bg-blue-50 dark:bg-white/[0.04] dark:text-gray-100 dark:hover:bg-blue-500/10'
                    : 'cursor-not-allowed bg-gray-50 text-gray-400 opacity-60 dark:bg-white/[0.03] dark:text-gray-500'
                }`}
              >
                <span className="min-w-0 truncate">{code.name}</span>
                <span className="shrink-0 text-xs">
                  {(() => {
                    const providerRemaining = activeProviderProfileId
                      ? taskMode === 'video'
                        ? code.providerRemainingVideoCredits?.[activeProviderProfileId]
                        : code.providerRemainingImageCredits?.[activeProviderProfileId]
                      : null
                    if (providerRemaining != null) return `端点剩余 ${providerRemaining}`
                    const remainingTotal = taskMode === 'video' ? code.remainingVideoCredits : code.remainingImageCredits
                    return remainingTotal == null ? '不限' : `剩余 ${remainingTotal}`
                  })()}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  const atImageLimit = inputImages.length >= API_MAX_IMAGES
  const hasVideoReferenceImage = taskMode === 'video' && inputImages.length > 0
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages
  const promptVisibleText = stripImageMentionMarkers(prompt)
  const atImageQuery = getAtImageQuery(promptVisibleText, cursorPos, inputImages)
  const atImageOptions = atImageQuery
    ? inputImages
        .map((img, index) => ({ img, index }))
        .filter(({ index }) => imageMentionMatches(atImageQuery.query, index))
    : []
  const showAtImageMenu = atImageOptions.length > 0 && !isCursorInSelectedImageMention(prompt, cursorPos) && !isComposingRef.current
  const compressionHint = useHintTooltip()
  const moderationHint = useHintTooltip({ enabled: () => settings.apiMode === 'responses' })
  const qualityHint = useHintTooltip({ enabled: () => settings.codexCli })
  const sizeHint = useHintTooltip()
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })

  useEffect(() => {
    if (atImageMenuIndex < atImageOptions.length) return
    setAtImageMenuIndex(0)
  }, [atImageMenuIndex, atImageOptions.length])

  useCloseOnEscape(showParamsModal, () => setShowParamsModal(false))
  useCloseOnEscape(showVideoAspectPicker, () => setShowVideoAspectPicker(false))
  useCloseOnEscape(Boolean(mobileParamSheet), () => setMobileParamSheet(null))
  usePreventBackgroundScroll(showParamsModal || Boolean(mobileParamSheet))

  useEffect(() => {
    if (hasVideoReferenceImage && videoAspectRatio !== 'auto') {
      setVideoAspectRatio('auto')
    }
  }, [hasVideoReferenceImage, setVideoAspectRatio, videoAspectRatio])

  useEffect(() => {
    if (taskMode !== 'video') return
    if (!allowedVideoResolutions.includes(videoResolution)) {
      setVideoResolution(allowedVideoResolutions[allowedVideoResolutions.length - 1])
    }
    if (!allowedVideoDurations.includes(videoDuration)) {
      setVideoDuration(allowedVideoDurations[allowedVideoDurations.length - 1])
    }
  }, [allowedVideoDurations, allowedVideoResolutions, setVideoDuration, setVideoResolution, taskMode, videoDuration, videoResolution])

  useEffect(() => {
    if (!selectedInputImageId) return
    if (!inputImages.some((image) => image.id === selectedInputImageId)) {
      setSelectedInputImageId(null)
    }
  }, [inputImages, selectedInputImageId])

  useEffect(() => {
    if (!isMobile || !selectedInputImageId) return

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && imagesRef.current?.contains(target)) return
      setSelectedInputImageId(null)
    }

    document.addEventListener('pointerdown', handleOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', handleOutsidePointer, true)
  }, [isMobile, selectedInputImageId])

  useEffect(() => {
    void fetchBackendProviderOptions()
      .then((items) => setProviderOptions(items))
      .catch(() => setProviderOptions([]))
  }, [authStatus?.role])

  useEffect(() => {
    if (!modeProviderOptions.length) return
    const currentId = settings.providerProfileId
    const matched = currentId ? modeProviderOptions.find((item) => item.id === currentId) : null
    const target = matched ?? modeProviderOptions.find((item) => item.isDefault) ?? modeProviderOptions[0] ?? null
    if (!target) return
    if (
      settings.providerProfileId !== target.id
      || settings.apiMode !== target.apiMode
      || settings.model !== target.model
      || settings.timeout !== target.timeoutSeconds
      || settings.codexCli !== target.codexCli
      || settings.grokApiCompat !== target.grokApiCompat
      || settings.responseFormatB64Json !== target.responseFormatB64Json
    ) {
      applyProviderOption(target)
    }
  }, [
    applyProviderOption,
    modeProviderOptions,
    settings.apiMode,
    settings.codexCli,
    settings.grokApiCompat,
    settings.model,
    settings.providerProfileId,
    settings.responseFormatB64Json,
    settings.timeout,
  ])

  useEffect(() => {
    if (!isMobile) return
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-input-bar]')) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur()
      }
    }
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    return () => document.removeEventListener('touchstart', onTouchStart)
  }, [isMobile])

  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(String(params.n))
  }, [params.n])

  useEffect(() => {
    if (settings.apiMode === 'responses' && params.moderation !== 'auto') {
      setParams({ moderation: 'auto' })
    }
  }, [params.moderation, settings.apiMode, setParams])

  useEffect(() => {
    if (settings.codexCli && params.quality !== 'auto') {
      setParams({ quality: 'auto' })
    }
  }, [params.quality, settings.codexCli, setParams])

  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (isComposingRef.current) return

    const selection = document.activeElement === el ? getContentEditableSelection(el) : null
    renderPromptEditor(el, prompt, inputImages)

    if (selection) {
      const nextOffset = Math.min(selection.start, stripImageMentionMarkers(prompt).length)
      setContentEditableCursor(el, nextOffset)
      syncMentionTagSelection(el)
    }
  }, [inputImages, prompt])

  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    nLimitHint.hide()
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(16, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [nInput, params.n, setParams, nLimitHint])

  const handleNInputChange = useCallback((value: string) => {
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > 16) {
      nLimitHint.show()
    } else {
      nLimitHint.hide()
    }
  }, [nLimitHint])

  const handleFiles = async (files: FileList | File[]) => {
    try {
      const currentCount = useStore.getState().inputImages.length
      if (currentCount >= API_MAX_IMAGES) {
        useStore.getState().showToast(
          `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`,
          'error',
        )
        return
      }

      const remaining = API_MAX_IMAGES - currentCount
      const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
      const toAdd = accepted.slice(0, remaining)
      const discarded = accepted.length - toAdd.length

      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      if (discarded > 0) {
        useStore.getState().showToast(
          `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          'error',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }

  const insertImageMentionByIndex = useCallback((imageIndex: number) => {
    const el = textareaRef.current
    const visiblePrompt = stripImageMentionMarkers(prompt)
    const selection = el ? getContentEditableSelection(el) : { start: visiblePrompt.length, end: visiblePrompt.length }
    const next = atImageQuery
      ? insertImageMentionAtVisibleRange(prompt, atImageQuery.start, selection.end, imageIndex)
      : insertImageMentionAtVisibleRange(prompt, selection.start, selection.end, imageIndex)
    setPrompt(next.prompt)
    window.setTimeout(() => {
      const editor = textareaRef.current
      if (!editor) return
      editor.focus()
      setContentEditableCursor(editor, next.cursor)
      setCursorPos(next.cursor)
    }, 0)
  }, [atImageQuery, prompt, setPrompt])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showAtImageMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtImageMenuIndex((value) => (value + 1) % atImageOptions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtImageMenuIndex((value) => (value - 1 + atImageOptions.length) % atImageOptions.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        const option = atImageOptions[atImageMenuIndex]
        if (option) insertImageMentionByIndex(option.index)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtImageMenuIndex(0)
        return
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmit()
    }
  }

  const handlePromptPaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    document.execCommand('insertText', false, text)
  }, [])

  const handlePromptCopy = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    const editor = textareaRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.commonAncestorContainer)) return
    e.preventDefault()
    const text = getPlainTextFromNode(range.cloneContents())
    e.clipboardData.setData('text/plain', text)
  }, [])

  // 粘贴图片
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (document.body.dataset.referenceEditorActive === '1') return
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        handleFilesRef.current(imageFiles)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [])

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    // 计算图片区域和其他固定元素占用的高度
    const imagesHeight = imagesRef.current?.offsetHeight ?? 0
    const fixedOverhead = imagesHeight + 140

    // textarea 最大高度 = 页面 40% 减去固定开销，至少保留 80px
    const maxH = Math.max(window.innerHeight * 0.4 - fixedOverhead, 80)

    // 1. 关闭过渡动画，设高度为 0 以获取真实的文本内容高度
    el.style.transition = 'none'
    el.style.height = '0'
    el.style.overflowY = 'hidden'
    const scrollH = el.scrollHeight
    const minH = 42
    const desired = Math.max(scrollH, minH)
    const targetH = desired > maxH ? maxH : desired

    // 2. 将高度设回上一次的实际高度，强制重绘，准备开始动画
    el.style.height = prevHeightRef.current + 'px'
    void el.offsetHeight

    // 3. 恢复平滑过渡，并设置目标高度
    el.style.transition = 'height 150ms ease, border-color 200ms, box-shadow 200ms'
    el.style.height = targetH + 'px'
    el.style.overflowY = desired > maxH ? 'auto' : 'hidden'

    prevHeightRef.current = targetH
  }, [])

  useEffect(() => {
    adjustTextareaHeight()
  }, [prompt, adjustTextareaHeight])

  // 图片队列变化时也重新计算
  useEffect(() => {
    adjustTextareaHeight()
  }, [inputImages.length, Boolean(maskDraft), maskPreviewUrl, adjustTextareaHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight)
    return () => window.removeEventListener('resize', adjustTextareaHeight)
  }, [adjustTextareaHeight])

  const toggleMobileCollapsed = useCallback(() => {
    setMobileCollapsed((value) => !value)
  }, [])

  const handleMobileTogglePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!isMobile || event.pointerType === 'mouse') return
    mobileHandleGestureRef.current = {
      startY: event.clientY,
      moved: false,
    }
    suppressHandleClickRef.current = false
  }, [isMobile])

  const handleMobileTogglePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!isMobile || event.pointerType === 'mouse') return
    const dy = event.clientY - mobileHandleGestureRef.current.startY
    if (Math.abs(dy) > 10) {
      mobileHandleGestureRef.current.moved = true
      suppressHandleClickRef.current = true
    }
    if (dy > 24) setMobileCollapsed(true)
    if (dy < -24) setMobileCollapsed(false)
  }, [isMobile])

  const handleMobileTogglePointerUp = useCallback((_event: React.PointerEvent<HTMLElement>) => {
    if (!isMobile) return
    if (!mobileHandleGestureRef.current.moved) {
      toggleMobileCollapsed()
      suppressHandleClickRef.current = true
    }
  }, [isMobile, toggleMobileCollapsed])

  const handleMobileToggleClick = useCallback(() => {
    if (!isMobile) return
    if (suppressHandleClickRef.current) {
      suppressHandleClickRef.current = false
      return
    }
    toggleMobileCollapsed()
  }, [isMobile, toggleMobileCollapsed])

  const selectClass = 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm'

  const renderProviderSelector = (className: string) => {
    if (!showProviderSelector) return null
    const currentId = modeProviderOptions.some((item) => item.id === settings.providerProfileId)
      ? settings.providerProfileId ?? ''
      : modeProviderOptions.find((item) => item.isDefault)?.id ?? modeProviderOptions[0]?.id ?? ''
    const currentQuotaSummary = currentId ? getProviderQuotaSummary(currentId) : null
    return (
      <div className={className}>
        <Select
          value={currentId}
          onChange={(value) => {
            const nextOption = modeProviderOptions.find((option) => option.id === String(value)) ?? null
            applyProviderOption(nextOption)
          }}
          options={modeProviderOptions.map((option) => ({
            label: (
              <ProviderProfileTag
                name={option.name}
                colorKey={option.id}
                tagColor={option.tagColor}
                includeMode={false}
                includeDefault={false}
              />
            ),
            value: option.id,
          }))}
          placement="top"
          className="h-10 rounded-xl border border-gray-200/60 bg-white/70 px-3 text-sm text-gray-700 shadow-sm transition-all hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
        />
        {currentQuotaSummary && (
          <div className="mt-1 px-1 text-[11px] text-gray-400 dark:text-gray-500">
            {currentQuotaSummary.text}
          </div>
        )}
      </div>
    )
  }

  const handleInputImageClick = (imgId: string) => {
    const imageIndex = inputImages.findIndex((image) => image.id === imgId)
    if (imageIndex < 0) return
    if (isMobile) {
      setSelectedInputImageId((current) => (current === imgId ? null : imgId))
      return
    }
    insertImageMentionByIndex(imageIndex)
  }

  const handleRemoveInputImage = (idx: number, imgId: string) => {
    removeInputImage(idx)
    if (selectedInputImageId === imgId) {
      setSelectedInputImageId(null)
    }
  }

  const showImageHint = useCallback((imageId: string) => {
    setImageHintId(imageId)
    window.setTimeout(() => {
      setImageHintId((current) => (current === imageId ? null : current))
    }, 1200)
  }, [])

  const resetInputImageDragState = useCallback(() => {
    setDragInputImageIndex(null)
    setDragOverInputImageIndex(null)
  }, [])

  const openMaskEditor = useCallback((imageId: string) => {
    setMaskEditorImageId(imageId)
  }, [setMaskEditorImageId])

  const handleInputImageDragStart = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    if (isMobile) {
      event.preventDefault()
      return
    }
    const draggingImage = inputImages[index]
    if (draggingImage && maskDraft?.targetImageId === draggingImage.id) {
      event.preventDefault()
      showImageHint(draggingImage.id)
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', inputImages[index]?.id ?? '')
    setDragInputImageIndex(index)
    setDragOverInputImageIndex(index)
  }

  const handleInputImageDragOver = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    if (dragInputImageIndex == null) return
    if (maskDraft?.targetImageId === inputImages[0]?.id && dragInputImageIndex !== 0 && index === 0) {
      event.preventDefault()
      showImageHint(inputImages[0].id)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragOverInputImageIndex !== index) {
      setDragOverInputImageIndex(index)
    }
  }

  const handleInputImageDrop = (event: React.DragEvent<HTMLDivElement>, index: number) => {
    if (dragInputImageIndex == null) return
    event.preventDefault()
    if (maskDraft?.targetImageId === inputImages[0]?.id && dragInputImageIndex !== 0 && index === 0) {
      showImageHint(inputImages[0].id)
      resetInputImageDragState()
      return
    }
    if (dragInputImageIndex !== index) {
      moveInputImage(dragInputImageIndex, index)
    }
    resetInputImageDragState()
  }

  const handleInputImageDragEnd = () => {
    resetInputImageDragState()
  }

  const renderImageThumb = (img: (typeof inputImages)[number]) => {
    const originalIndex = inputImages.findIndex((i) => i.id === img.id)
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl
    const selected = selectedInputImageId === img.id
    const isDropTarget = dragInputImageIndex != null && dragOverInputImageIndex === originalIndex
    const isDraggingThumb = dragInputImageIndex === originalIndex
    const deleteButtonClass = isMobile
      ? selected
        ? 'h-9 w-9 opacity-100'
        : 'h-9 w-9 pointer-events-none opacity-0'
      : 'h-[22px] w-[22px] opacity-0 group-hover:opacity-100'
    const mobileEditButtonClass = selected
      ? 'opacity-100 translate-y-0 pointer-events-auto'
      : 'opacity-0 translate-y-1 pointer-events-none'

    return (
      <div
        key={img.id}
        draggable={!isMobile}
        className={`relative group inline-block transition-transform ${isDraggingThumb ? 'scale-95 opacity-60' : ''}`}
        onDragStart={(event) => handleInputImageDragStart(event, originalIndex)}
        onDragOver={(event) => handleInputImageDragOver(event, originalIndex)}
        onDrop={(event) => handleInputImageDrop(event, originalIndex)}
        onDragEnd={handleInputImageDragEnd}
      >
        <ButtonTooltip visible={imageHintId === img.id && isMaskTarget} text="遮罩图必须为第一张" />
        <button
          type="button"
          className={`relative block h-[52px] w-[52px] overflow-hidden rounded-xl border p-0 shadow-sm transition-all ${
            selected
              ? 'border-red-400 ring-2 ring-red-400/45'
              : isMaskTarget
                ? 'border-blue-500 border-2'
                : 'border-gray-200 dark:border-white/[0.08]'
          } ${isDropTarget ? 'ring-2 ring-blue-400/55 border-blue-400' : ''}`}
          onClick={() => handleInputImageClick(img.id)}
          aria-pressed={selected}
          aria-label={selected ? '取消选择参考图' : '选择参考图'}
        >
          <img
            src={displaySrc}
            className="w-full h-full object-cover hover:opacity-90 transition-opacity"
            draggable={false}
            alt=""
          />
          <span className="absolute left-1 bottom-1 rounded bg-black/65 px-1.5 py-0.5 text-[8px] leading-none text-white backdrop-blur-sm z-10 pointer-events-none">
            {getImageMentionLabel(originalIndex)}
          </span>
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          {isMobile ? (
            <button
              type="button"
              className={`absolute inset-0 z-20 flex h-full w-full items-center justify-center border-none bg-black/35 text-white transition-all ${mobileEditButtonClass}`}
              onPointerDown={(e) => {
                e.stopPropagation()
              }}
              onTouchStart={(e) => {
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                openMaskEditor(img.id)
              }}
              title={isMaskTarget ? '编辑遮罩' : '添加遮罩'}
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="absolute inset-0 z-20 flex h-full w-full items-center justify-center border-none bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer focus:outline-none"
              onClick={(e) => {
                e.stopPropagation()
                openMaskEditor(img.id)
              }}
              title={isMaskTarget ? '编辑遮罩' : '添加遮罩'}
            >
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </button>
        <button
          type="button"
          className={`absolute -top-3 -right-3 z-30 flex items-center justify-center rounded-full bg-red-500 text-white shadow-md transition-opacity hover:bg-red-600 ${deleteButtonClass}`}
          onPointerDown={(e) => {
            e.stopPropagation()
          }}
          onTouchStart={(e) => {
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.stopPropagation()
            if (originalIndex >= 0) handleRemoveInputImage(originalIndex, img.id)
          }}
          aria-label="删除参考图"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? '清空全部输入图' : '清空参考图',
          message: maskTargetImage
            ? `确定要清空遮罩主图、${referenceImages.length} 张参考图和当前遮罩吗？`
            : `确定要清空全部 ${inputImages.length} 张参考图吗？`,
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] flex flex-col items-center justify-center gap-0.5 text-gray-400 dark:text-gray-500 hover:text-red-500 hover:border-red-300 hover:bg-red-50/50 dark:hover:bg-red-950/30 transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? '清空遮罩主图、参考图和遮罩' : '清空全部参考图'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      <span className="text-[8px] leading-none">{maskTargetImage ? '清空全部' : '清空'}</span>
    </button>
  )

  const renderImageThumbs = () => {
    return (
        <div ref={imagesRef}>
        <div className="mb-3 grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3">
          {inputImages.map((img) => renderImageThumb(img))}
          {renderClearAllButton()}
        </div>
      </div>
    )
  }

  const renderParams = (cols: string) => (
    <div className={`grid ${cols} gap-2 text-xs flex-1`}>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={qualityHint.show}
        onMouseLeave={qualityHint.hide}
        onTouchStart={qualityHint.startTouch}
        onTouchEnd={qualityHint.clearTimer}
        onTouchCancel={qualityHint.hide}
        onClick={qualityHint.show}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">质量</span>
        <Select
          value={settings.codexCli ? 'auto' : params.quality}
          onChange={(val) => {
            if (!settings.codexCli) setParams({ quality: val as any })
          }}
          options={[
            { label: 'auto', value: 'auto' },
            { label: 'low', value: 'low' },
            { label: 'medium', value: 'medium' },
            { label: 'high', value: 'high' },
          ]}
          disabled={settings.codexCli}
          className={settings.codexCli
            ? 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed text-xs transition-all duration-200 shadow-sm'
            : selectClass}
        />
        <ButtonTooltip
          visible={settings.codexCli && qualityHint.visible}
          text="Codex CLI 不支持质量参数"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">格式</span>
        <Select
          value={params.output_format}
          onChange={(val) => setParams({ output_format: val as any })}
          options={[
            { label: 'PNG', value: 'png' },
            { label: 'JPEG', value: 'jpeg' },
            { label: 'WebP', value: 'webp' },
          ]}
          className={selectClass}
        />
      </label>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={compressionHint.show}
        onMouseLeave={compressionHint.hide}
        onTouchStart={compressionHint.startTouch}
        onTouchEnd={compressionHint.clearTimer}
        onTouchCancel={compressionHint.hide}
        onClick={compressionHint.show}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">压缩率</span>
        <input
          value={outputCompressionInput}
          onChange={(e) => setOutputCompressionInput(e.target.value)}
          onBlur={commitOutputCompression}
          disabled={params.output_format === 'png'}
          type="number"
          min={0}
          max={100}
          placeholder="0-100"
          className={`px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] focus:outline-none text-xs transition-all duration-200 shadow-sm ${
            params.output_format === 'png'
              ? 'bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed'
              : 'bg-white/50 dark:bg-white/[0.03]'
            }`}
        />
        <ButtonTooltip
          visible={compressionHint.visible}
          text="仅 JPEG 和 WebP 支持压缩率"
        />
      </label>
      <label
        className="relative flex flex-col gap-0.5"
        onMouseEnter={moderationHint.show}
        onMouseLeave={moderationHint.hide}
        onTouchStart={moderationHint.startTouch}
        onTouchEnd={moderationHint.clearTimer}
        onTouchCancel={moderationHint.hide}
        onClick={moderationHint.show}
      >
        <span className="text-gray-400 dark:text-gray-500 ml-1">审核</span>
        <Select
          value={settings.apiMode === 'responses' ? 'auto' : params.moderation}
          onChange={(val) => {
            if (settings.apiMode !== 'responses') setParams({ moderation: val as any })
          }}
          options={[
            { label: 'auto', value: 'auto' },
            { label: 'low', value: 'low' },
          ]}
          disabled={settings.apiMode === 'responses'}
          className={settings.apiMode === 'responses'
            ? 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed text-xs transition-all duration-200 shadow-sm'
            : selectClass}
        />
        <ButtonTooltip
          visible={settings.apiMode === 'responses' && moderationHint.visible}
          text="Responses API 不支持审核参数"
        />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-gray-400 dark:text-gray-500 ml-1">数量</span>
        <input
          value={nInput}
          onChange={(e) => handleNInputChange(e.target.value)}
          onFocus={() => setNInputFocused(true)}
          onBlur={() => {
            setNInputFocused(false)
            commitN()
          }}
          type="number"
          min={1}
          max={16}
          className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] focus:outline-none text-xs transition-all duration-200 shadow-sm"
        />
        <ButtonTooltip visible={nLimitHint.visible} text="当前最多支持 16 张" />
      </label>
    </div>
  )

  const mobileChipClass = 'inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-full border border-gray-200/60 bg-white/80 px-2.5 py-1 text-[11px] font-medium text-gray-600 shadow-sm transition-all active:scale-95 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-gray-300'
  const showProviderSelector = modeProviderOptions.length > 1

  const renderMobileParamChips = () => (
    <div className="hide-scrollbar flex items-center gap-1.5 overflow-x-auto pb-2">
      {taskMode === 'video' ? (
        <>
          <button type="button" onClick={() => setTaskMode('image')} className={mobileChipClass}>
            <span className="text-gray-400 dark:text-gray-500">模式</span>
            <span>视频</span>
          </button>
          <button type="button" onClick={() => setShowVideoAspectPicker(true)} className={mobileChipClass}>
            <span className="text-gray-400 dark:text-gray-500">比例</span>
            <span>{hasVideoReferenceImage ? 'auto' : videoAspectRatio}</span>
          </button>
          {(canShowVideoResolutionControl || canShowVideoDurationControl) && (
            <>
              {canShowVideoResolutionControl && (
              <button type="button" onClick={() => setMobileParamSheet('videoResolution')} className={mobileChipClass}>
                <span className="text-gray-400 dark:text-gray-500">分辨率</span>
                <span>{videoResolution}</span>
              </button>
              )}
              {canShowVideoDurationControl && (
              <button type="button" onClick={() => setMobileParamSheet('videoDuration')} className={mobileChipClass}>
                <span className="text-gray-400 dark:text-gray-500">时长</span>
                <span>{videoDuration}s</span>
              </button>
              )}
            </>
          )}
        </>
      ) : (
        <button type="button" onClick={() => setTaskMode('video')} className={mobileChipClass}>
          <span className="text-gray-400 dark:text-gray-500">模式</span>
          <span>图片</span>
        </button>
      )}
      {taskMode === 'video' ? null : (
        <>
      <button type="button" onClick={() => setShowSizePicker(true)} className={mobileChipClass}>
        <span className="text-gray-400 dark:text-gray-500">尺寸</span>
        <span>{normalizeImageSize(params.size) || DEFAULT_PARAMS.size}</span>
      </button>
      <button type="button" onClick={() => !settings.codexCli && setMobileParamSheet('quality')} className={`${mobileChipClass} ${settings.codexCli ? 'opacity-50' : ''}`}>
        <span className="text-gray-400 dark:text-gray-500">质量</span>
        <span>{settings.codexCli ? 'auto' : params.quality}</span>
      </button>
      <button type="button" onClick={() => setMobileParamSheet('format')} className={mobileChipClass}>
        <span className="text-gray-400 dark:text-gray-500">格式</span>
        <span>{params.output_format.toUpperCase()}</span>
      </button>
      <button type="button" onClick={() => settings.apiMode !== 'responses' && setMobileParamSheet('moderation')} className={`${mobileChipClass} ${settings.apiMode === 'responses' ? 'opacity-50' : ''}`}>
        <span className="text-gray-400 dark:text-gray-500">审核</span>
        <span>{settings.apiMode === 'responses' ? 'auto' : params.moderation}</span>
      </button>
        </>
      )}
    </div>
  )

  const renderMobileActionSheet = () => {
    if (!mobileParamSheet) return null
    if (mobileParamSheet === 'videoResolution' || mobileParamSheet === 'videoDuration') {
      const isResolution = mobileParamSheet === 'videoResolution'
      if ((isResolution && !canShowVideoResolutionControl) || (!isResolution && !canShowVideoDurationControl)) return null
      const title = isResolution ? '视频分辨率' : '视频时长'
      const labels = isResolution ? allowedVideoResolutions : allowedVideoDurationLabels
      const value = isResolution ? videoResolution : String(videoDuration)
      const suffix = isResolution ? '' : 's'
      const onChange = (nextValue: string) => {
        if (isResolution) {
          setVideoResolution(nextValue as VideoTaskParams['resolution'])
        } else {
          setVideoDuration(Number(nextValue) as VideoTaskParams['duration'])
        }
      }
      return (
        <div className="fixed inset-0 z-[70]" onClick={() => setMobileParamSheet(null)}>
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm animate-overlay-in" />
          <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl bg-white dark:bg-gray-900 border-t border-gray-200/50 dark:border-white/[0.08] p-5 pb-safe animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">{title}</div>
            <CompactSegmentedSlider
              label={title}
              value={value}
              labels={labels}
              suffix={suffix}
              onChange={onChange}
            />
          </div>
        </div>
      )
    }
    const configMap: Record<Exclude<MobileParamSheet, 'videoResolution' | 'videoDuration'>, {
      title: string
      options: Array<{ label: string; value: string }>
      value: string
      onChange: (value: string) => void
    }> = {
      quality: {
        title: '质量',
        options: [
          { label: 'auto', value: 'auto' },
          { label: 'low', value: 'low' },
          { label: 'medium', value: 'medium' },
          { label: 'high', value: 'high' },
        ],
        value: params.quality,
        onChange: (value: string) => setParams({ quality: value as any }),
      },
      format: {
        title: '格式',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ],
        value: params.output_format,
        onChange: (value: string) => setParams({ output_format: value as any }),
      },
      moderation: {
        title: '审核',
        options: [
          { label: 'auto', value: 'auto' },
          { label: 'low', value: 'low' },
        ],
        value: params.moderation,
        onChange: (value: string) => setParams({ moderation: value as any }),
      },
    }
    const config = configMap[mobileParamSheet]

    return (
      <div className="fixed inset-0 z-[70]" onClick={() => setMobileParamSheet(null)}>
        <div className="absolute inset-0 bg-black/20 backdrop-blur-sm animate-overlay-in" />
        <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl bg-white dark:bg-gray-900 border-t border-gray-200/50 dark:border-white/[0.08] p-5 pb-safe animate-slide-up" onClick={(e) => e.stopPropagation()}>
          <div className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">{config.title}</div>
          <div className="flex flex-wrap gap-2">
            {config.options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  config.onChange(option.value)
                  setMobileParamSheet(null)
                }}
                className={`px-4 py-2 rounded-full text-sm transition-all ${
                  config.value === option.value
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-gray-100 dark:bg-white/[0.06] text-gray-700 dark:text-gray-300 active:scale-95'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* 全屏拖拽遮罩 */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-white/60 dark:bg-gray-900/60 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 rounded-3xl">
            <div className={`w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center ${
              atImageLimit ? 'bg-red-50 dark:bg-red-500/10 border-red-300' : 'bg-blue-50 dark:bg-blue-500/10 border-blue-400'
            }`}>
              {atImageLimit ? (
                <svg className="w-10 h-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              ) : (
                <svg className="w-10 h-10 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <div className="text-center">
              {atImageLimit ? (
                <>
                  <p className="text-lg font-semibold text-red-500">已达上限 {API_MAX_IMAGES} 张</p>
                  <p className="text-sm text-gray-400 mt-1">请先移除部分参考图后再添加</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">释放以添加参考图</p>
                  <p className="text-sm text-gray-400 mt-1">支持 JPG、PNG、WebP 等格式</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {taskMode === 'image' && showSizePicker && (
        <SizePickerModal
          currentSize={params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
        />
      )}

      {taskMode === 'video' && showVideoAspectPicker && (
        <VideoAspectModal
          currentAspect={hasVideoReferenceImage ? 'auto' : videoAspectRatio}
          hasReferenceImage={hasVideoReferenceImage}
          onSelect={setVideoAspectRatio}
          onClose={() => setShowVideoAspectPicker(false)}
        />
      )}

      {taskMode === 'image' && showParamsModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onMouseDown={() => setShowParamsModal(false)}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
          <div
            className="relative z-10 w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-200">参数设置</h3>
              <button
                type="button"
                onClick={() => setShowParamsModal(false)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
                aria-label="关闭参数设置"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {renderParams('grid-cols-2')}
          </div>
        </div>
      )}

      {renderMobileActionSheet()}

      <div data-input-bar className="safe-bottom-floating sm:safe-bottom-floating-sm fixed left-1/2 -translate-x-1/2 z-30 w-full max-w-4xl px-3 sm:px-4 transition-all duration-300">
        {selectedTaskIds.length > 0 && (
          <div className="flex justify-center mb-3">
            <div className="bg-gray-800/90 dark:bg-gray-800/90 backdrop-blur shadow-lg rounded-full flex items-center p-1 border border-white/10 pointer-events-auto">
              <button
                onClick={clearSelection}
                className="p-2 text-gray-300 hover:text-white transition-colors"
                title="取消选择"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <div
                className="min-w-[2.25rem] px-2 py-1 text-center text-sm font-semibold tabular-nums text-white/90"
                title={`已选中 ${selectedTaskIds.length} 条记录`}
              >
                {selectedTaskIds.length}
              </div>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <button
                onClick={handleSelectAllToggle}
                className="p-2 text-blue-400 hover:text-blue-300 transition-colors"
                title={selectedTaskIds.length === visibleTasks.length && visibleTasks.length > 0 ? "取消全选" : "全选当前可见"}
              >
                {selectedTaskIds.length === visibleTasks.length && visibleTasks.length > 0 ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path strokeDasharray="4 4" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
                  </svg>
                )}
              </button>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <button
                onClick={handleToggleFavorite}
                className="p-2 text-yellow-400 hover:text-yellow-300 transition-colors"
                title="收藏/取消收藏"
              >
                {selectedTaskIds.length > 0 && selectedTaskIds.every((id) => tasks.find((t) => t.id === id)?.isFavorite) ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                )}
              </button>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <button
                onClick={handleToggleArchived}
                className="p-2 text-slate-300 hover:text-white transition-colors"
                title="归档/取消归档"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <rect x="4" y="4" width="16" height="5" rx="1" />
                  <path d="M6 9v10a1 1 0 001 1h10a1 1 0 001-1V9" />
                  <path d="M10 13h4" />
                </svg>
              </button>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <button
                onClick={handleBatchDownload}
                className="p-2 text-emerald-400 hover:text-emerald-300 transition-colors"
                title={isIOS ? 'iOS 暂不支持批量下载' : '批量下载'}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v11m0 0l4-4m-4 4l-4-4M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" />
                </svg>
              </button>
              <div className="w-px h-5 bg-white/20 mx-1"></div>
              <button
                onClick={handleDeleteSelected}
                className="p-2 text-red-400 hover:text-red-300 transition-colors"
                title="删除选中"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        )}
        <div ref={cardRef} className="safe-input-card overflow-visible rounded-2xl border border-white/50 p-3 shadow-[0_8px_30px_rgb(0,0,0,0.08)] ring-1 ring-black/5 dark:border-white/[0.08] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 sm:rounded-3xl sm:p-4">
          {inputImages.length > 0 && (
            <div
              ref={handleRef}
              className="flex cursor-pointer touch-none select-none justify-center pb-2 pt-1 -mt-1 sm:hidden"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleMobileTogglePointerDown(e)
              }}
              onPointerUp={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleMobileTogglePointerUp(e)
              }}
              onTouchStart={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={handleMobileToggleClick}
              onPointerMove={handleMobileTogglePointerMove}
              onPointerCancel={() => {
                suppressHandleClickRef.current = false
              }}
              role="button"
              aria-label={mobileCollapsed ? '展开配置区域' : '收起配置区域'}
            >
              <div className={`h-1 w-10 rounded-full bg-gray-300 transition-transform duration-250 dark:bg-white/[0.10] ${mobileCollapsed ? 'scale-x-75' : 'scale-x-100'}`} />
            </div>
          )}

          {inputImages.length > 0 && (
            isMobile ? (
              <>
                {keyboardVisible && !mobileCollapsed ? (
                  <div className="mb-2">{renderImageThumbs()}</div>
                ) : !keyboardVisible ? (
                  <>
                    <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                      <div className={`collapse-inner ${mobileCollapsed ? '' : 'animate-fade-in-up'}`}>
                        {renderImageThumbs()}
                      </div>
                    </div>
                    {mobileCollapsed && (
                      <div className="mb-2 ml-1 text-xs text-gray-400 dark:text-gray-500">
                        {maskDraft ? `1 张遮罩主图 · ${referenceImages.length} 张参考图` : `${inputImages.length} 张参考图`}
                      </div>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              renderImageThumbs()
            )
          )}

          {!keyboardVisible && (
            <div className="animate-fade-in-up sm:hidden">
              {renderMobileParamChips()}
            </div>
          )}

          <div className="relative">
            {showAtImageMenu && (
              <div className="glass-surface-strong absolute bottom-full left-0 z-[90] mb-2 w-64 overflow-hidden rounded-2xl border border-gray-200/70 p-1.5 shadow-xl ring-1 ring-black/5 dark:border-white/[0.08] dark:ring-white/10">
                <div className="px-2 pb-1 pt-0.5 text-[11px] text-gray-400 dark:text-gray-500">选择当前参考图</div>
                <div className="tiny-scrollbar max-h-56 overflow-y-auto">
                  {atImageOptions.map(({ img, index }, optionIndex) => (
                    <button
                      key={img.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        insertImageMentionByIndex(index)
                        setAtImageMenuIndex(0)
                      }}
                      onMouseEnter={() => setAtImageMenuIndex(optionIndex)}
                      className={`flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors ${
                        optionIndex === atImageMenuIndex
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                          : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                      }`}
                    >
                      <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-gray-200/70 dark:border-white/[0.08]">
                        <img src={img.dataUrl} className="h-full w-full object-cover" alt="" />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{getImageMentionLabel(index)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              ref={textareaRef}
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => {
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                if (isComposingRef.current) return
                setPrompt(getContentEditablePlainText(el))
              }}
              onCompositionStart={() => {
                isComposingRef.current = true
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
                setPrompt(getContentEditablePlainText(el))
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                const range = getContentEditableSelection(el)
                setCursorPos(range.start)
                syncMentionTagSelection(el)
              }}
              onCopy={handlePromptCopy}
              onPaste={handlePromptPaste}
              onKeyDown={handleKeyDown}
              onClick={(e) => {
                const el = textareaRef.current
                if (!el) return
                const target = e.target as HTMLElement
                if (target.classList.contains('mention-tag')) {
                  const sel = window.getSelection()
                  if (sel) {
                    const range = document.createRange()
                    range.selectNode(target)
                    sel.removeAllRanges()
                    sel.addRange(range)
                    syncMentionTagSelection(el)
                  }
                  return
                }
                syncMentionTagSelection(el)
              }}
              data-placeholder={taskMode === 'video' ? '描述你想生成的视频。可添加参考图。' : '描述你想生成的图片。输入 @ 可引用当前参考图。'}
              className="w-full min-h-[42px] px-4 py-3 rounded-2xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] text-sm focus:outline-none leading-relaxed shadow-sm transition-[border-color,box-shadow] duration-200 whitespace-pre-wrap break-words empty:before:pointer-events-none empty:before:text-gray-400 empty:before:content-[attr(data-placeholder)] dark:text-gray-100 dark:empty:before:text-gray-500"
            />
          </div>

          <div className="mt-3">
            <div className="hidden items-center justify-between gap-3 sm:flex">
              <div className="flex items-center gap-2 overflow-visible">
                <div className="flex h-10 shrink-0 rounded-xl border border-gray-200/60 bg-white/70 p-1 text-sm shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <button
                    type="button"
                    onClick={() => setTaskMode('image')}
                    className={`inline-flex min-w-12 items-center justify-center rounded-lg px-3 leading-none transition ${taskMode === 'image' ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 dark:text-gray-300'}`}
                  >
                    图片
                  </button>
                  <button
                    type="button"
                    onClick={() => setTaskMode('video')}
                    className={`inline-flex min-w-12 items-center justify-center rounded-lg px-3 leading-none transition ${taskMode === 'video' ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900' : 'text-gray-500 dark:text-gray-300'}`}
                  >
                    视频
                  </button>
                </div>
                {taskMode === 'video' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowVideoAspectPicker(true)}
                      className="flex h-10 min-w-[104px] items-center justify-between rounded-xl border border-gray-200/60 bg-white/70 px-3 text-sm text-gray-700 shadow-sm transition-all hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      <span className="text-gray-400 dark:text-gray-500">比例</span>
                      <span>{hasVideoReferenceImage ? 'auto' : videoAspectRatio}</span>
                    </button>
                    {(canShowVideoResolutionControl || canShowVideoDurationControl) && (
                      <>
                        {canShowVideoResolutionControl && (
                        <CompactSegmentedSlider
                          label="分辨率"
                          value={videoResolution}
                          labels={allowedVideoResolutions}
                          onChange={(value) => setVideoResolution(value as VideoTaskParams['resolution'])}
                        />
                        )}
                        {canShowVideoDurationControl && (
                        <CompactSegmentedSlider
                          label="时长"
                          value={String(videoDuration)}
                          labels={allowedVideoDurationLabels}
                          suffix="s"
                          onChange={(value) => setVideoDuration(Number(value) as VideoTaskParams['duration'])}
                        />
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <div
                    className="relative"
                    onMouseEnter={sizeHint.show}
                    onMouseLeave={sizeHint.hide}
                  >
                    <ButtonTooltip visible={sizeHint.visible} text="设置输出尺寸" />
                    <button
                      type="button"
                      onClick={() => setShowSizePicker(true)}
                      className="flex h-10 w-[132px] items-center justify-between rounded-xl border border-gray-200/60 bg-white/70 px-3 text-sm text-gray-700 shadow-sm transition-all hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                    >
                      <span className="text-gray-400 dark:text-gray-500">尺寸</span>
                      <span>{normalizeImageSize(params.size) || DEFAULT_PARAMS.size}</span>
                    </button>
                  </div>
                )}
                <div
                  className="relative"
                  onMouseEnter={() => setAttachHover(true)}
                  onMouseLeave={() => setAttachHover(false)}
                >
                  <ButtonTooltip visible={atImageLimit && attachHover} text={`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`} />
                  <button
                    type="button"
                    onClick={() => !atImageLimit && fileInputRef.current?.click()}
                    className={`flex h-10 w-10 items-center justify-center rounded-xl shadow-sm transition-all ${
                      atImageLimit
                        ? 'cursor-not-allowed bg-gray-200 text-gray-300 dark:bg-white/[0.04] dark:text-gray-500'
                        : 'bg-gray-200 text-gray-500 hover:bg-gray-300 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                    }`}
                    title={atImageLimit ? `已达上限 ${API_MAX_IMAGES} 张` : '添加参考图'}
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>
                </div>
                {taskMode === 'image' && (
                  <button
                    type="button"
                    onClick={() => setShowParamsModal(true)}
                    className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-200 text-gray-500 shadow-sm transition-all hover:bg-gray-300 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                    title="打开参数设置"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.572c1.756.427 1.756 2.925 0 3.352a1.724 1.724 0 00-1.066 2.572c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.066c-.427 1.756-2.925 1.756-3.352 0a1.724 1.724 0 00-2.572-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.572c-1.756-.427-1.756-2.925 0-3.352A1.724 1.724 0 005.38 7.753c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.066z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {renderProviderSelector('w-[144px]')}
                <div
                  className="relative"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  {renderUsageCodePicker()}
                  <ButtonTooltip visible={!hasConfiguredProvider && submitHover} text="尚未完成后端 API 配置，请在右上角设置中进行" />
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={hasConfiguredProvider ? !canSubmit : false}
                    className={`flex h-10 min-w-[112px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium shadow-sm transition-all ${
                      !hasConfiguredProvider
                        ? 'cursor-pointer bg-gray-300 text-white dark:bg-white/[0.06]'
                        : 'bg-blue-500 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:opacity-50 dark:disabled:bg-white/[0.04]'
                    }`}
                    title={hasConfiguredProvider ? (taskMode === 'image' && maskDraft ? '遮罩编辑 (Ctrl+Enter)' : '生成 (Ctrl+Enter)') : '请先配置后端 API'}
                  >
                    {isSubmitting ? (
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                    <span>{isSubmitting ? '提交中' : taskMode === 'video' ? '生成视频' : maskDraft ? '遮罩编辑' : '生成图像'}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 sm:hidden">
              {!keyboardVisible && (
                <>
                  <div
                    className="relative"
                    onMouseEnter={() => setAttachHover(true)}
                    onMouseLeave={() => setAttachHover(false)}
                  >
                    <ButtonTooltip visible={atImageLimit && attachHover} text={`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`} />
                    <button
                      type="button"
                      onClick={() => !atImageLimit && fileInputRef.current?.click()}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm transition-all ${
                        atImageLimit
                          ? 'cursor-not-allowed bg-gray-200 text-gray-300 dark:bg-white/[0.04] dark:text-gray-500'
                          : 'bg-gray-200 text-gray-500 hover:bg-gray-300 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                      }`}
                      title={atImageLimit ? `已达上限 ${API_MAX_IMAGES} 张` : '从相册选择'}
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7a2 2 0 012-2h2l1.2 1.4A2 2 0 0010.7 7H18a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V7z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 13l2.5-2.5L13 13l2-2 3 3" />
                      </svg>
                    </button>
                  </div>
                  <div
                    className="relative"
                    onMouseEnter={() => setAttachHover(true)}
                    onMouseLeave={() => setAttachHover(false)}
                  >
                    <ButtonTooltip visible={atImageLimit && attachHover} text={`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`} />
                    <button
                      type="button"
                      onClick={() => !atImageLimit && cameraInputRef.current?.click()}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm transition-all ${
                        atImageLimit
                          ? 'cursor-not-allowed bg-gray-200 text-gray-300 dark:bg-white/[0.04] dark:text-gray-500'
                          : 'bg-gray-200 text-gray-500 hover:bg-gray-300 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                      }`}
                      title={atImageLimit ? `已达上限 ${API_MAX_IMAGES} 张` : '拍照添加'}
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8.5A2.5 2.5 0 015.5 6H7l1.1-1.3A2 2 0 019.6 4h4.8a2 2 0 011.5.7L17 6h1.5A2.5 2.5 0 0121 8.5v8A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-8z" />
                        <circle cx="12" cy="12" r="3.5" strokeWidth={2} />
                      </svg>
                    </button>
                  </div>
                </>
              )}

              <div className={`flex items-center gap-2 ${keyboardVisible ? 'w-full' : 'flex-1'}`}>
                {!keyboardVisible && renderProviderSelector('w-[104px] shrink-0')}
                <div
                  className="relative flex-1"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  {renderUsageCodePicker()}
                  <ButtonTooltip visible={!hasConfiguredProvider && submitHover} text="尚未完成后端 API 配置，请在右上角设置中进行" />
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={hasConfiguredProvider ? !canSubmit : false}
                    className={`flex h-10 w-full min-w-[136px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium shadow-sm transition-all ${
                      !hasConfiguredProvider
                        ? 'cursor-pointer bg-gray-300 text-white dark:bg-white/[0.06]'
                        : 'bg-blue-500 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:opacity-50 dark:disabled:bg-white/[0.04]'
                    }`}
                  >
                    {isSubmitting ? (
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                    <span className="whitespace-nowrap">{isSubmitting ? '提交中' : taskMode === 'video' ? '生成视频' : maskDraft ? '遮罩编辑' : '生成图像'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileUpload}
          />
        </div>
      </div>
    </>
  )
}
