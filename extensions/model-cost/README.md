# Model Cost Tracker

Session 级别的 token 用量和费用追踪扩展。在 OMP 状态栏区域显示实时费用、预算进度条和每日累积花费。

## 功能

- **上下文预算进度条** — 当前上下文 token 用量 vs 显示预算，按比例着色；ChatGPT/Codex 固定为 272K，DeepSeek 默认 450K
- **即时费用显示** — 每回合和累计的 ¥ 花费、缓存命中率、命中缓存/未命中输入/输出费用比
- **高峰/空闲动态计价** — 按北京时间工作日高峰/空闲自动切换价格；周末（周六、周日）全天不区分峰谷，统一按空闲价；进度条左侧显示 `🔥`（高峰）/ `🌙`（空闲）
- **每日花费追踪** — 按 session 分组统计，数据持久化到 `~/.omp/cost-archive/deepseek-cost.json`
- **分段进度条** — 可视化每个 session 的费用占比，支持精细模式（≤ ¥20）和粗模式（> ¥20）
- **余额查询** — 自动查询 DeepSeek 账户余额
- **Token-only 模式** — 当 `deepseek-v4-pro` / `deepseek-v4-flash` 模型经由其它 provider（如 opencode-go）提供时，只显示上下文进度条和 token 统计，不使用 RMB 计费、余额或每日累计；`deepseek-v4-flash-vision-exp` 仅在官方 deepseek provider 下识别
- **双数据源 TTL 缓存** — 输入 `/model`、`/models`、`/switch` 时预取 DeepSeek 余额和 Codex 周额度，30 秒内不重复请求；UI 仍按当前模型展示对应缓存值
- **ChatGPT/Codex 5h/7d 双额度节奏条** — 当当前模型为 `openai-codex` OAuth 模型时，同时显示 5 小时和 7 天两个额度窗口；每个窗口用 20 格单轴进度条编码已用额度和周期时间进度，显示 `quota% / time%`、重置倒计时和绝对时间
- **ChatGPT/Codex 费用** — 使用 OMP catalog 中的动态 USD 价格计算 CacheRead/In/CacheWrite/Out 四路比例、Total/Turn 估计费用；不显示 DeepSeek 余额和每日累计

## 定价

基于 DeepSeek 官方价格表（RMB / 百万 tokens）。工作日高峰时段为北京时间 `[09:00, 12:00]` 和 `[14:00, 18:00]`（闭区间，边界按高峰计）；周末（周六、周日）全天不区分峰谷，统一按空闲（低谷）时段价格计费。

| 模型 | 时段 | input（cache miss） | cacheRead（cache hit） | output |
|------|------|------|------|------|
| deepseek-v4-pro | 高峰 | ¥9 | ¥0.30 | ¥27 |
| deepseek-v4-pro | 空闲 | ¥4.5 | ¥0.15 | ¥13.5 |
| deepseek-v4-flash | 高峰 | ¥3 | ¥0.10 | ¥9 |
| deepseek-v4-flash | 空闲 | ¥1.5 | ¥0.05 | ¥4.5 |
| deepseek-v4-flash-vision-exp | 高峰 | ¥3 | ¥0.10 | ¥9 |
| deepseek-v4-flash-vision-exp | 空闲 | ¥1.5 | ¥0.05 | ¥4.5 |

DeepSeek 费用分支仅在 provider 为 `deepseek` 且模型 ID 命中以上模型时激活；`deepseek-v4-pro` / `deepseek-v4-flash` 经由其它 provider 进入 token-only 模式，`deepseek-v4-flash-vision-exp` 只在官方 deepseek provider 下识别；其余非 ChatGPT/Codex 模型不显示 widget、不累计费用。

计价以每次 API 请求发出时刻（`before_provider_request`）锚定价格档位；同一请求的 `message_end` 用量按该档位计费。空闲时定时器会在下一个边界（09:00 / 12:00 / 14:00 / 18:00）自动刷新图标。

### ChatGPT/Codex（OpenAI Codex OAuth）

当当前模型 provider 为 `openai-codex` 时，扩展切换到 ChatGPT/Codex 模式：

