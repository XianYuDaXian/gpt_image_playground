# 端点未使用使用码明细 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 管理员点击 API 配置端点行的「未用 N」后，弹出该端点使用码剩余明细，显示备注名并按不限优先、剩余降序排列。

**架构：** 将过滤/排序抽成纯函数并单测覆盖；在 `SettingsModal` 的端点标签旁增加可点击「未用 N」触发器；PC 用 portal popover，移动端用 bottom sheet；数据复用已有 `usageCodes`，不改后端。

**技术栈：** React + TypeScript + Tailwind + Vitest + createPortal

**规格：** `docs/superpowers/specs/2026-07-11-provider-unused-usage-codes-design.md`

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建 `src/lib/providerUnusedUsageCodes.ts` | 过滤、排序、格式化某端点未使用使用码明细 |
| 创建 `src/lib/providerUnusedUsageCodes.test.ts` | 纯函数单测 |
| 修改 `src/components/SettingsModal.tsx` | 接入触发器与 PC/移动明细层 UI |

不改后端，不改 `backendSettings` 类型。

---

### 任务 1：纯函数与单测

**文件：**
- 创建：`src/lib/providerUnusedUsageCodes.ts`
- 创建：`src/lib/providerUnusedUsageCodes.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  formatProviderUnusedRemaining,
  listProviderUnusedUsageCodes,
  type ProviderUnusedUsageCodeSource,
} from './providerUnusedUsageCodes'

function makeCode(partial: Partial<ProviderUnusedUsageCodeSource> & { id: string; name: string }): ProviderUnusedUsageCodeSource {
  return {
    id: partial.id,
    name: partial.name,
    code: partial.code ?? null,
    allowedProviderProfileIds: partial.allowedProviderProfileIds ?? null,
    providerRemainingImageCredits: partial.providerRemainingImageCredits ?? null,
    providerRemainingVideoCredits: partial.providerRemainingVideoCredits ?? null,
  }
}

describe('listProviderUnusedUsageCodes', () => {
  it('只保留授权且剩余>0或不限的使用码，不限排最前，其余按剩余降序，同剩余按备注名排序', () => {
    const codes = [
      makeCode({
        id: 'a',
        name: '张三',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 3 },
      }),
      makeCode({
        id: 'b',
        name: '李四',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 10 },
      }),
      makeCode({
        id: 'c',
        name: '王五',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: null as unknown as number },
      }),
      makeCode({
        id: 'd',
        name: '赵六',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 0 },
      }),
      makeCode({
        id: 'e',
        name: '钱七',
        allowedProviderProfileIds: ['p2'],
        providerRemainingImageCredits: { p2: 99 },
      }),
      makeCode({
        id: 'f',
        name: '孙八',
        allowedProviderProfileIds: ['p1'],
        providerRemainingImageCredits: { p1: 10 },
      }),
    ]

    // 说明：remaining 为 null 表示不限。测试里用显式 null 字段。
    codes[2] = {
      ...codes[2],
      providerRemainingImageCredits: { p1: null },
    }

    const result = listProviderUnusedUsageCodes(codes, 'p1', 'images')
    expect(result.map((item) => item.id)).toEqual(['c', 'b', 'f', 'a'])
    expect(result[0]).toMatchObject({ id: 'c', name: '王五', remaining: null })
    expect(result[1]).toMatchObject({ id: 'b', remaining: 10 })
    expect(result[2]).toMatchObject({ id: 'f', remaining: 10 })
    expect(result[3]).toMatchObject({ id: 'a', remaining: 3 })
  })

  it('视频端点读取视频剩余字段', () => {
    const codes = [
      makeCode({
        id: 'v1',
        name: '视频甲',
        allowedProviderProfileIds: null,
        providerRemainingVideoCredits: { p1: 5 },
        providerRemainingImageCredits: { p1: 100 },
      }),
    ]
    const result = listProviderUnusedUsageCodes(codes, 'p1', 'videos')
    expect(result).toEqual([{ id: 'v1', name: '视频甲', remaining: 5 }])
  })

  it('备注名为空时回退到 code', () => {
    const codes = [
      makeCode({
        id: 'x',
        name: '   ',
        code: 'ABC123',
        allowedProviderProfileIds: null,
        providerRemainingImageCredits: { p1: 2 },
      }),
    ]
    const result = listProviderUnusedUsageCodes(codes, 'p1', 'images')
    expect(result[0]?.name).toBe('ABC123')
  })

  it('allowedProviderProfileIds 为空数组时不纳入任何端点', () => {
    const codes = [
      makeCode({
        id: 'x',
        name: '禁用全部',
        allowedProviderProfileIds: [],
        providerRemainingImageCredits: { p1: 9 },
      }),
    ]
    expect(listProviderUnusedUsageCodes(codes, 'p1', 'images')).toEqual([])
  })
})

describe('formatProviderUnusedRemaining', () => {
  it('null 显示不限，数字原样显示', () => {
    expect(formatProviderUnusedRemaining(null)).toBe('不限')
    expect(formatProviderUnusedRemaining(12)).toBe('12')
  })
})
```

