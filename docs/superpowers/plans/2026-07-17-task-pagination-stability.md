# 任务列表翻页稳定性与速度优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修掉筛选后跳页时的页码来回跳，并在不改每页数量的前提下减少无效刷新，让 PC / 移动端翻页更稳更快。

**架构：** 在 `src/lib/taskListRequest.ts` 抽出纯函数请求键与世代号判定；`src/store.ts` 的 `refreshTasksFromServer` 只应用最新合法请求结果，且不再用服务端 `page` 回写用户页码；`TaskGrid` 修正筛选重置与 clamp 时机，并展示轻量 loading。SSE / focus 刷新统一走防抖与去重。

**技术栈：** React、Zustand、TypeScript、Vitest、Fastify 现有 `/api/tasks` 分页接口

**规格：** `docs/superpowers/specs/2026-07-17-task-pagination-stability-design.md`

---

## 文件结构

- 创建：`src/lib/taskListRequest.ts`  
  请求键构建、请求键比较、结果是否可应用、页码 clamp 纯函数
- 创建：`src/lib/taskListRequest.test.ts`  
  覆盖竞态丢弃、筛选后跳页、total clamp
- 修改：`src/store.ts`  
  世代号刷新、禁止 page 回写、SSE / 生命周期去重
- 修改：`src/components/TaskGrid.tsx`  
  筛选重置、跳转输入、loading 表现、延迟 clamp
- 可选小改：`src/lib/backendTasks.ts`  
  仅当需要透传 `AbortSignal` 时再改

---

### 任务 1：请求判定纯函数与测试

**文件：**
- 创建：`src/lib/taskListRequest.ts`
- 创建：`src/lib/taskListRequest.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildTaskListRequestKey,
  canApplyTaskListResult,
  clampTaskPage,
  isSameTaskListRequestKey,
} from './taskListRequest'

describe('taskListRequest', () => {
  it('相同筛选与页码生成稳定 requestKey', () => {
    const a = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['猫', '白底'],
      searchTagMode: 'include',
      status: 'done',
      taskType: 'image',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    const b = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['猫', '白底'],
      searchTagMode: 'include',
      status: 'done',
      taskType: 'image',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(isSameTaskListRequestKey(a, b)).toBe(true)
  })

  it('旧请求结果不可覆盖新请求', () => {
    const key = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: [],
      searchTagMode: 'include',
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(canApplyTaskListResult({
      responseSeq: 3,
      lastAppliedSeq: 4,
      inFlightSeq: 5,
      requestKey: key,
      currentKey: key,
    })).toBe(false)
  })

  it('最新飞行请求且 key 仍匹配时可以应用', () => {
    const key = buildTaskListRequestKey({
      page: 4,
      pageSize: 50,
      searchTags: ['风景'],
      searchTagMode: 'include',
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      showUsageCodeTasksForAdmin: false,
    })
    expect(canApplyTaskListResult({
      responseSeq: 5,
      lastAppliedSeq: 4,
      inFlightSeq: 5,
      requestKey: key,
      currentKey: key,
    })).toBe(true)
  })

  it('仅在当前条件下 total 变小时才 clamp 页码', () => {
    expect(clampTaskPage({ page: 4, total: 120, pageSize: 30 })).toBe(4)
    expect(clampTaskPage({ page: 4, total: 50, pageSize: 30 })).toBe(2)
    expect(clampTaskPage({ page: 1, total: 0, pageSize: 30 })).toBe(1)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npm test -- src/lib/taskListRequest.test.ts
```

预期：FAIL，找不到模块或函数未定义。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/lib/taskListRequest.ts`：

```ts
export type TaskListRequestKey = {
  page: number
  pageSize: number
  searchTags: string[]
  searchTagMode: 'include' | 'exclude'
  status: 'all' | 'running' | 'done' | 'error'
  taskType: 'all' | 'image' | 'video'
  favorite: boolean
  archived: boolean
  showUsageCodeTasksForAdmin: boolean
}

export function buildTaskListRequestKey(input: TaskListRequestKey): TaskListRequestKey {
  return {
    page: Math.max(1, Math.floor(input.page) || 1),
    pageSize: Math.max(1, Math.floor(input.pageSize) || 50),
    searchTags: input.searchTags.map((tag) => tag.trim()).filter(Boolean),
    searchTagMode: input.searchTagMode === 'exclude' ? 'exclude' : 'include',
    status: input.status,
    taskType: input.taskType,
    favorite: Boolean(input.favorite),
    archived: Boolean(input.archived),
    showUsageCodeTasksForAdmin: Boolean(input.showUsageCodeTasksForAdmin),
  }
}

