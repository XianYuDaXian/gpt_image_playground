# 后端化重构方案

## 目标

本次重构的目标不是给前端“加一个代理”，而是把当前浏览器本地任务模型改成**服务端任务中心**：

1. 前端不再直接持有或发送上游图像请求。
2. 前端提交后即可离开页面，任务完成或失败后仍可回看。
3. 生成结果先落到后端本地磁盘，再由后端统一提供访问地址。
4. 统一实时进度由后端产生，前端只订阅状态。
5. 抛弃 `WebDAV`，不再依赖不可控远端目录作为主存储。

---

## 当前项目现状

当前仓库本质上是一个纯前端应用：

- 前端直接调用 OpenAI 图像接口
- API Key 存在浏览器设置中
- 任务记录保存在浏览器 `IndexedDB`
- 图片数据保存在浏览器 `IndexedDB`
- `WebDAV` 只负责把浏览器本地快照同步到远端目录

这套架构的问题很明确：

1. 任务生命周期绑定浏览器页面，无法形成服务端任务中心。
2. 图片下载与持久化发生在前端，无法统一控制结果文件。
3. 无法可靠支持“离开页面后稍后再看”。
4. `WebDAV` 只适合文件同步，不适合任务状态机、重试、实时事件与审计。
5. 前端直接持有上游凭据，安全边界过弱。

---

## 后端选型结论

### 推荐方案

选择 **Node.js + TypeScript + Fastify + SQLite + 本地磁盘存储 + SSE**。

### 结论理由

1. **语言连续性最好**
   当前项目已经是 `TypeScript + React`，继续使用 TypeScript 做后端，数据模型、校验类型、接口定义都能共享，改造成本最低。

2. **Fastify 比 NestJS 更适合这次重构**
   这次目标是快速把“任务中心 + 文件落盘 + 实时进度”跑起来，不需要先引入重型框架。Fastify 结构清晰、性能足够、插件生态成熟，比较适合当前仓库规模。

3. **SQLite 足够覆盖第一阶段**
   当前诉求是单机可部署、任务可恢复、状态可追踪、图片本地落盘。SQLite 足够胜任，而且部署比 PostgreSQL 简单很多。后续如果要多实例横向扩容，再迁移 PostgreSQL。

4. **SSE 比 WebSocket 更合适**
   实时进度主要是服务端单向推送给前端，不需要复杂双向协议。SSE 更容易接入、断线自动重连更简单、反向代理兼容性更好。

5. **本地磁盘比 WebDAV 可控**
   输出文件、缩略图、上传原图统一保存在后端挂载目录，文件生命周期、命名规范、清理策略、备份策略都可控。

---

## 为什么不选其它方案

### 不选 NestJS

- 优点是工程化强、模块边界清晰。
- 缺点是初始样板和概念层较重。
- 对当前仓库来说，会明显拉高第一阶段改造成本。

结论：以后如果项目变成多人长期维护的中大型服务，可以再考虑；当前不是最优。

### 不选 Python FastAPI

- 优点是异步接口、文件处理、AI 集成也很合适。
- 缺点是前后端语言分裂，现有类型体系无法直接复用。
- 还会额外引入 Python 运行时、打包和部署链路。

结论：技术上可行，但不适合这个仓库当前的连续演进。

### 不选 PostgreSQL 作为第一阶段主库

- 优点是扩展性更强。
- 缺点是部署复杂度更高。
- 当前需求更像“单机任务工作站”，不是高并发多实例 SaaS。

结论：作为二阶段升级目标保留，不作为首发版本必需条件。

### 不选 Redis / BullMQ 作为第一阶段必需队列

- 优点是成熟任务队列能力强。
- 缺点是引入额外基础设施。
- 当前完全可以先做“数据库持久化任务 + 单进程 worker 恢复机制”。

结论：先不上；等需要多 worker 并发、重试策略更复杂时再升级。

---

## 目标架构

```text
React 前端
  -> POST /api/tasks
  -> GET  /api/tasks
  -> GET  /api/tasks/:id
  -> GET  /api/tasks/:id/events   (SSE)
  -> GET  /media/...              (后端静态文件)

Fastify 后端
  -> SQLite: tasks / task_events / task_images
  -> data/uploads   保存输入图
  -> data/masks     保存遮罩
  -> data/outputs   保存输出图
  -> data/thumbs    保存缩略图
  -> worker         调用 OpenAI / 代理上游
```