- 显示固定 272K 预算的上下文进度条 + 5h/7d 双额度节奏条。5h 窗口以 `5h` 开头，7d 窗口以 `7d` 开头；每个窗口各用 20 格单轴进度条：`━` 已用额度、`─` 未用额度、`│` 当前周期时间位置，以及 `quota% / time%`、重置倒计时和绝对时间。
- Total/Turn 显示输入缓存命中率、`CacheRead/In/CacheWrite/Out` 四路费用比例、`Sum`（含 orchestration）和 USD 估计费用。
- 费用动态读取 `ctx.model.cost`（USD / 百万 tokens），不硬编码；模型缺少 cost 时隐藏费用相关列。
- 不显示 DeepSeek 余额、每日累计花费和分段条。
- 额度数据通过 OMP 公开的 `openaiCodexUsageProvider.fetchUsage` 获取，并在扩展内使用 `PI_PROXY_OPENAI_CODEX`（缺失时回退 `PI_PROXY`）建立 request-scoped 代理；不修改进程全局 `HTTPS_PROXY`。
- 通过 `after_provider_response` 复用 OMP 公开的 Codex rate-limit header parser，并按报告时长分别识别 5h 和 7d 主聊天窗口（primary/secondary 均可）。每个 provider response 的响应头都会即时更新两个窗口和 widget，不再等 `agent_end`。
- 首次加载显示 `5h … · 正在获取` 和 `7d … · 正在获取`；代理缺失、认证失败、传输失败、OMP 版本不兼容都只在 widget 内展示错误摘要，不弹通知。
- 主动用量刷新为 single-flight：`/model`、`/models`、`/switch` 输入时按 30s TTL 预取 DeepSeek 余额和 Codex 5h/7d 额度；`agent_start` / `session_start` 只在当前模型对应缓存缺失或过期时拉取；`agent_end` 强制刷新当前模型对应值。`message_end` 不新增主动 API 请求，实时性由响应头承担。

每个额度窗口分别使用固定周期模型：5h 周期起点为报告重置时间减去恰好 5 小时，7d 周期起点为报告重置时间减去恰好 7 天；`time%` 由当前渲染时刻计算。额度相对时间的超前百分点决定粗线和额度数字的语义颜色：落后或持平用 `text`，0–15 个百分点用 `success`，15–30 用 `warning`，超过 30 用 `error`；无法取得有效重置时间时整条额度使用 `muted` 并显示 `quota% / --`。时间未知、已过期、超过周期无效分别显示 `reset unknown`、`reset expired (<local>)`、`reset invalid (<local>)`。窄终端按顺序移除 20 格条、绝对重置时间、重置倒计时，最后保留 `5h quota% / time%` / `7d quota% / time%`，仍放不下时才做 ANSI-aware 右截断；整段始终单行。渲染不新增定时器、不发起额外额度请求。

进度条预算只是显示和颜色告警使用的分母，不会限制模型请求、修改输出上限或触发上下文压缩。扩展有意不采用模型目录或 `getContextUsage()` 返回的动态 `contextWindow`。

## 命令

| 命令 | 说明 |
|------|------|
| `/budget 300`、`/budget 300K` | 在 DeepSeek 模式设置 300,000 token 的显示预算 |
| `/budget 0` | 恢复 DeepSeek 默认显示预算 450K |
| `/budget detail` | 切换显示模式：简略 / 详细 |
| `/budget clear` | 归档当前追踪数据并重置，开始新周期 |

数字预算只允许在 provider 为 `deepseek` 的 DeepSeek 模式下设置；opencode-go 等其它 provider 即使模型 ID 是已知 DeepSeek 模型也会拒绝。ChatGPT/Codex 始终固定为 272K，其他模型会拒绝修改。K 按十进制 1,000 换算并允许小数；正数超过 1000K 时静默截断为 1000K，不支持 `M` 后缀。

## 原理

### 数据结构

每个 OMP session 在 `deepseek-cost.json` 中维护一条记录，包含：
- `lastInput` / `lastCacheRead` / `lastOutput` — 上次已知的累计值
- `cost` — 该 session 累计花费

token 增量仍在 `agent_end` 用累计值计算，用于更新 `totalTokens` 和 `last*`；费用则由回合内每次 API 请求的 `message_end` 按锚定价累加，`agent_end` 时把 `turnCost` 通过 `daily-tracker` 的 `recordTurnCost` 写入每日总花费和 session 花费。使用"上次已知值"而非"上一回合的 previousTotal"，确保 fork / resume 后不会重复计算 token。

