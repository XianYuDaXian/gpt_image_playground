import { useStore } from '../store'
import Select from './Select'

export default function SearchBar() {
  const authStatus = useStore((s) => s.authStatus)
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const searchTags = useStore((s) => s.searchTags)
  const addSearchTag = useStore((s) => s.addSearchTag)
  const removeSearchTag = useStore((s) => s.removeSearchTag)
  const clearSearchTags = useStore((s) => s.clearSearchTags)
  const filterStatus = useStore((s) => s.filterStatus)
  const setFilterStatus = useStore((s) => s.setFilterStatus)
  const filterTaskType = useStore((s) => s.filterTaskType)
  const setFilterTaskType = useStore((s) => s.setFilterTaskType)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)
  const filterArchived = useStore((s) => s.filterArchived)
  const setFilterArchived = useStore((s) => s.setFilterArchived)
  const showUsageCodeTasksForAdmin = useStore((s) => s.showUsageCodeTasksForAdmin)
  const setShowUsageCodeTasksForAdmin = useStore((s) => s.setShowUsageCodeTasksForAdmin)
  const blurLoadedImages = useStore((s) => s.blurLoadedImages)
  const setBlurLoadedImages = useStore((s) => s.setBlurLoadedImages)
  const topButtonClass = 'flex h-11 w-11 items-center justify-center rounded-xl border transition-all'
  const hasSearchContent = Boolean(searchQuery.trim() || searchTags.length > 0)

  const commitSearchTag = () => {
    const nextTag = searchQuery.trim()
    if (!nextTag) return
    addSearchTag(nextTag)
    setSearchQuery('')
  }

  const commitSearchTagFromInput = (input: HTMLInputElement) => {
    const nextTag = input.value.trim()
    if (!nextTag) return
    addSearchTag(nextTag)
    setSearchQuery('')
  }

  const clearSearch = () => {
    setSearchQuery('')
    clearSearchTags()
  }

  return (
    <div className="relative z-40 mt-6 mb-4 flex flex-col gap-3">
      <div className="z-20 grid w-full min-w-0 grid-cols-[2.75rem_2.75rem_2.75rem_minmax(0,1fr)] items-center gap-2">
        <button
          onClick={() => {
            const nextValue = !filterFavorite
            setFilterFavorite(nextValue)
            if (nextValue) setFilterArchived(false)
          }}
          className={`${topButtonClass} ${
            filterFavorite
              ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-500/10 text-yellow-500'
              : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
          }`}
          title={filterFavorite ? '取消只看收藏' : '只看收藏'}
        >
          <svg className="w-5 h-5" fill={filterFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
        </button>
        <button
          onClick={() => {
            const nextValue = !filterArchived
            setFilterArchived(nextValue)
            if (nextValue) setFilterFavorite(false)
          }}
          className={`${topButtonClass} ${
            filterArchived
              ? 'border-slate-400 bg-slate-100 dark:bg-slate-500/10 text-slate-600 dark:text-slate-300'
              : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
          }`}
          title={filterArchived ? '返回未归档记录' : '查看归档记录'}
        >
          <svg className="w-5 h-5" fill={filterArchived ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="5" rx="1" />
            <path d="M6 9v10a1 1 0 001 1h10a1 1 0 001-1V9" />
            <path d="M10 13h4" />
          </svg>
        </button>
        <button
          onClick={() => setBlurLoadedImages(!blurLoadedImages)}
          className={`${topButtonClass} ${
            blurLoadedImages
              ? 'border-blue-400 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-300'
              : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
          }`}
          title={blurLoadedImages ? '取消模糊已加载图片' : '模糊已加载图片'}
        >
          {blurLoadedImages ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M3 3l18 18" />
              <path d="M10.6 10.6A2 2 0 0012 14a2 2 0 001.4-.6" />
              <path d="M9.9 5.2A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a17.9 17.9 0 01-3.1 4.2" />
              <path d="M6.1 6.7A18.1 18.1 0 002 12s3.5 7 10 7a10.8 10.8 0 004.7-1.1" />
            </svg>
          )}
        </button>
        <div className="flex h-11 min-w-0 items-center rounded-xl border border-gray-200 bg-white p-1 dark:border-white/[0.08] dark:bg-gray-900">
          {[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilterTaskType(item.value as 'all' | 'image' | 'video')}
              className={`flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg px-2 text-xs transition sm:text-sm ${
                filterTaskType === item.value
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                  : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/[0.06]'
              }`}
              title={`筛选${item.label}任务`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`grid w-full min-w-0 gap-2 ${authStatus?.role === 'admin' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {authStatus?.role === 'admin' && (
          <button
            onClick={() => setShowUsageCodeTasksForAdmin(!showUsageCodeTasksForAdmin)}
            className={`flex h-11 min-w-0 items-center justify-center rounded-xl border px-3 text-xs transition-all sm:text-sm ${
              showUsageCodeTasksForAdmin
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-300'
                : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
            }`}
            title={showUsageCodeTasksForAdmin ? '隐藏使用码图片' : '显示使用码图片'}
          >
            {showUsageCodeTasksForAdmin ? '已显示使用码' : '未显示使用码'}
          </button>
        )}
        <div className="relative h-11 min-w-0">
          <Select
            value={filterStatus}
            onChange={(val) => setFilterStatus(val as any)}
            options={[
              { label: '全部状态', value: 'all' },
              { label: '已完成', value: 'done' },
              { label: '生成中', value: 'running' },
              { label: '失败', value: 'error' },
            ]}
            className="flex h-11 items-center rounded-xl border border-gray-200 bg-white px-3 text-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 dark:border-white/[0.08] dark:bg-gray-900 dark:hover:bg-white/[0.06]"
          />
        </div>
      </div>
      <div className="relative z-10 w-full min-w-0">
        <svg
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <form
          className="hide-scrollbar flex min-h-11 w-full items-center gap-2 overflow-x-auto rounded-xl border border-gray-200 bg-white py-1.5 pl-10 pr-10 text-sm transition focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/30 dark:border-white/[0.08] dark:bg-gray-900"
          onSubmit={(event) => {
            event.preventDefault()
            commitSearchTag()
          }}
        >
          {searchTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-500/10 dark:text-blue-200"
            >
              <span className="truncate">{tag}</span>
              <button
                type="button"
                onClick={() => removeSearchTag(tag)}
                className="rounded-full p-0.5 text-blue-500 transition hover:bg-blue-100 hover:text-blue-700 dark:text-blue-200 dark:hover:bg-blue-400/20"
                aria-label={`移除搜索标签 ${tag}`}
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          ))}
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitSearchTagFromInput(event.currentTarget)
            }}
            onKeyUp={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitSearchTagFromInput(event.currentTarget)
            }}
            onBlur={(event) => commitSearchTagFromInput(event.currentTarget)}
            type="search"
            enterKeyHint="done"
            autoComplete="off"
            placeholder={searchTags.length >= 2 ? '' : searchTags.length > 0 ? '继续输入并回车添加标签' : '搜索提示词、使用码、别名、参数、比例、分辨率...'}
            className="min-w-[10rem] flex-1 shrink-0 bg-transparent py-1.5 text-sm outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </form>
        {hasSearchContent && (
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={clearSearch}
            className="absolute right-3 top-5 -translate-y-1/2 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-white/[0.08] dark:hover:text-gray-300"
            aria-label="清空搜索"
            title="清空搜索"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