---

## 核心设计

## 1. 任务状态机

任务状态不能再只有 `running / done / error` 三态，建议扩展为：

- `queued`
- `uploading`
- `submitted`
- `processing`
- `downloading`
- `succeeded`
- `failed`
- `canceled`

前端展示时可以做映射：

- 运行中：`queued | uploading | submitted | processing | downloading`
- 完成：`succeeded`
- 失败：`failed`
- 已取消：`canceled`

这样统一实时进度才有意义，否则“运行中”过于粗糙。

## 2. 实时进度模型

后端统一产出以下结构：

```ts
interface TaskProgressEvent {
  taskId: string
  status: string
  step: string
  percent: number
  message?: string
  createdAt: string
}
```

建议进度阶段：

1. `queued` 5%
2. `uploading` 15%
3. `submitted` 35%
4. `processing` 60%
5. `downloading` 85%
6. `succeeded` 100%

失败时统一发送：

- `status = failed`
- `percent = 当前阶段值`
- `message = 错误摘要`

说明：

- 如果上游本身没有精细进度，我们也至少要提供**阶段性进度**，保证用户知道任务推进到了哪一步。
- 不追求伪精确百分比，追求一致、可理解、可恢复。

## 3. 文件落盘策略

所有输入输出都先写入后端本地目录：

- `data/uploads/{taskId}/input-1.png`
- `data/masks/{taskId}/mask.png`
- `data/outputs/{taskId}/output-1.png`
- `data/thumbs/{taskId}/output-1.webp`

数据库只保存：

- 逻辑 ID
- 相对路径
- MIME 类型
- 宽高
- 字节大小
- SHA-256

前端只消费后端给出的媒体 URL，例如：

- `/media/outputs/{taskId}/output-1.png`

## 4. 任务持久化

至少需要三张表：

### `tasks`

- `id`
- `prompt`
- `status`
- `progress_percent`
- `current_step`
- `params_json`
- `error_message`
- `created_at`
- `updated_at`
- `finished_at`

### `task_images`

- `id`
- `task_id`
- `kind` (`input | mask | output | thumb`)
- `file_path`
- `mime_type`
- `width`
- `height`
- `bytes`
- `sha256`
- `created_at`

### `task_events`

- `id`
- `task_id`
- `status`
- `step`
- `percent`
- `message`
- `created_at`

这样可以实现：

1. 刷新页面后恢复任务详情
2. 查看失败原因
3. 回放任务进度
4. 后续做“任务审计”

## 5. 运行配置后移

这次不只是“任务后移”，运行配置也要一起后移。下面这些配置都应该以后端为准：

- `API URL`
- `API Key`
- `model`
- `apiMode`
- `timeout`
- 默认输出参数

推荐增加两类数据表。

### `provider_profiles`

用于保存上游服务配置：

- `id`
- `name`
- `base_url`
- `api_key_encrypted`
- `model`
- `api_mode`
- `timeout_seconds`
- `is_default`
- `created_at`
- `updated_at`

### `app_settings`

用于保存全局运行设置：

- `key`
- `value_json`
- `updated_at`

这样后端可以支持：

1. 多套节点配置切换
2. 默认 provider profile
3. 后台统一改 Key，不需要改前端
4. 后续增加管理员设置页

### API Key 保存策略

推荐优先级：

1. 后端数据库保存加密后的 `api_key_encrypted`，加密主密钥来自服务端环境变量
2. 如果首版想更简单，也可以只允许通过环境变量注入单一默认 Key

如果你希望保留“网页里可以改 API URL / API Key”的体验，就应该采用第一种。
如果你希望部署最简单，可以先用第二种，再在后续迭代补上管理设置页。

当前这个项目更适合折中方案：

- 支持环境变量默认配置
- 支持后端管理页修改并写入数据库
- 普通任务页不再显示敏感凭据输入框

## 5. Worker 模型

第一阶段不引入独立队列中间件，采用：

- API 服务进程
- 内部 worker 调度器
- 数据库持久化任务

启动恢复逻辑：

1. 服务启动时扫描 `queued / submitted / processing / downloading`
2. 将这些任务标记为 `queued`
3. 重新进入本地 worker 调度

