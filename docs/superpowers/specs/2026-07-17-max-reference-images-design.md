# 端点参考图上限设计规格

日期：2026-07-17  
状态：已确认  
范围：Venice / WaveSpeed / Kie 多图参考图上限可配置；Images / Responses / Video 参考图上限可配置

## 1. 背景

当前行为：

- Venice / WaveSpeed / Kie 的多图参考上限写死为 3 张。
- 前端 `getVeniceImageLimit`、后端 `taskDto` / `kieApi` / `wavespeedApi` 都按 3 校验。
- Images / Responses / Video 前端统一使用 `API_MAX_IMAGES = 16`。
- 管理员无法按端点调整允许张数。

目标：

- 每个 API 端点可单独配置参考图上限。
- 管理员可用加减按钮或手动输入允许张数。
- 前后端使用同一配置值做限制。

## 2. 决策摘要

采用方案 A：

- 每个端点增加一个整数字段 `maxReferenceImages`。
- 特殊端点默认 3。
- Images / Responses / Video 默认 16。
- 取值范围 1–16。
- 特殊端点仍保留文生图 / 单图 / 多图开关；开关可把实际上限压低到 1 或 0。

## 3. 数据模型

### 3.1 字段

端点配置新增：

```ts
maxReferenceImages: number
```

存储建议：

- 数据库列：`max_reference_images INTEGER NOT NULL DEFAULT ...`
- TypeScript / API 字段：`maxReferenceImages`

### 3.2 默认值

| apiMode | 默认上限 |
|---|---|
| `venice_images` | 3 |
| `wavespeed` | 3 |
| `kie` | 3 |
| `images` | 16 |
| `responses` | 16 |
| `videos` | 16 |

### 3.3 规范化

统一规范化规则：

1. 空值、`NaN`、非整数、缺省：回退到该 `apiMode` 默认值。
2. 小于 1：变为 1。
3. 大于 16：变为 16。
4. 浮点数：向下取整后再钳制。

```text
normalizeMaxReferenceImages(apiMode, value) =
  clamp(toIntOrDefault(value, defaultByApiMode(apiMode)), 1, 16)
```

### 3.4 兼容

- 旧端点无该字段时，读取时按默认值补齐。
- 不改历史任务结构。
- 备份导出 / 导入需携带 `maxReferenceImages`。
- 复制端点时复制该字段。

## 4. 实际上限计算

### 4.1 配置上限

```text
configuredLimit = normalizeMaxReferenceImages(provider.apiMode, provider.maxReferenceImages)
```

### 4.2 特殊端点开关叠加

仅 `venice_images` / `wavespeed` / `kie` 生效：

```text
if generate/edit/multi-edit 都按现有字段判断:
  if 单图关闭 且 多图关闭:
    effectiveLimit = 0
  else if 多图关闭:
    effectiveLimit = 1
  else:
    effectiveLimit = configuredLimit
```

说明：

- 文生图开关不直接改上传上限，只影响 0 张图时是否允许提交。
- 多图关闭时，即使 `maxReferenceImages > 1`，也只能上传 1 张。
- 多图开启时，使用管理员配置的 `maxReferenceImages`。

### 4.3 普通端点

`images` / `responses` / `videos`：

```text
effectiveLimit = configuredLimit
```

## 5. 管理员 UI

### 5.1 位置

API 端点编辑页：

- 放在“超时时间”下方
- 放在“上游代理”上方
- 所有 `apiMode` 都显示

### 5.2 控件

标题：`参考图上限`

说明：

- 特殊端点：`多图编辑开启时生效。关闭多图后最多 1 张；单图和多图都关闭时不能上传参考图。`
- Images / Responses / Video：`限制用户可上传的参考图张数。`

形态：

```text
[ − ]  [ 数字输入 ]  [ + ]
```

交互：

1. 点 `−`：减 1，不低于 1。
2. 点 `+`：加 1，不高于 16。
3. 中间可手动输入。
4. 输入过程允许暂时为空或中间态。
5. 失焦时规范化到 1–16。
6. 非数字回退当前模式默认值。

### 5.3 默认与模式切换

- 新建特殊端点：默认 3。
- 新建 Images / Responses / Video：默认 16。
- 切换 `apiMode`：
  - 当前值合法则保留。
  - 当前值空或非法时，按新模式默认值填充。

### 5.4 文案同步

特殊端点相关写死“2 到 3 张”的文案，统一改为使用 `N = maxReferenceImages`：

- 多图编辑卡片：`上传 2 到 N 张参考图时使用。`
- 模式说明：`无图走文生图，1 张图走单图编辑，2 到 N 张图走多图编辑。`
- 超限提示：`当前 {端点名} 最多支持 N 张参考图`