注意：TypeScript 中 `Record<string, number>` 不能直接写 `null`。实现时明细源类型应允许：

```ts
providerRemainingImageCredits?: Record<string, number | null> | null
providerRemainingVideoCredits?: Record<string, number | null> | null
```

若真实 `BackendUsageCode` 的 remaining 字段在「不限」时是「键不存在」而不是 `null`，则规则改为：

- 已授权 + 该端点 quota 存在且 remaining 为 `null` → 不限  
- 或已授权 + 该端点在 quotas 中为不限  

实现前对照 `getUsageCodeProviderStats`：

```ts
const availableCount = isVideoProfile
  ? code.providerRemainingVideoCredits?.[profile.id] ?? null
  : code.providerRemainingImageCredits?.[profile.id] ?? null
```

以及 `formatQuotaValue`：`value == null -> '不限'`。

因此「不限」判定应为：

1. 使用码已授权该端点
2. 且 `remaining == null`（字段缺失或显式 null 都视为不限）

但要注意：未配置该端点额度时，`?.[id]` 也可能是 `undefined`。  
对照现有合计逻辑：

```ts
return sum + Math.max(0, remaining ?? 0)
```

现有「未用 N」把 `null/undefined` 都当 0 累加，**不会把不限算进合计**。

**与规格的冲突处理（实现时采用）：**

为与当前「未用 N」数字一致，明细规则调整为更精确版本：

- 若 `providerXxxQuotas?.[profileId] == null` 且 remaining 也为空：视为**未单独配置/不限或未计入**  
- 与 UI 中 `formatQuotaValue(availableCount)` 一致：`availableCount == null` 显示「不限」

为避免把「完全没配该端点」的码全列出来，采用：

**纳入条件（最终实现口径）：**

1. 授权该端点
2. 读取 remaining：
   - videos → `providerRemainingVideoCredits?.[profileId]`
   - 其他 → `providerRemainingImageCredits?.[profileId]`
3. 若 remaining 为 `number` 且 `> 0`：纳入
4. 若 remaining 为 `null` 或 `undefined`：
   - 仅当该端点在对应 quotas 中显式存在且值为 `null`（不限）时纳入  
   - 否则不纳入

若实际后端对不限是 `quota=null` 且 remaining 键缺失，用：

```ts
const hasUnlimitedQuota = isVideo
  ? Object.prototype.hasOwnProperty.call(code.providerVideoQuotas ?? {}, profileId)
    && code.providerVideoQuotas?.[profileId] == null
  : Object.prototype.hasOwnProperty.call(code.providerImageQuotas ?? {}, profileId)
    && code.providerImageQuotas?.[profileId] == null
```

实现时先读一条真实 usage code 样例或 `getUsageCodeProviderStats` 用法，保证与设置页「可用」文案一致。

**更稳妥的实现口径（推荐写入代码）：**

```ts
function getRemaining(code, profileId, apiMode): number | null | undefined {
  return apiMode === 'videos'
    ? code.providerRemainingVideoCredits?.[profileId]
    : code.providerRemainingImageCredits?.[profileId]
}

// 纳入：
// - typeof remaining === 'number' && remaining > 0
// - remaining == null && isAllowed && isExplicitUnlimited(code, profileId, apiMode)
```

单测同时覆盖：

- 数字剩余 > 0
- 显式不限
- 剩余 0 排除
- 未授权排除

