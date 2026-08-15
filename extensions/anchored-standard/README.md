# Anchored Standard

两阶段 bootstrap 扩展：会话首个模型请求以 Minimal 对齐条件发出（最小工具面 + 输出封顶 + 剥离自动注入上下文），产生首个持久 promotion 信号后恢复完整 omp 工具目录与提示。移植自 [dsh-anchored-standard](https://github.com/…/dsh-anchored-standard) preset 的机制。

## 机制

| 阶段 | 工具面 | 输出预算 | system prompt |
|---|---|---|---|
| **bootstrap**（未 promote） | wire 层收窄为一个平台 shell + `read` | `max_tokens` 类字段封顶 `bootstrapMaxTokens`（默认 1024） | 仅 Minimal persona |
| **promoted** | 全量目录 | 恢复缺省（不再写入封顶，无状态泄漏） | persona 保持；omp 原提示以 developer 消息 append 进对话（`restoreMode: "append"`） |

- **promotion 信号**（`promoteOn`）：`either`（默认，首个 tool call 或首个 assistant 回复先到先得）/ `tool-call` / `assistant-message`。信号从**持久化会话条目**派生——resume/reload 保相位；每进程按 session id memoize。
- **子代理豁免**：registry `kind !== "main"` 的会话（task 子代理、advisor）首请求即全量。
- **缓存语义**：append 模式下 system+消息前缀全程恒定；wire 工具目录只在 promotion 时变化一次，前缀缓存只断那一次（dsh 原版同样接受该成本）。

## 安装

复制整个目录到用户或项目的 extensions 目录：

```
~/.omp/agent/extensions/anchored-standard/     # 用户级（默认 profile）
~/.omp/profiles/<name>/agent/extensions/anchored-standard/   # 按 profile（白送 profile 门控）
<project>/.omp/extensions/anchored-standard/   # 项目级
```

重启 omp。`config.json` 的 `enabled` 默认 `true`（拷贝即生效）；置 `false` 即可停用，删除目录即卸载。零依赖、无网络调用、无遥测。

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `promoteOn` | `"either"` | `either` / `tool-call` / `assistant-message` |
| `bootstrapMaxTokens` | `1024` | 首请求输出封顶（DeepSeek V4 特调值；其他模型可调） |
| `personaText` | `"You are a helpful software engineer assistant."` | bootstrap 阶段 persona |
| `restoreMode` | `"append"` | `append`：omp 原提示 promote 后作为消息 append（system 前缀恒定）；`system-block`：promote 后恢复为 system 块；`none`：整会话 persona（dsh 字面语义） |
| `shellTools` | `["bash", "pwsh"]` | 平台 shell 候选，bootstrap 时要求恰好命中一个 |
| `commonTools` | `["read"]` | bootstrap 时与 shell 并存的工具 |

## 健壮性约定

- 每个过滤器失败都**降级为原始请求**并一次性告警：缺 bootstrap 工具 → 全量目录；无法识别的 provider payload → 不封顶；会话扫描异常 → 视为已 promote。任何 bug 都不会卡死会话或吞掉用户上下文。
- 非法配置（错误的 `promoteOn`/`restoreMode`、非正整数 cap、空工具列表）在扩展加载时直接失败，omp loader 会显示错误。
- 用户主动的 skill 手势等非自动注入内容不受影响（本扩展只替换 system prompt 与 wire 参数，不触碰对话消息本身）。

## 测试

```
bun test tests/anchored-standard/        # 单元 + fake-harness 集成（88 用例）
bun tests/anchored-standard/smoke-omp.ts # L2：真实 omp loader/runner/registry 全链路烟测
```

## 已知限制

- 封顶/收窄作用于 wire 层；provider 自有的 in-band 工具转写（owned-dialect，env 选择）不受 wire 工具过滤影响。
- `restoreMode: "append"` 的 developer 消息在 promotion 后按最近一次 agent start 捕获的提示注入；promotion 后新增的 skills 不会更新它（下个会话生效）。
- 副作用请求（advisor、标题生成）不走 `before_provider_request` 主链路钩子，不受封顶/收窄影响。

## 兼容性

开发与测试环境：omp 17.3.4（bun 1.3.14）。omp 是快速迭代的开发者预览，升级前检查本扩展使用的三个事件（`before_agent_start`、`before_provider_request`、`context`）语义是否变化。