## 6. 前端生效

### 6.1 来源

`BackendProviderProfile` / `BackendProviderOption` 增加 `maxReferenceImages`。

`InputBar` 不再写死：

- 特殊端点 3
- 普通端点 16

改为：

```text
effectiveLimit = resolveEffectiveMaxReferenceImages(activeProviderOption)
```

### 6.2 限制点

以下路径都使用 `effectiveLimit`：

1. 文件选择上传
2. 拖拽上传
3. 粘贴图片
4. 参考图编辑器另存为新增
5. 添加按钮禁用态
6. `@` 图片相关数量展示如有上限提示，保持一致

### 6.3 交互行为

- `currentCount >= effectiveLimit`：禁止继续添加。
- 批量添加只接受 `remaining = effectiveLimit - currentCount` 张。
- 超出部分丢弃，并 toast：
  - `参考图数量已达上限（N 张），无法继续添加`
- 特殊端点能力错误优先：
  - 多图关闭时添加第 2 张：提示已禁用多图编辑
  - 数量超限：提示最多支持 N 张

## 7. 后端生效

### 7.1 校验点

1. 创建任务时校验参考图数量。
2. Venice / WaveSpeed / Kie 执行前校验。
3. Images / Responses / Video 执行前校验。
4. `getMultiModelImageCapabilityError` 一类函数改为读取配置上限。

### 7.2 错误语义

- 数量超限：
  - `当前 {端点名} 最多支持 N 张参考图`
- 特殊端点能力：
  - 0 张且文生图关闭：禁用文生图
  - 1 张且单图关闭：禁用单图编辑
  - 2..N 张且多图关闭：禁用多图编辑
  - `> N` 张：数量超限

### 7.3 模型分发

特殊端点模型分发保持：

- 0 张：文生图模型
- 1 张：单图编辑模型
- `>= 2` 张：多图编辑模型

原先写死的 `<= 3` 改为 `<= N`。

### 7.4 Video

- Video 端点读取自己的 `maxReferenceImages`。
- 多图视频仍走 `reference_images`。
- 超过上限时，在任务创建 / 执行前拒绝。

## 8. 数据流

```text
管理员设置 maxReferenceImages
  → provider_profiles 持久化
  → settings / provider options 下发前端
  → InputBar 计算 effectiveLimit
  → 上传与提交前前端拦截
  → 后端再次按同一规则校验
  → 执行对应 Images / Responses / Video / Venice / WaveSpeed / Kie 路径
```

## 9. 实现边界

纳入：

- 数据库字段与读写
- 设置页 UI
- 前后端类型与 DTO
- 上传限制
- 创建任务 / 执行任务校验
- 特殊端点文案去硬编码

不纳入：

- 按用户身份设置不同上限
- 输出图数量上限改造
- 参考图体积 / 分辨率压缩策略改造
- 第三方上游真实最大张数自动探测

## 10. 测试要点

1. 特殊端点默认 3；改为 5 后可上传并提交 5 张。
2. 特殊端点关闭多图后，最多 1 张。
3. 特殊端点关闭单图与多图后，不能上传参考图。
4. Images / Responses / Video 默认 16；改为 2 后第 3 张被拒。
5. 前端批量上传只保留剩余额度。
6. 后端绕过前端时仍拒绝超限。
7. 旧端点无字段时按默认值生效。
8. 管理员加减与手动输入失焦钳制正确。
9. 切换 apiMode 时默认值与保留策略正确。
10. 备份导入导出后该字段不丢失。

## 11. 主要改动面

### 后端

- `server/src/lib/db.ts`
- `server/src/routes/settings.ts`
- `server/src/lib/taskDto.ts`
- `server/src/lib/imageApi.ts`
- `server/src/lib/kieApi.ts`
- `server/src/lib/wavespeedApi.ts`
- `server/src/lib/videoApi.ts` 或任务创建入口

### 前端

- `src/types.ts`
- `src/lib/backendSettings.ts`
- `src/components/SettingsModal.tsx`
- `src/components/InputBar.tsx`
- 其他读取 provider option 并限制参考图数量的位置

### 建议新增纯函数

- `defaultMaxReferenceImages(apiMode)`
- `normalizeMaxReferenceImages(apiMode, value)`
- `resolveEffectiveMaxReferenceImages(provider)`

便于前后端共享同一规则，并用单元测试覆盖。

## 12. 完成标准

1. 管理员可在每个端点设置参考图上限。
2. 特殊端点与普通端点均按配置限制上传与提交。
3. 默认值与现网行为一致：特殊端点 3，普通端点 16。
4. 开关逻辑不回退：多图关仍最多 1 张。
5. 前后端提示文案使用实际 N，不再写死 3。
