# 任务列表翻页稳定性与速度优化设计规格

日期：2026-07-17  
状态：已确认  
范围：PC / 移动端任务列表页码翻页稳定性、筛选后跳页竞态修复、在不改变每页数量的前提下减少无效刷新与渲染抖动

## 1. 背景

当前任务列表支持：

- 页码翻页
- 跳转输入
- 状态 / 类型 / 收藏 / 归档 / 标签筛选
- 服务端分页拉取

用户反馈：

1. PC / 移动端翻页偏慢。
2. 筛选后若结果有多页，跳转到中间页时，页码可能在 `1` 与目标页之间反复跳动。

### 现状链路

1. `TaskGrid` 维护 `taskPage` / `taskPageSize` / `taskTotal`。
2. 页码、筛选变化时调用 `refreshTasksFromServer({ silent: true })`。
3. `refreshTasksFromServer` 通过 `fetchBackendTaskPage` 请求当前页。
4. 请求返回后：
   - `setTaskPaginationMeta({ page, pageSize, total })`
   - `setTasks(items)`
5. SSE 任务事件、窗口 focus / online / visibility 恢复也会触发整页刷新。
6. 筛选变化时，`TaskGrid` 会 `setTaskPage(1)`；若 `taskPage > totalPages`，还会 clamp 到最后一页。

### 问题根因

1. **请求竞态**
   - 没有请求世代号。
   - 后发出的请求不一定后返回。
   - 旧请求返回时会覆盖 `taskPage` / `tasks` / `taskTotal`。
2. **页码回写不当**
   - 服务端响应中的 `page` 会回写前端 `taskPage`。
   - 旧页响应会把用户刚选中的页码改回去。
3. **clamp 时机过早**
   - 可能用旧筛选条件下的 `totalPages` 去约束新跳转页码。
4. **刷新过密**
   - 翻页、筛选、SSE、窗口恢复都可能整页重拉。
   - 导致卡顿、闪烁、重复渲染。

## 2. 决策摘要

采用方案 A：

- 保持页码翻页交互。
- 保持现有每页数量策略。
- 增加请求世代号 / 最新请求胜出。
- 禁止用服务端响应回写用户当前页码。
- 优化刷新调度与渲染替换时机，降低无效请求和闪烁。

本轮不做：

- 无限滚动
- 虚拟列表
- 用户自定义每页条数
- 搜索全量 SQL 化重构

## 3. 目标与非目标

### 目标

1. 筛选后跳到第 4 页时，页码稳定停在 4，不再 `1 ↔ 4` 来回跳。
2. 连续快速翻页时，只稳定落到最终页。
3. 翻页主观更顺，减少空白闪烁和重复请求。
4. 保留现有页码控件与每页容量逻辑。

### 非目标

1. 不改卡片视觉样式。
2. 不改筛选条件集合。
3. 不改后端分页协议字段名。
4. 不引入无限滚动或虚拟列表。

## 4. 请求与状态机

### 4.1 新增请求状态

列表刷新层维护：

```ts
type TaskListRequestKey = {
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

type TaskListRequestState = {
  seq: number
  inFlightSeq: number | null
  lastAppliedSeq: number
  loading: boolean
  lastSuccessAt: number | null
}
```

### 4.2 发起请求

每次 `refreshTasksFromServer`：

1. 读取当前 store 中的筛选与页码，生成 `requestKey`
2. `seq += 1`
3. `inFlightSeq = seq`
4. `loading = true`
5. 携带：
   - `seq`
   - `requestKey`
   - 请求开始时的参数快照

### 4.3 返回处理

请求返回后：

1. 若 `seq < lastAppliedSeq`：丢弃
2. 若 `seq !== inFlightSeq`：丢弃
3. 若返回时当前 store 的 `requestKey` 已与请求快照不一致：丢弃
4. 否则应用：
   - `tasks = result.items`
   - `taskTotal = result.total`
   - `taskPageSize` 仅在本地策略变更时更新，不依赖响应覆盖用户意图
   - **不使用 `result.page` 回写 `taskPage`**
5. `lastAppliedSeq = seq`
6. 若没有更新的飞行请求：
   - `inFlightSeq = null`
   - `loading = false`
7. 记录 `lastSuccessAt`

### 4.4 为什么不再回写 page

页码是用户意图，不是服务端权威状态。

服务端返回的 `page` 只用于确认“这次结果对应哪一页请求”，不能覆盖用户当前选择。  
否则旧请求一回来，就会把页码打回旧值。

### 4.5 并发策略

允许短时间存在多个飞行请求，但：

- 只应用最新合法结果
- 不要求必须 `AbortController` 硬取消
- 若实现成本低，可顺手对旧请求做 abort；这不是正确性前提

## 5. 筛选 / 跳页规则

### 5.1 用户操作

| 操作 | 页码行为 | 列表行为 |
|---|---|---|
| 上一页 / 下一页 | 改为目标页 | 拉目标页 |
| 下拉选页 | 改为目标页 | 拉目标页 |
| 输入跳转并确认 | 钳到 `1..knownTotalPages`，再跳转 | 拉目标页 |
| 改状态 / 类型 / 收藏 / 归档 / 使用码可见 | 重置到 1 | 拉第 1 页 |
| 增删搜索标签 / 切换包含排除 | 重置到 1 | 拉第 1 页 |
| 每页条数变化 | 尽量保持当前第一条位置，重算页码 | 按新 pageSize 拉取 |