若当前环境几乎没有「不限」数据，也必须实现「不限排最前」分支。

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/lib/providerUnusedUsageCodes.test.ts --reporter=dot
```

预期：FAIL（模块不存在）

- [ ] **步骤 3：编写最少实现代码**

创建 `src/lib/providerUnusedUsageCodes.ts`：

```ts
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
```

并同步修正测试中的「不限」样例，改为带：

```ts
providerImageQuotas: { p1: null }
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/lib/providerUnusedUsageCodes.test.ts --reporter=dot
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/lib/providerUnusedUsageCodes.ts src/lib/providerUnusedUsageCodes.test.ts
git commit -m "feat: 端点未使用使用码明细纯函数"
```

---

### 任务 2：SettingsModal 接入触发与面板

**文件：**
- 修改：`src/components/SettingsModal.tsx`

- [ ] **步骤 1：增加状态与导入**

在 `SettingsModal.tsx` 顶部导入：

```ts
import { createPortal } from 'react-dom'
import {
  formatProviderUnusedRemaining,
  listProviderUnusedUsageCodes,
} from '../lib/providerUnusedUsageCodes'
```

在组件 state 区域新增：

```ts
const [unusedDetailProfileId, setUnusedDetailProfileId] = useState<string | null>(null)
const unusedDetailTriggerRef = useRef<HTMLButtonElement | null>(null)
const unusedDetailPanelRef = useRef<HTMLDivElement | null>(null)
const [unusedDetailPosition, setUnusedDetailPosition] = useState({ left: 0, top: 0, width: 320 })
const [isMobileUnusedDetail, setIsMobileUnusedDetail] = useState(false)
```

- [ ] **步骤 2：实现打开/关闭与定位逻辑**

```ts
const unusedDetailProfile = unusedDetailProfileId
  ? profiles.find((item) => item.id === unusedDetailProfileId) ?? null
  : null

const unusedDetailItems = useMemo(() => {
  if (!unusedDetailProfile) return []
  return listProviderUnusedUsageCodes(usageCodes, unusedDetailProfile.id, unusedDetailProfile.apiMode)
}, [unusedDetailProfile, usageCodes])

const unusedDetailTotal = unusedDetailProfile
  ? getProviderDistributedRemaining(unusedDetailProfile.id, unusedDetailProfile.apiMode)
  : 0

const updateUnusedDetailPosition = () => {
  const rect = unusedDetailTriggerRef.current?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(360, Math.max(280, window.innerWidth - 16))
  const left = Math.min(
    Math.max(8, rect.right - width),
    Math.max(8, window.innerWidth - width - 8),
  )
  const estimatedHeight = 360
  const top = rect.bottom + 8 + estimatedHeight > window.innerHeight
    ? Math.max(8, rect.top - 8 - estimatedHeight)
    : rect.bottom + 8
  setUnusedDetailPosition({ left, top, width })
}

const openUnusedDetail = (profileId: string, trigger: HTMLButtonElement) => {
  unusedDetailTriggerRef.current = trigger
  setIsMobileUnusedDetail(window.matchMedia('(max-width: 639px)').matches)
  setUnusedDetailProfileId((current) => (current === profileId ? null : profileId))
  requestAnimationFrame(() => updateUnusedDetailPosition())
}

const closeUnusedDetail = () => {
  setUnusedDetailProfileId(null)
  unusedDetailTriggerRef.current = null
}
```

`useEffect`：

1. `unusedDetailProfileId` 变化时监听 `pointerdown`（外部关闭）、`resize`/`scroll`（更新定位）、`keydown Escape`
2. 移动端判断可用 `window.matchMedia('(max-width: 639px)')`

```ts
useEffect(() => {
  if (!unusedDetailProfileId) return

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node
    if (unusedDetailTriggerRef.current?.contains(target)) return
    if (unusedDetailPanelRef.current?.contains(target)) return
    closeUnusedDetail()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeUnusedDetail()
  }
  const onReposition = () => {
    if (window.matchMedia('(max-width: 639px)').matches) {
      setIsMobileUnusedDetail(true)
      return
    }
    setIsMobileUnusedDetail(false)
    updateUnusedDetailPosition()
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onReposition)
  window.addEventListener('scroll', onReposition, true)
  onReposition()

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', onReposition)
    window.removeEventListener('scroll', onReposition, true)
  }
}, [unusedDetailProfileId])
```

- [ ] **步骤 3：改造 `renderProviderOptionLabel` 的「未用 N」为按钮**

把：

```tsx
{distributedRemaining != null && (
  <span className="shrink-0 text-[11px] text-gray-500 dark:text-gray-400">
    未用 {distributedRemaining}
  </span>
)}
```

改为：

```tsx
{distributedRemaining != null && (
  <button
    type="button"
    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
    onClick={(event) => {
      event.preventDefault()
      event.stopPropagation()
      openUnusedDetail(profile.id, event.currentTarget)
    }}
    onPointerDown={(event) => {
      // 防止下拉选项抢先选中/关闭
      event.stopPropagation()
    }}
  >
    未用 {distributedRemaining}
  </button>
)}
```

确认所有 `renderProviderOptionLabel(..., { showDistributedRemaining: true })` 的调用点都能点。

- [ ] **步骤 4：渲染明细层**

在 `SettingsModal` 根返回中（与其它 modal 同级）增加：

```tsx
{unusedDetailProfile && createPortal(
  isMobileUnusedDetail ? (
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="关闭未使用明细"
        onClick={closeUnusedDetail}
      />
      <div
        ref={unusedDetailPanelRef}
        className="relative z-10 flex max-h-[70vh] w-full flex-col rounded-t-3xl border border-white/50 bg-white p-4 shadow-2xl dark:border-white/[0.08] dark:bg-[#1b1c1e]"
      >
        {/* 标题 + 列表，复用下方内容块 */}
      </div>
    </div>
  ) : (
    <div
      ref={unusedDetailPanelRef}
      className="dropdown-glass-surface fixed z-[120] hidden max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-gray-200/70 shadow-xl ring-1 ring-black/5 sm:flex dark:border-white/[0.08] dark:ring-white/10"
      style={{
        left: unusedDetailPosition.left,
        top: unusedDetailPosition.top,
        width: unusedDetailPosition.width,
      }}
    >
      {/* 标题 + 列表 */}
    </div>
  ),
  document.body,
)}
```

内容块：

```tsx
<div className="border-b border-gray-100 px-4 py-3 dark:border-white/[0.08]">
  <div className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
    {getAdminProviderName(unusedDetailProfile)}
  </div>
  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
    未使用合计 {unusedDetailTotal}
  </div>