状态栏的三组分费用比（命中缓存/未命中输入/输出）由当前生效价格档实时计算，不写入每日归档 JSON。

### 并发安全

多个 CLI 进程（或同一进程中的多个 session）各自持有一个 `DailyTracker` 实例，但共享 `~/.omp/cost-archive/deepseek-cost.json`：

- 所有变更（`recordTurnCost` / `ensureSession` / `write` / `archive`）通过 OMP 原生跨进程文件锁（`@oh-my-pi/pi-utils/file-lock`：Windows 命名互斥体、Linux abstract Unix socket、其他平台 `flock`）串行化；等待预算为 300 次 × 50ms（15s），落在 OMP 扩展 handler 的 30s 上限内。
- 锁内重新读取磁盘上的最新数据、合并变更，最后写临时文件 + `rename` 原子发布——任何进程都不会覆盖其他进程刚写入的费用。Windows 上 `rename` 碰到读进程短暂持有文件时自动带退避重试。
- 读路径不加锁，但按 `size + mtime` 缓存失效，因此一个 CLI 的 Accrued 会实时反映另一个 CLI 的累计费用。
- 损坏的 JSON 不会被静默重置为空白归档：显示回退到最后一次成功快照，写路径在锁内报错并交由调用方 best-effort 处理。
- `file-lock.ts` 用惰性动态 import + 测试注入 seam 包装 OMP 锁，独立于 OMP 运行时的测试不会加载原生 addon。

### 状态管理

扩展运行时状态封装在 `TrackerState` 对象中，通过 `createTrackerState()` 工厂创建。session 初始化事件（`session_start` / `session_branch` / `session_switch` / `session_tree`）会重置 token 基线、当前上下文、回合数据、余额、ChatGPT 5h 额度和周额度；显示模式与 DeepSeek 自定义预算在同一次扩展加载期间保留。自定义预算不写入每日归档，扩展重新加载或程序重启后恢复 450K。

`fetchBalance` 只返回数字，格式化和显示由 `refresh` 统一处理——无副作用的数据流。

### 模块架构

```
index.ts           入口：事件注册 + 命令处理 + 统一初始化 + UI 刷新（DeepSeek / Codex / token-only）
model-mode.ts       纯函数：模型模式分类（deepseek / codex / token-only / hidden）
balance-cache.ts    纯内存 TTL 缓存：DeepSeek 余额 + Codex 5h/7d 额度快照
tracker-state.ts   TrackerState 类型 + 工厂函数（含 ChatGPT 5h/7d 额度状态）
cost-calc.ts       纯函数：DeepSeek 价格解析、ChatGPT USD 费用、token 格式化、状态行构建
turn-cost.ts       单回合 per-request 费用累计器（DeepSeek）
daily-tracker.ts   每日持久化：OMP 跨进程锁 + 原子 JSON 读写、归档、session 追踪、回合费用合并（DeepSeek）
file-lock.ts       OMP 原生文件锁的惰性加载 wrapper + 测试 seam
segment-bar.ts     分段进度条渲染：fine / coarse 双模式（DeepSeek）
chatgpt-usage.ts   ChatGPT/Codex 5h/7d scoped proxy 获取、响应头解析、窗口选择、节奏条/重置/错误渲染
```

## 技术细节

纯扩展实现，通过 OMP Extension API 的 `session_start`、`agent_start`、`input`、`before_provider_request`、`after_provider_response`、`message_end`、`agent_end` 等事件 hook 实现，不修改 OMP 源代码。由于 `model_changed` 未暴露给扩展，`/model`、`/models`、`/switch` 通过 `input` 事件触发 DeepSeek 余额 + Codex 5h/7d 额度的双数据源预取，并使用 30 秒纯内存 TTL 缓存；`agent_start` / `session_start` 只在当前模型对应缓存缺失或过期时拉取，`agent_end` 强制刷新当前模型对应值。每个 `after_provider_response` 都会用响应头即时更新 5h/7d 两个窗口，因此每轮 assistant message 后无需额外主动请求即可刷新显示。边界刷新使用 `ctx.setTimeout` 精确调度到下一个高峰/空闲边界。