### 5.2 clamp 规则

1. 跳转输入时：
   - 用“当前已知 totalPages”做即时钳制
2. 请求返回后：
   - 仅当这次返回属于当前筛选条件
   - 且当前 `taskPage > newTotalPages`
   - 才把页码钳到 `newTotalPages`
3. 禁止用旧筛选条件的 `totalPages` 去压新筛选 / 新跳转中的页码

### 5.3 跳转输入框

1. 输入中不发请求
2. 失焦或回车时提交
3. 提交后立即把输入框显示值规范成最终目标页
4. 不因旧请求返回而把输入框来回改写

### 5.4 筛选重置

筛选变化时顺序固定为：

1. 更新筛选状态
2. `taskPage = 1`
3. 发起 page=1 请求

若用户在筛选请求返回前又手动跳到第 4 页：

- 以更晚的 page=4 请求为准
- page=1 的旧请求结果丢弃

### 5.5 SSE 与生命周期刷新

以下事件只刷新“当前页 + 当前筛选”，不改页码：

- 全局任务列表 SSE
- 单任务 SSE 失败后的兜底刷新
- window focus
- pageshow
- online
- document visibility 恢复为 visible

附加约束：

1. SSE 批量事件合并防抖，默认 300–500ms
2. 生命周期恢复刷新若距离 `lastSuccessAt` 很近，可跳过
3. 运行中任务尽量局部 upsert；仅当可能影响当前页成员或排序时才整页刷新

## 6. 速度优化

### 6.1 网络层

1. 连续点页码时，只让最后一次结果生效
2. 参数完全相同时不重复请求
3. SSE 触发的整页刷新合并
4. focus / online / visibility 恢复避免紧挨着重复刷

### 6.2 渲染层

1. 翻页 loading 时默认保留当前网格，不先清空成空白
2. 新结果到达后再整体替换当前页任务
3. 列表继续以 `task.id` 为 key
4. 可见任务 ID、框选状态更新与列表请求解耦，减少连锁 setState

### 6.3 图片层

1. 保持现有 `deferImageLoading`
2. 新页优先加载首屏缩略图
3. 离开页面不主动清缓存
4. 避免因整页无效刷新反复触发图片重载

### 6.4 后端范围

本轮保持：

- 普通筛选：服务端 count + page
- 搜索标签：现有有限集合过滤路径

本轮不要求重写搜索索引或 SQL 全文方案。

## 7. UI 表现

1. 顶部 / 底部页码区继续显示：
   - `共 N 条，每页 M 条，第 X / Y 页`
2. `totalPages <= 1` 时隐藏页码控件
3. loading 时：
   - 页码控件仍可操作
   - 可用轻量状态表示刷新中
   - 不强制清空卡片
4. 无匹配结果时：
   - 显示“没有找到匹配的记录”
   - 不出现页码来回跳

## 8. 数据流

```text
用户改页码 / 改筛选
  → 更新本地 taskPage / filters
  → 生成 requestKey + seq
  → fetchBackendTaskPage
  → 仅最新合法请求写入 tasks / taskTotal
  → TaskGrid 按稳定页码渲染

SSE / focus / online
  → 防抖后刷新当前 requestKey
  → 不修改 taskPage
  → 仅最新合法请求写入
```

## 9. 主要改动面

### 前端

- `src/store.ts`
  - `refreshTasksFromServer`
  - `scheduleTaskRefresh`
  - SSE 列表刷新
  - 生命周期刷新
- `src/components/TaskGrid.tsx`
  - 筛选重置
  - 页码 clamp
  - 跳转输入
  - loading 呈现
- 可选：
  - `src/lib/backendTasks.ts` 若需透传 abort signal

### 后端

本轮原则上不改协议。  
若联调中发现 `page` 越界返回语义不清晰，可只做最小澄清，不扩展新接口。

## 10. 测试要点

1. 筛选后共 5 页，跳到第 4 页，稳定停在 4。
2. 连续快速点下一页，只落到最终页，不闪中间页。
3. 筛选切换时回到第 1 页，且不和旧页结果打架。
4. 跳转输入非法值时钳到合法范围。
5. 旧请求晚到时，不覆盖新页数据和页码。
6. SSE 连续事件不会把当前页打回第 1 页。
7. focus / 切回前台不会造成页码跳动。
8. 现有每页数量策略保持不变。
9. 无结果筛选时显示空态，不循环刷新。
10. 运行中任务局部更新时，当前页不无故整页闪白。

## 11. 完成标准

1. 用户描述的 `1 ↔ 4` 来回跳现象消失。
2. 翻页与筛选操作后的页码与数据一致。
3. 连续翻页时请求次数和重渲染次数下降。
4. PC / 移动端翻页主观更顺，空白闪烁减少。
5. 不改变现有页码交互和每页数量策略。

## 12. 实现顺序建议

1. 给 `refreshTasksFromServer` 加世代号与结果丢弃规则。
2. 停止用响应 `page` 回写 `taskPage`。
3. 修正筛选重置与 total clamp 时机。
4. 给 SSE / 生命周期刷新加防抖与去重。
5. 调整 TaskGrid loading 与跳转输入稳定性。
6. 补回归测试或最小化复现验证。