</div>

<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
  {unusedDetailItems.length === 0 ? (
    <div className="px-2 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
      该端点暂无剩余额度的使用码
    </div>
  ) : (
    <ul className="space-y-1">
      {unusedDetailItems.map((item) => (
        <li
          key={item.id}
          className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 text-sm"
        >
          <span className="min-w-0 truncate text-gray-700 dark:text-gray-200" title={item.name}>
            {item.name}
          </span>
          <span className="shrink-0 font-medium tabular-nums text-gray-900 dark:text-gray-100">
            {formatProviderUnusedRemaining(item.remaining)}
          </span>
        </li>
      ))}
    </ul>
  )}
</div>

{unusedDetailItems.length > 0 && (
  <div className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:text-gray-400">
    共 {unusedDetailItems.length} 个使用码
  </div>
)}
```

为减少重复，可将标题/列表抽成组件内局部函数 `renderUnusedDetailBody()`。

- [ ] **步骤 5：手动验收清单**

1. 管理员打开设置 → API 配置  
2. 点击某端点「未用 N」  
3. 不切换当前选中端点  
4. 明细按不限优先、剩余降序  
5. 显示备注名  
6. 合计与「未用 N」一致（数字剩余合计；不限不计入数字）  
7. PC popover / 窄屏 bottom sheet  
8. Esc、点外部可关闭  
9. 无数据时显示空态  

- [ ] **步骤 6：Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat: API 端点未使用使用码明细弹层"
```

---

### 任务 3：回归与收尾

- [ ] **步骤 1：跑相关测试**

```bash
npx vitest run src/lib/providerUnusedUsageCodes.test.ts --reporter=dot
```

预期：PASS

- [ ] **步骤 2：如本地有前端类型检查习惯则执行**

```bash
npx tsc -b --pretty false
```

预期：无新增错误

- [ ] **步骤 3：如需部署到 41**

仅在用户明确要求时执行：

1. 上传改动文件  
2. 远端 `docker compose -p gpt_image_playground build app && up -d --force-recreate`  
3. 确认 `.dockerignore` 含 `docker-data`  
4. 健康检查 `/health`

---

## 自检

1. **规格覆盖**
   - 点击未用 N 打开明细 → 任务 2
   - 备注名 + 剩余 + 排序 → 任务 1/2
   - 不限排最前 → 任务 1
   - PC/移动形态 → 任务 2
   - 不切换端点 → 任务 2 stopPropagation
   - 空态 → 任务 2
   - 不改后端 → 全任务遵守

2. **占位符**
   - 无 TODO/待定

3. **类型一致性**
   - `ProviderUnusedUsageCodeItem.remaining: number | null`
   - `formatProviderUnusedRemaining(remaining: number | null)`

4. **与现有「未用 N」一致性说明**
   - 合计仍用 `getProviderDistributedRemaining`（只加数字剩余）
   - 明细可额外展示显式不限项，但不计入合计数字
