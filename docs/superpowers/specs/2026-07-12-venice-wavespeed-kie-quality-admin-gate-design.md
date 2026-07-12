# Venice / WaveSpeed / Kie 质量与审核规则设计

日期：2026-07-12  
状态：已批准  
范围：仅 `venice_images`、`wavespeed`、`kie` 三个端点

## 背景

当前三个特殊端点对质量/审核处理不一致：

- Kie：`quality` 固定 `basic`，`nsfw_checker` 跟管理员开关
- WaveSpeed：分辨率只跟管理员「允许高分辨率」和尺寸推断，不读用户质量
- Venice：分辨率主要跟尺寸与「允许 2K」推断，不读用户质量

目标：

1. 忽略用户侧「审核」选项（不按 OpenAI 语义透传）
2. 恢复响应用户「质量」选项
3. 是否允许高质量/2K，由管理员端点开关决定

已确认方案：**A**

## 规则

### 质量映射（方案 A）

记：

- 管理员开关：`xaiImage2kEnabled`
- 用户质量：`params.quality`（`auto | low | medium | high`）

映射：

| 管理员开关 | 用户质量 | 结果 |
|---|---|---|
| 关 | 任意 | `1k` / `basic` |
| 开 | `high` | `2k` / `high` |
| 开 | `auto` / `low` / `medium` | `1k` / `basic` |

补充：

- 不再按尺寸自动升 2K/4K
- `medium` 不视为高质量
- 管理员关时，即使用户选 `high` 也锁死 1K/basic

### 审核规则

| 端点 | 用户「审核」参数 | 实际上传 |
|---|---|---|
| Venice | 忽略 | 不传用户审核字段 |
| WaveSpeed | 忽略 | 不传用户审核字段 |
| Kie | 忽略 | `input.nsfw_checker` 仅跟随管理员 `nsfwChecker`（开=`true`，关=`false`） |

## 各端点落地

### Kie

请求 `input`：

- `quality`:
  - 管理员关 → 固定 `basic`
  - 管理员开且用户 `high` → `high`
  - 其他 → `basic`
- `nsfw_checker`:
  - 始终发送
  - 值 = `provider.nsfwChecker !== 0`

说明：Kie 质量字段只使用 `basic` / `high`，不传 `auto/low/medium`。

### WaveSpeed

请求体：

- `resolution`:
  - 管理员关 → 固定 `1k`
  - 管理员开且用户 `high` → `2k`
  - 其他 → `1k`
- 不传用户 `moderation`
- 其他字段（比例、格式、同步、base64）保持现有逻辑

说明：本方案明确不升 `4k`。

### Venice

编辑类请求（有参考图）：

- `resolution`（若未开启「不传递分辨率」）：
  - 管理员关 → `1K`
  - 管理员开且用户 `high` → `2K`
  - 其他 → `1K`
- 不传用户 `moderation`

文生图：

- 若当前路径本身不带 `resolution`，保持现状
- 若后续统一补 resolution，遵循同一映射

「不传递分辨率」开关优先：开启时仍不附带 `resolution`。

## 前端表现

### 用户参数区（InputBar）

当当前端点为 Venice / WaveSpeed / Kie 时：

1. **质量**
   - 保持可选、可改
   - 继续写入 `params.quality`
   - 后端按上述映射生效

2. **审核**
   - 禁用或无感忽略
   - 不因用户选择改变三端点实际上传字段
   - 提示文案可用：`当前端点审核由管理员配置，用户侧审核不生效`

3. OpenAI `images` / `responses` 逻辑不变

### 管理员设置文案

对齐方案 A：

- WaveSpeed「允许高分辨率 (2K/4K)」改为更准确描述：  
  「开启后，用户选择 high 才提交 2k；关闭时固定 1k」
- Kie「高质量 (2K)」：  
  「开启后，用户选择 high 才提交 quality=high；关闭时固定 basic」
- Venice / Grok 兼容下的 2K 开关：  
  「开启后，用户选择 high 才提交 2K；关闭时固定 1K」

## 非目标

- 不改 OpenAI `images` / `responses` 的质量与审核透传
- 不按尺寸自动推断 2K/4K
- 不把 `medium` 映射为 high
- 不新增新的数据库字段（复用 `xaiImage2kEnabled`、`nsfwChecker`）

## 数据流

1. 用户选择质量 `high/medium/low/auto`
2. 任务提交时带上 `params.quality`
3. 后端按端点读取 `provider.xaiImage2kEnabled`
4. 计算实际上传质量/分辨率
5. Kie 额外附带管理员决定的 `nsfw_checker`

## 测试要点

1. 管理员关 2K：
   - 用户选 `high`，Kie 仍 `basic`，WaveSpeed 仍 `1k`，Venice 仍 `1K`
2. 管理员开 2K：
   - 用户选 `high` → Kie `high` / WaveSpeed `2k` / Venice `2K`
   - 用户选 `medium`/`low`/`auto` → 仍 1K/basic
3. Kie：
   - 管理员开审核 → `nsfw_checker=true`
   - 管理员关审核 → `nsfw_checker=false`
   - 与用户审核选项无关
4. 前端三端点：
   - 质量可改
   - 审核禁用/忽略
5. OpenAI 端点行为不变

## 实现文件（预期）

- `server/src/lib/kieApi.ts`
- `server/src/lib/wavespeedApi.ts`
- `server/src/lib/imageApi.ts`
- `src/components/InputBar.tsx`
- `src/components/SettingsModal.tsx`
- 可选单测：质量映射纯函数

## 成功标准

1. 三端点恢复响应质量选项
2. 高质量能力由管理员开关门控
3. 用户审核选项不进入三端点请求
4. Kie 审核只跟管理员开关，并始终发送
