# DeepSeek Cost Tracker

Session 级别的 token 用量和费用追踪扩展。在 OMP 状态栏区域显示实时费用、预算进度条和每日累积花费。

## 功能

- **上下文预算进度条** — 当前上下文 token 用量 vs 显示预算，按比例着色；ChatGPT/Codex 固定为 272K，DeepSeek 默认 450K
- **即时费用显示** — 每回合和累计的 ¥ 花费、缓存命中率、命中缓存/未命中输入/输出费用比
- **高峰/空闲动态计价** — 按北京时间高峰/空闲自动切换价格；进度条左侧显示 `🔥`（高峰）/ `🌙`（空闲）
- **每日花费追踪** — 按 session 分组统计，数据持久化到 `~/.omp/cost-archive/deepseek-cost.json`
- **分段进度条** — 可视化每个 session 的费用占比，支持精细模式（≤ ¥20）和粗模式（> ¥20）
- **余额查询** — 自动查询 DeepSeek 账户余额
- **ChatGPT/Codex 周额度** — 当当前模型为 `openai-codex` OAuth 模型时，显示 7 天周限额百分比、重置倒计时和绝对时间
- **ChatGPT/Codex 费用** — 使用 OMP catalog 中的动态 USD 价格计算 CacheRead/In/CacheWrite/Out 四路比例、Total/Turn 估计费用；不显示 DeepSeek 余额和每日累计

## 定价

基于 DeepSeek 官方价格表（RMB / 百万 tokens）。高峰时段为北京时间 `[09:00, 12:00]` 和 `[14:00, 18:00]`（闭区间，边界按高峰计）。

| 模型 | 时段 | input（cache miss） | cacheRead（cache hit） | output |
|------|------|------|------|------|
| deepseek-v4-pro | 高峰 | ¥9 | ¥0.30 | ¥27 |
| deepseek-v4-pro | 空闲 | ¥4.5 | ¥0.15 | ¥13.5 |
| deepseek-v4-flash | 高峰 | ¥3 | ¥0.10 | ¥9 |
| deepseek-v4-flash | 空闲 | ¥1.5 | ¥0.05 | ¥4.5 |

DeepSeek 费用分支仅识别以上两个模型 ID；其他非 ChatGPT/Codex 模型不显示 widget、不累计费用。

计价以每次 API 请求发出时刻（`before_provider_request`）锚定价格档位；同一请求的 `message_end` 用量按该档位计费。空闲时定时器会在下一个边界（09:00 / 12:00 / 14:00 / 18:00）自动刷新图标。

### ChatGPT/Codex（OpenAI Codex OAuth）

当当前模型 provider 为 `openai-codex` 时，扩展切换到 ChatGPT/Codex 模式：

- 显示固定 272K 预算的上下文进度条 + 7 天周限额（`7d N%`、重置倒计时和绝对时间）。
- Total/Turn 显示输入缓存命中率、`CacheRead/In/CacheWrite/Out` 四路费用比例、`Sum`（含 orchestration）和 USD 估计费用。
- 费用动态读取 `ctx.model.cost`（USD / 百万 tokens），不硬编码；模型缺少 cost 时隐藏费用相关列。
- 不显示 DeepSeek 余额、每日累计花费和分段条。
- 周额度数据复用 `AuthStorage.fetchUsageReports()`，并通过 `after_provider_response` 吸收 `x-codex-secondary-*` 响应头实现准实时刷新。

进度条预算只是显示和颜色告警使用的分母，不会限制模型请求、修改输出上限或触发上下文压缩。扩展有意不采用模型目录或 `getContextUsage()` 返回的动态 `contextWindow`。

## 命令

| 命令 | 说明 |
|------|------|
| `/budget 300`、`/budget 300K` | 在 DeepSeek 模式设置 300,000 token 的显示预算 |
| `/budget 0` | 恢复 DeepSeek 默认显示预算 450K |
| `/budget detail` | 切换显示模式：简略 / 详细 |
| `/budget clear` | 归档当前追踪数据并重置，开始新周期 |

数字预算只允许在 `deepseek-v4-pro` 和 `deepseek-v4-flash` 下设置；ChatGPT/Codex 始终固定为 272K，其他模型会拒绝修改。K 按十进制 1,000 换算并允许小数；正数超过 1000K 时静默截断为 1000K，不支持 `M` 后缀。

## 原理

### 数据结构

每个 OMP session 在 `deepseek-cost.json` 中维护一条记录，包含：
- `lastInput` / `lastCacheRead` / `lastOutput` — 上次已知的累计值
- `cost` — 该 session 累计花费

token 增量仍在 `agent_end` 用累计值计算，用于更新 `totalTokens` 和 `last*`；费用则由回合内每次 API 请求的 `message_end` 按锚定价累加，`agent_end` 时把 `turnCost` 写入每日总花费和 session 花费。使用"上次已知值"而非"上一回合的 previousTotal"，确保 fork / resume 后不会重复计算 token。

状态栏的三组分费用比（命中缓存/未命中输入/输出）由当前生效价格档实时计算，不写入每日归档 JSON。

### 状态管理

扩展运行时状态封装在 `TrackerState` 对象中，通过 `createTrackerState()` 工厂创建。session 初始化事件（`session_start` / `session_branch` / `session_switch` / `session_tree`）会重置 token 基线、当前上下文、回合数据、余额和 ChatGPT 周额度；显示模式与 DeepSeek 自定义预算在同一次扩展加载期间保留。自定义预算不写入每日归档，扩展重新加载或程序重启后恢复 450K。

`fetchBalance` 只返回数字，格式化和显示由 `refresh` 统一处理——无副作用的数据流。

### 模块架构

```
index.ts           入口：事件注册 + 命令处理 + UI 刷新（DeepSeek / ChatGPT 分支）
tracker-state.ts   TrackerState 类型 + 工厂函数（含 ChatGPT 周额度状态）
cost-calc.ts       纯函数：DeepSeek 价格解析、ChatGPT USD 费用、token 格式化、状态行构建
turn-cost.ts       单回合 per-request 费用累计器（DeepSeek）
daily-tracker.ts   每日持久化：JSON 读写、归档、session 追踪（DeepSeek）
segment-bar.ts     分段进度条渲染：fine / coarse 双模式（DeepSeek）
chatgpt-usage.ts   ChatGPT/Codex 周额度获取、响应头解析、重置时间格式化
```

## 技术细节

纯扩展实现，通过 OMP Extension API 的 `session_start`、`agent_start`、`before_provider_request`、`message_end`、`agent_end` 等事件 hook 实现，不修改 OMP 源代码。边界刷新使用 `ctx.setTimeout` 精确调度到下一个高峰/空闲边界。
