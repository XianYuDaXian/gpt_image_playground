import { useMemo, useRef, useState, useEffect } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask, refreshTasksFromServer } from '../store'
import TaskCard from './TaskCard'
import Select from './Select'

function getPaginationLayout() {
  if (typeof window === 'undefined') {
    return {
      pageSize: 50,
      pageOptionCount: 7,
      compact: false,
    }
  }

  const width = window.innerWidth
  const dpi = window.devicePixelRatio || 1
  const isMobile = width < 640

  if (isMobile) {
    return {
      pageSize: dpi >= 3 ? 24 : 30,
      pageOptionCount: 5,
      compact: true,
    }
  }

  if (width >= 1536 && dpi >= 2) {
    return {
      pageSize: 72,
      pageOptionCount: 9,
      compact: false,
    }
  }

  if (width >= 1280 || dpi >= 2) {
    return {
      pageSize: 60,
      pageOptionCount: 9,
      compact: false,
    }
  }

  return {
    pageSize: 50,
    pageOptionCount: 7,
    compact: false,
  }
}

function buildPageOptions(totalPages: number, currentPage: number, visibleCount: number) {
  const pages = new Set<number>()
  const sideCount = Math.max(1, Math.floor(visibleCount / 2))
  const start = Math.max(1, currentPage - sideCount)
  const end = Math.min(totalPages, currentPage + sideCount)

  pages.add(1)
  pages.add(totalPages)

  for (let page = start; page <= end; page += 1) {
    pages.add(page)
  }

  return Array.from(pages)
    .sort((a, b) => a - b)
    .map((page) => ({
      label: `第 ${page} 页`,
      value: page,
    }))
}

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const searchTags = useStore((s) => s.searchTags)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterTaskType = useStore((s) => s.filterTaskType)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const filterArchived = useStore((s) => s.filterArchived)
  const showUsageCodeTasksForAdmin = useStore((s) => s.showUsageCodeTasksForAdmin)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const setVisibleTaskIds = useStore((s) => s.setVisibleTaskIds)
  const taskPage = useStore((s) => s.taskPage)
  const setTaskPage = useStore((s) => s.setTaskPage)
  const taskPageSize = useStore((s) => s.taskPageSize)
  const setTaskPageSize = useStore((s) => s.setTaskPageSize)
  const taskTotal = useStore((s) => s.taskTotal)
  const hasOverlayOpen = useStore((s) =>
    Boolean(s.detailTaskId || s.lightboxImageId || s.maskEditorImageId || s.showSettings || s.confirmDialog),
  )

  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const [pageInput, setPageInput] = useState('1')
  const [paginationLayout, setPaginationLayout] = useState(() => getPaginationLayout())
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const totalPages = Math.max(1, Math.ceil(taskTotal / taskPageSize))
  const safeCurrentPage = Math.min(taskPage, totalPages)
  const shouldDeferImageLoading = tasks.filter((task) => task.outputImages.length > 0).length > 20
  const pageOptions = useMemo(
    () => buildPageOptions(totalPages, safeCurrentPage, paginationLayout.pageOptionCount),
    [paginationLayout.pageOptionCount, safeCurrentPage, totalPages],
  )

  useEffect(() => {
    setPageInput(String(safeCurrentPage))
  }, [safeCurrentPage])

  useEffect(() => {
    setTaskPage(1)
  }, [searchQuery, searchTags, filterStatus, filterTaskType, filterFavorite, filterArchived, showUsageCodeTasksForAdmin, setTaskPage])

  useEffect(() => {
    if (taskPage > totalPages) {
      setTaskPage(totalPages)
    }
  }, [taskPage, totalPages, setTaskPage])

  useEffect(() => {
    const applyLayout = () => {
      setPaginationLayout((prev) => {
        const next = getPaginationLayout()
        if (
          prev.pageSize === next.pageSize &&
          prev.pageOptionCount === next.pageOptionCount &&
          prev.compact === next.compact
        ) {
          return prev
        }
        return next
      })
    }

    applyLayout()
    window.addEventListener('resize', applyLayout)
    return () => window.removeEventListener('resize', applyLayout)
  }, [])

  useEffect(() => {
    if (taskPageSize !== paginationLayout.pageSize) {
      setTaskPageSize(paginationLayout.pageSize)
    }
  }, [paginationLayout.pageSize, setTaskPageSize, taskPageSize])

  useEffect(() => {
    void refreshTasksFromServer({ silent: true })
  }, [taskPage, taskPageSize, searchQuery, searchTags, filterStatus, filterTaskType, filterFavorite, filterArchived, showUsageCodeTasksForAdmin])

  useEffect(() => {
    setVisibleTaskIds(tasks.map((task) => task.id))
    return () => setVisibleTaskIds([])
  }, [tasks, setVisibleTaskIds])

  const handleDelete = (task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startX: clientX,
      startY: clientY,
      currentX: clientX,
      currentY: clientY,
    })
  }

  const updateSelectionFromPoint = (clientX: number, clientY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.x, clientX)
    const maxX = Math.max(start.x, clientX)
    const minY = Math.min(start.y, clientY)
    const maxY = Math.max(start.y, clientY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const isIntersecting =
        minX < rect.right && maxX > rect.left && minY < rect.bottom && maxY > rect.top

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (hasOverlayOpen) return
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target, e.clientX, e.clientY, isCtrl)
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const distance = Math.hypot(e.clientX - start.x, e.clientY - start.y)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startX: start.x,
        startY: start.y,
        currentX: e.clientX,
        currentY: e.clientY,
      })
      updateSelectionFromPoint(e.clientX, e.clientY)
      e.preventDefault()
    }

    const handleDocumentMouseUp = () => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      isDragging.current = false
      dragStart.current = null
      setSelectionBox(null)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('mousemove', handleDocumentMouseMove)
    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('mousemove', handleDocumentMouseMove)
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [clearSelection, hasOverlayOpen, isMac])

  const goToPage = (page: number) => {
    setTaskPage(Math.min(totalPages, Math.max(1, Math.floor(page) || 1)))
  }

  const submitPageInput = () => {
    goToPage(Number(pageInput))
    setPageInput(String(Math.min(totalPages, Math.max(1, Number(pageInput) || 1))))
  }

  const renderPagination = (position: 'top' | 'bottom') => {
    if (totalPages <= 1) return null

    return (
      <div
        className={`glass-surface-strong relative z-30 mb-4 rounded-2xl border border-gray-200/70 p-3 dark:border-white/[0.08] ${
          position === 'bottom' ? 'mt-4 mb-28 sm:mb-36 md:mb-44' : ''
        }`}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            共 {taskTotal} 条，每页 {taskPageSize} 条，第 {safeCurrentPage} / {totalPages} 页
          </div>
          <div
            className={
              paginationLayout.compact
                ? 'grid w-full grid-cols-[minmax(0,0.85fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.85fr)] items-center gap-2'
                : 'flex items-center justify-end gap-2'
            }
          >
            <button
              type="button"
              onClick={() => goToPage(safeCurrentPage - 1)}
              disabled={safeCurrentPage <= 1}
              className="h-12 min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 text-sm text-gray-700 transition disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
            >
              上一页
            </button>
            <div className={paginationLayout.compact ? 'min-w-0' : 'w-32'}>
              <Select
                value={safeCurrentPage}
                onChange={(value) => goToPage(Number(value))}
                options={pageOptions}
                className="flex h-12 items-center rounded-xl border border-gray-200/70 bg-white/80 px-3 text-sm text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
              />
            </div>
            <label className="flex h-12 min-w-0 items-center gap-2 rounded-xl border border-gray-200/70 bg-white/80 px-3 text-sm text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200">
              <span className="text-xs text-gray-500 dark:text-gray-400">跳转</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onBlur={submitPageInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitPageInput()
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-right outline-none"
              />
            </label>
            <button
              type="button"
              onClick={() => goToPage(safeCurrentPage + 1)}
              disabled={safeCurrentPage >= totalPages}
              className="h-12 min-w-0 rounded-xl border border-gray-200/70 bg-white/80 px-3 text-sm text-gray-700 transition disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!tasks.length) {
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {searchQuery || searchTags.length > 0 || filterFavorite || filterArchived || filterTaskType !== 'all' ? (
          <p className="text-sm">没有找到匹配的记录</p>
        ) : (
          <>
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <p className="text-sm">输入提示词开始生成图片</p>
          </>
        )}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh] pb-8 md:pb-12"
    >
      {renderPagination('top')}
      <div ref={gridRef} className="grid grid-cols-1 gap-4 pb-6 sm:grid-cols-2 lg:grid-cols-3">
        {tasks.map((task) => (
          <div key={task.id} className="task-card-wrapper" data-task-id={task.id}>
            <TaskCard
              task={task}
              deferImageLoading={shouldDeferImageLoading}
              onClick={(e) => {
                if (Date.now() < suppressClickUntil.current) {
                  e.preventDefault()
                  return
                }
                suppressClickUntil.current = 0
                const isCtrl = isMac ? e.metaKey : e.ctrlKey
                if (isCtrl) {
                  useStore.getState().toggleTaskSelection(task.id)
                } else if (selectedTaskIds.length > 0) {
                  useStore.getState().toggleTaskSelection(task.id)
                } else {
                  setDetailTaskId(task.id)
                }
              }}
              onReuse={() => reuseConfig(task)}
              onEditOutputs={() => editOutputs(task)}
              onDelete={() => handleDelete(task)}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {renderPagination('bottom')}
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[100]"
          style={{
            left: Math.min(selectionBox.startX, selectionBox.currentX),
            top: Math.min(selectionBox.startY, selectionBox.currentY),
            width: Math.abs(selectionBox.currentX - selectionBox.startX),
            height: Math.abs(selectionBox.currentY - selectionBox.startY),
          }}
        />
      )}
    </div>
  )
}
