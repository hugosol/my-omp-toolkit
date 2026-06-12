# DeepSeek Cost Tracker

Session 级别的 token 用量和费用追踪扩展。在 OMP 状态栏区域显示实时费用、预算进度条和每日累积花费。

## 功能

- **上下文预算进度条** — 当前上下文 token 用量 vs 可配置预算（默认 220K），按比例着色
- **即时费用显示** — 每回合和累计的 ¥ 花费、缓存命中率、输入/输出比
- **每日花费追踪** — 按 session 分组统计，数据持久化到 `~/.omp/cost-archive/deepseek-cost.json`
- **分段进度条** — 可视化每个 session 的费用占比，支持精细模式（≤ ¥20）和粗模式（> ¥20）
- **余额查询** — 自动查询 DeepSeek 账户余额

## 定价

基于 `deepseek-v4-pro`（RMB / 百万 tokens）：

| 类型 | 单价 |
|------|------|
| input（cache miss） | ¥3 |
| cacheRead（cache hit） | ¥0.025 |
| output | ¥6 |

## 命令

| 命令 | 说明 |
|------|------|
| `/budget 300K` | 设置上下文预算上限（单位 K） |
| `/budget detail` | 切换显示模式：简略 / 详细 |
| `/budget clear` | 归档当前追踪数据并重置，开始新周期 |

## 原理

### 数据结构

每个 OMP session 在 `deepseek-cost.json` 中维护一条记录，包含：
- `lastInput` / `lastCacheRead` / `lastOutput` — 上次已知的累计值
- `cost` — 该 session 累计花费

当 agent 回合结束（`agent_end` 事件），扩展计算增量：
```
delta = 当前累计 - 上次已知值
```

增量用于更新每日总花费和 session 花费。使用"上次已知值"而非"上一回合的 previousTotal"，确保 fork / resume 后不会重复计算。

### 状态管理

扩展运行时状态封装在 `TrackerState` 对象中，通过 `createTrackerState()` 工厂创建。每次 session 初始化（`session_start` / `session_branch` / `session_switch` / `session_tree`）时重置状态。

`fetchBalance` 只返回数字，格式化和显示由 `refresh` 统一处理——无副作用的数据流。

### 模块架构

```
index.ts           入口：事件注册 + 命令处理 + UI 刷新
tracker-state.ts   TrackerState 类型 + 工厂函数
cost-calc.ts       纯函数：费用计算、token 格式化、状态行构建
daily-tracker.ts   每日持久化：JSON 读写、归档、session 追踪
segment-bar.ts     分段进度条渲染：fine / coarse 双模式
```

## 技术细节

纯扩展实现，通过 OMP Extension API 的 `session_start`、`agent_end`、`agent_start` 等事件 hook 实现，不修改 OMP 源代码。