这能保证服务重启后任务不会直接丢失。

---

## 前端改造原则

前端保留现有界面主体，但角色发生变化：

1. **设置项调整**
   不再让前端直接配置上游 `API URL / API Key`。
   普通前端只配置后端地址，或者默认同源。
   如果需要可视化管理上游配置，应增加单独的后端管理设置页。

2. **提交逻辑改造**
   当前 `submitTask -> callImageApi -> storeImage` 的链路要改成：

   - 前端上传表单到后端
   - 后端创建任务
   - 前端立即拿到 `taskId`
   - 前端开始订阅该任务事件

3. **任务列表来源改造**
   当前列表来自 `IndexedDB`，后续改成：

   - 页面初始化调用 `GET /api/tasks`
   - 详情页调用 `GET /api/tasks/:id`
   - 实时状态通过 SSE 更新本地 UI store

4. **图片来源改造**
   当前卡片缩略图与详情图来自浏览器本地缓存，后续改为后端返回的 URL。

5. **本地存储降级**
   浏览器只保留少量 UI 偏好设置，例如：

   - 主题
   - 面板开关
   - 最近使用参数草稿

   不再把任务历史作为主数据源。

---

## WebDAV 退场方案

`WebDAV` 应该从“主数据同步方案”降级为“完全移除”。

建议：

1. 删除 `storageMode = webdav`
2. 删除自动同步、冲突合并、远端快照逻辑
3. 保留“导出 ZIP / 导入 ZIP”作为手工备份能力
4. 服务端数据备份改由：
   - SQLite 文件备份
   - `data/` 目录备份
   - Docker Volume 备份

这会让数据模型回到可控状态。

---

## 分阶段实施计划

## 第一阶段：后端骨架

目标：

- 引入 `server/`
- 跑通 Fastify
- 建立 SQLite
- 提供任务增删查接口
- 提供媒体静态目录

验收标准：

- 可以创建空任务
- 可以查询任务列表
- 可以访问本地媒体目录

## 第二阶段：服务端提交任务

目标：

- 前端改为调用 `/api/tasks`
- 输入图和遮罩图上传到后端
- 后端保存任务与输入文件
- 前端不再直接请求 OpenAI

验收标准：

- 浏览器中不再出现上游 API 请求
- 浏览器中不再保存 API Key

## 第三阶段：Worker 与结果落盘

目标：

- 后端 worker 调用上游图像接口
- 输出图下载到本地
- 生成缩略图
- 更新任务最终状态

验收标准：

- 输出图来自 `/media/...`
- 任务完成后刷新页面仍可查看

## 第四阶段：统一实时进度

目标：

- 增加 SSE 事件流
- 前端卡片和详情页订阅任务状态
- 失败原因与阶段信息可见

验收标准：

- 提交后可实时看到阶段变化
- 页面刷新后重新进入仍可查看历史事件

## 第五阶段：移除 WebDAV

目标：

- 删除 `webdav` 设置与同步代码
- 移除相关 UI
- 清理浏览器端历史快照依赖

验收标准：

- 项目中不再存在 WebDAV 主链路

## 第六阶段：后端设置中心

目标：

- `API URL / API Key / model / timeout` 存后端
- 前端不再缓存敏感运行配置
- 支持默认 provider profile

验收标准：

- 换浏览器访问时任务页配置保持一致
- 浏览器本地存储中不再出现敏感凭据
- 上游配置变更后，新任务直接走后端最新配置

---

## 数据与部署建议

推荐目录：

```text
server/
web/
data/
  app.db
  uploads/
  masks/
  outputs/
  thumbs/
```

推荐部署方式：

1. 单机 Docker Compose
2. 挂载 `data/` 为持久卷
3. 前端静态资源与后端 API 同源部署

这样最符合当前项目规模，也最容易替代掉原来的静态站点 + WebDAV 模式。

---

## 本轮执行建议

本轮重构建议先做下面三件事：

1. 建立 `server/` 后端骨架与基础数据模型
2. 前端抽离“任务服务接口层”，不要再直接依赖 `callImageApi`
3. 先保留现有 UI，优先替换数据来源和任务链路

结论很明确：

**这次后端应该选 `TypeScript + Fastify + SQLite + 本地磁盘 + SSE`。**

这是当前仓库最稳、最省迁移成本、最容易尽快落地的方案。