export function isSameTaskListRequestKey(
  a: TaskListRequestKey | null | undefined,
  b: TaskListRequestKey | null | undefined,
): boolean {
  if (!a || !b) return false
  if (a.page !== b.page) return false
  if (a.pageSize !== b.pageSize) return false
  if (a.searchTagMode !== b.searchTagMode) return false
  if (a.status !== b.status) return false
  if (a.taskType !== b.taskType) return false
  if (a.favorite !== b.favorite) return false
  if (a.archived !== b.archived) return false
  if (a.showUsageCodeTasksForAdmin !== b.showUsageCodeTasksForAdmin) return false
  if (a.searchTags.length !== b.searchTags.length) return false
  return a.searchTags.every((tag, index) => tag === b.searchTags[index])
}

export function canApplyTaskListResult(input: {
  responseSeq: number
  lastAppliedSeq: number
  inFlightSeq: number | null
  requestKey: TaskListRequestKey
  currentKey: TaskListRequestKey
}): boolean {
  if (input.responseSeq < input.lastAppliedSeq) return false
  if (input.inFlightSeq != null && input.responseSeq !== input.inFlightSeq) return false
  return isSameTaskListRequestKey(input.requestKey, input.currentKey)
}

export function clampTaskPage(input: {
  page: number
  total: number
  pageSize: number
}): number {
  const pageSize = Math.max(1, Math.floor(input.pageSize) || 1)
  const totalPages = Math.max(1, Math.ceil(Math.max(0, input.total) / pageSize))
  const page = Math.max(1, Math.floor(input.page) || 1)
  return Math.min(page, totalPages)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
npm test -- src/lib/taskListRequest.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/lib/taskListRequest.ts src/lib/taskListRequest.test.ts
git commit -m "feat: 任务列表请求判定纯函数"
```

---

### 任务 2：刷新层接入世代号并禁止 page 回写

**文件：**
- 修改：`src/store.ts`
- 测试：`src/lib/taskListRequest.test.ts`（已有）

- [ ] **步骤 1：在 store 顶部增加请求状态变量**

在 `src/store.ts` 模块级变量区加入：

```ts
import {
  buildTaskListRequestKey,
  canApplyTaskListResult,
  clampTaskPage,
  isSameTaskListRequestKey,
  type TaskListRequestKey,
} from './lib/taskListRequest'

let taskListRequestSeq = 0
let taskListInFlightSeq: number | null = null
let taskListLastAppliedSeq = 0
let taskListLastSuccessAt: number | null = null
let taskListLastRequestKey: TaskListRequestKey | null = null
```

并在 `AppState` 增加可选 loading 状态：

```ts
isRefreshingTasks: boolean
setIsRefreshingTasks: (value: boolean) => void
```

默认：

```ts
isRefreshingTasks: false,
setIsRefreshingTasks: (isRefreshingTasks) => set({ isRefreshingTasks }),
```

- [ ] **步骤 2：重写 `refreshTasksFromServer`**

把现有：

```ts
export async function refreshTasksFromServer(options: { silent?: boolean } = {}) {
  try {
    const state = useStore.getState()
    const taskPageResult = await fetchBackendTaskPage({ ... })
    state.setTaskPaginationMeta({
      page: taskPageResult.page,
      pageSize: taskPageResult.pageSize,
      total: taskPageResult.total,
    })
    useStore.getState().setTasks(sortTasksForDisplay(mergedTasks))
  } catch ...
}
```

改成：

```ts
export async function refreshTasksFromServer(options: {
  silent?: boolean
  force?: boolean
} = {}) {
  const state = useStore.getState()
  const requestKey = buildTaskListRequestKey({
    page: state.taskPage,
    pageSize: state.taskPageSize,
    searchTags: state.searchTags,
    searchTagMode: state.searchTagMode,
    status: state.filterStatus,
    taskType: state.filterTaskType,
    favorite: state.filterFavorite,
    archived: state.filterArchived,
    showUsageCodeTasksForAdmin: state.showUsageCodeTasksForAdmin,
  })

  if (
    !options.force
    && taskListInFlightSeq != null
    && taskListLastRequestKey
    && isSameTaskListRequestKey(taskListLastRequestKey, requestKey)
  ) {
    return
  }

  const responseSeq = ++taskListRequestSeq
  taskListInFlightSeq = responseSeq
  taskListLastRequestKey = requestKey
  state.setIsRefreshingTasks(true)

  try {
    const taskPageResult = await fetchBackendTaskPage({
      page: requestKey.page,
      pageSize: requestKey.pageSize,
      searchTags: requestKey.searchTags,
      searchTagMode: requestKey.searchTagMode,
      status: requestKey.status,
      taskType: requestKey.taskType,
      favorite: requestKey.favorite,
      archived: requestKey.archived,
      showUsageCodeTasksForAdmin: requestKey.showUsageCodeTasksForAdmin,
    })

    const latest = useStore.getState()
    const currentKey = buildTaskListRequestKey({
      page: latest.taskPage,
      pageSize: latest.taskPageSize,
      searchTags: latest.searchTags,
      searchTagMode: latest.searchTagMode,
      status: latest.filterStatus,
      taskType: latest.filterTaskType,
      favorite: latest.filterFavorite,
      archived: latest.filterArchived,
      showUsageCodeTasksForAdmin: latest.showUsageCodeTasksForAdmin,
    })

    if (!canApplyTaskListResult({
      responseSeq,
      lastAppliedSeq: taskListLastAppliedSeq,
      inFlightSeq: taskListInFlightSeq,
      requestKey,
      currentKey,
    })) {
      return
    }

    const mergedTasks = mergeLocalTaskFlags(taskPageResult.items)
    const nextPage = clampTaskPage({
      page: latest.taskPage,
      total: taskPageResult.total,
      pageSize: latest.taskPageSize,
    })

    latest.setTaskPaginationMeta({
      // 关键：不要写 page: taskPageResult.page
      page: nextPage,
      pageSize: latest.taskPageSize,
      total: taskPageResult.total,
    })
    useStore.getState().setTasks(sortTasksForDisplay(mergedTasks))
    taskListLastAppliedSeq = responseSeq
    taskListLastSuccessAt = Date.now()
  } catch (err) {
    if (!options.silent) {
      useStore.getState().showToast(
        `刷新后端任务失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  } finally {
    if (taskListInFlightSeq === responseSeq) {
      taskListInFlightSeq = null
      useStore.getState().setIsRefreshingTasks(false)
    }
  }
}
```

- [ ] **步骤 3：修正 `scheduleTaskRefresh`**

保持防抖，但默认 delay 取 `400`；SSE 高频场景继续复用它。不要在这里改页码。

```ts
function scheduleTaskRefresh(delay = 400) {
  if (typeof window === 'undefined') return
  if (taskRefreshTimer != null) window.clearTimeout(taskRefreshTimer)
  taskRefreshTimer = window.setTimeout(() => {
    taskRefreshTimer = null
    void refreshTasksFromServer({ silent: true })
  }, delay)
}
```

- [ ] **步骤 4：生命周期恢复去重**

在 `setupTaskRefreshLifecycle` 中：

```ts
const handleResume = () => {
  if (taskListLastSuccessAt && Date.now() - taskListLastSuccessAt < 1500) return
  void refreshTasksFromServer({ silent: true })
}
```

visibility / focus / pageshow / online 都走这个逻辑。

- [ ] **步骤 5：运行类型检查与单测**

```bash
npm test -- src/lib/taskListRequest.test.ts
npx tsc -b --pretty false
```

预期：通过

- [ ] **步骤 6：Commit**

```bash
git add src/store.ts
git commit -m "fix: 任务列表刷新只应用最新请求"
```

---

### 任务 3：TaskGrid 页码与筛选交互稳定化

**文件：**
- 修改：`src/components/TaskGrid.tsx`

- [ ] **步骤 1：读取 loading 状态并修正 clamp 时机**

1. 增加：

```ts
const isRefreshingTasks = useStore((s) => s.isRefreshingTasks)
```

2. 删除或收紧这段“旧 total 立即压页码”的逻辑：

```ts
useEffect(() => {
  if (taskPage > totalPages) {
    setTaskPage(totalPages)
  }
}, [taskPage, totalPages, setTaskPage])
```

改为：

```ts
useEffect(() => {
  // 只在非刷新中、且当前 total 已对应当前筛选时，才做最终 clamp
  if (isRefreshingTasks) return
  if (taskPage > totalPages) {
    setTaskPage(totalPages)
  }
}, [isRefreshingTasks, taskPage, totalPages, setTaskPage])
```

- [ ] **步骤 2：筛选重置保持，但确保顺序正确**

保留：

```ts
useEffect(() => {
  setTaskPage(1)
}, [searchTags, searchTagMode, filterStatus, filterTaskType, filterFavorite, filterArchived, showUsageCodeTasksForAdmin, setTaskPage])
```

刷新 effect 继续依赖 `taskPage` 与筛选条件：

```ts
useEffect(() => {
  void refreshTasksFromServer({ silent: true })
}, [taskPage, taskPageSize, searchTags, searchTagMode, filterStatus, filterTaskType, filterFavorite, filterArchived, showUsageCodeTasksForAdmin])
```

注意：不要在筛选 effect 里直接请求；统一走 `taskPage` 变化后的刷新，避免重复。

- [ ] **步骤 3：跳转输入只在确认时生效**

保持：

```ts
const submitPageInput = () => {
  goToPage(Number(pageInput))
  setPageInput(String(Math.min(totalPages, Math.max(1, Number(pageInput) || 1))))
}
```

确认：

- `onChange` 只改 `pageInput`
- `onBlur` / `Enter` 才 `submitPageInput`
- 不要在输入过程中 `setTaskPage`

- [ ] **步骤 4：loading 表现**

在页码区增加轻量提示，不清空网格：

```tsx
{isRefreshingTasks && (
  <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">刷新中</span>
)}
```

空态判断仍用 `tasks.length`，避免 loading 时闪成“没有记录”。

- [ ] **步骤 5：本地手动验证清单**

1. 无筛选，连续点下一页，最终页稳定  
2. 筛选到约 5 页，跳到第 4 页，观察是否还会 1/4 来回跳  
3. 筛选切换后应回第 1 页  
4. 输入跳转非法值应钳制  
5. 运行中任务完成时，当前页不应被打回第 1 页

- [ ] **步骤 6：Commit**

```bash
git add src/components/TaskGrid.tsx src/store.ts
git commit -m "fix: 稳定任务列表筛选与跳页交互"
```

---

### 任务 4：SSE 局部更新与整页刷新边界收紧

**文件：**
- 修改：`src/store.ts`

- [ ] **步骤 1：收紧 `setupGlobalTaskListStream` 的整页刷新条件**

当前：

```ts
const shouldRefreshList =
  !previousTask
  || useStore.getState().taskPage !== 1
  || previousTask.serverStatus !== payload.task.serverStatus
```

改为更保守：

```ts
const state = useStore.getState()
const isOnFirstPage = state.taskPage === 1
const statusChanged = previousTask?.serverStatus !== payload.task.serverStatus
const becameTerminal = previousTask?.status === 'running' && payload.task.status !== 'running'

// 已在列表中的任务：优先局部 upsert
// 仅在“新任务进入第一页”或“可能改变当前页成员”时整页刷新
const shouldRefreshList =
  (!previousTask && isOnFirstPage)
  || statusChanged
  || becameTerminal
```

并继续：

```ts
upsertTaskFromServer(payload.task)
if (shouldRefreshList) scheduleTaskRefresh()
```

- [ ] **步骤 2：单任务 SSE 失败兜底保持防抖**

`source.onerror` 中继续：

```ts
window.setTimeout(async () => {
  await refreshTasksFromServer({ silent: true })
}, 1500)
```

不要立即同步硬刷。

- [ ] **步骤 3：验证运行中任务不会导致页码跳动**

手动：

1. 停在筛选后的第 2 页  
2. 另开任务生成  
3. 观察第 2 页页码是否保持  
4. 完成后列表可局部更新或防抖刷新，但页码不能跳回 1

- [ ] **步骤 4：Commit**

```bash
git add src/store.ts
git commit -m "fix: 收紧任务 SSE 整页刷新边界"
```

---

### 任务 5：回归验证与收尾

**文件：**
- 无新文件，或按需补测试

- [ ] **步骤 1：跑测试与类型检查**

```bash
npm test -- src/lib/taskListRequest.test.ts
npx tsc -b --pretty false
```

预期：全部通过

- [ ] **步骤 2：按规格验收**

对照规格第 10 / 11 节：

1. 筛选后 5 页跳到 4，不再 1/4 来回跳  
2. 连续翻页只落最终页  
3. 筛选回第 1 页稳定  
4. 旧请求晚到不覆盖  
5. SSE / focus 不打乱页码  
6. 每页数量策略不变  

- [ ] **步骤 3：如需部署到 41，再单独执行部署**

本计划默认先完成本地修复与验证。部署不是本计划必做步骤。

- [ ] **步骤 4：最终 Commit（仅当还有未提交修复时）**

```bash
git add src/lib/taskListRequest.ts src/lib/taskListRequest.test.ts src/store.ts src/components/TaskGrid.tsx
git commit -m "fix: 完成任务列表翻页稳定性优化"
```

---

## 自检

1. **规格覆盖**
   - 请求世代号：任务 1 / 2  
   - 禁止 page 回写：任务 2  
   - 筛选重置与 clamp：任务 3  
   - SSE / 生命周期去重：任务 2 / 4  
   - 速度优化：任务 2 / 3 / 4  
2. **无占位符**
   - 无 TODO / 待定 / “类似任务 N”  
3. **类型一致**
   - `TaskListRequestKey`
   - `canApplyTaskListResult`
   - `clampTaskPage`
   - `isRefreshingTasks`
4. **范围聚焦**
   - 不做无限滚动、虚拟列表、自定义每页条数
