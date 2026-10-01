# connect-bot

把当前 omp 会话接入本机运行的 **omp-bot 主界面**：执行 `/connect-bot` 后，该会话周期性上报心跳与 agent 状态，面板的「会话列表」据此显示它的 **在线/离线**（keepAlive）与 **空闲/工作中/等待用户输入**；`/connect-bot offline` 主动断开并让面板移除该行。

单向只读桥：扩展只向面板推送，不接受面板指令，只有一个请求端点（`POST /api/sessions/events`），不落盘、不回放。

## 命令

| 命令 | 行为 | 反馈文案 |
|---|---|---|
| `/connect-bot`（空参） | 注册当前 main 会话并开始推送。重复执行是幂等重连：重发 `register`（不先 `unregister`，面板行不闪烁） | 成功 `已接入 omp-bot 面板（当前 N 个在线会话）`；失败/超时 `无法连接 omp-bot，未启用；请确认面板已启动`；成功后 footer 常驻 `已接入 omp-bot 面板` |
| `/connect-bot offline` | 先本地立即断开（停心跳、清状态与队列），再尽力 `unregister` 让面板移除该行 | 面板可达（含 omp-bot 重启后的 `404`）：`已断开 omp-bot 面板`；不可达/超时：`omp-bot 面板未响应` |
| `/connect-bot <其他>` | 未知参数：报错，状态不变（不会被静默 arm） | `未知参数「off」；用法：/connect-bot（接入 omp-bot 面板）或 /connect-bot offline（断开）。` |

- **门槛**：只有 main 会话且 `hasUI === true` 时可执行（含 `offline`）。子代理静默拒绝；无 UI 模式（`--mode rpc --no-ui`、print/json）在 stderr 打印 `当前模式无 UI，不支持接入面板`，不改状态、不发请求。
- **未接入零动作**：没执行过 `/connect-bot` 的会话不产生任何网络或定时动作；offline 后同样归零（随后的事件不改变任何东西，直到重新 `/connect-bot`）。
- **状态机**：`register` 成功时按 `ctx.isIdle()` 取 `空闲` 或 `工作中`（流式中接入显示 `工作中`，不报假的 `空闲`）；`agent_start`(main) → `工作中`；轮次结束 → `等待用户输入`（主路 `session_stop`，兜底 `agent_end` 且 `willContinue !== true` 时经自检门）；只在 `state` 真变化时上报。不做历史回填：接入一个之前已跑过的会话仍显示 `空闲`。
- **心跳**：每 10s（`ctx.setInterval`）携带当前状态；面板按最近一次写入 >30s 判离线。连续 3 次推送失败（≈30s）自动解除接入并通知 `与 omp-bot 连接中断，已断开；重新执行 /connect-bot 可重连`；本失败段的第一次失败也通知一次 `与 omp-bot 面板连接中断；若持续失败将自动断开`；任一成功推送复位计数与首次标志。**不自动重连**，需手动 `/connect-bot`。
- **会话内切换**：`session_switch`/`session_branch` 且会话 id 变化时，对**旧** id 尽力 `unregister`、本地断开并通知 `会话已切换，已断开面板；重新 /connect-bot 可重连`，新会话保持未接入。id 不变的 `/reload`、同文件 `/resume`、`/clear`、TUI `/branch`、`/tree` 是彻底 no-op，不打断已接入状态。
- **不 hook `session_shutdown`**：正常退出、被杀、扩展失活统一由面板的 30s 过期兜底（该行转「已离线」并保留）。

## 术语（两个轴正交）

| 词 | 属于 | 含义 |
|---|---|---|
| 已接入 / 未接入 | 扩展开关（本会话） | 本会话是否已 `register` 并在推送；footer 常驻标记 |
| 在线 / 离线 | keepAlive（面板判定） | 面板最近一次收到该会话写入是否在 30s 内 |
| 工作中 / 等待用户输入 / 空闲 | agent 状态（`state`） | 在线会话的三态 agent 状态 |

三者互不蕴含：已接入的会话在面板重启后可能显示离线、甚至整行消失（需重新 `/connect-bot`）；崩溃的 omp 留下的「已离线」行仍保持最后一刻的 agent 状态（≠ 未接入）；未接入的会话在面板上根本没有行。

## 安装

复制整个 `connect-bot/` 目录到本机已配置的 extensions 根之一，重启 omp：

```text
~/.omp/agent/extensions/connect-bot/                    # 用户级（默认 profile）
~/.omp/profiles/<name>/agent/extensions/connect-bot/    # 用户级（命名 profile，按 profile 门控）
<project>/.omp/extensions/connect-bot/                  # 项目级
```

也可以把该目录（或 `index.ts` 文件路径）写进对应 `settings.json` 的 `extensions` 数组。

- **拷贝即生效，没有第二道开关**：扩展 id 由目录名派生为 `connect-bot`；`config.json` 里没有 `enabled` 键，写了也会被忽略。
- 扩展目录里的 `config.json` 是**整机唯一**的一份（不是每会话一份）；换 omp-bot 地址只改它。
- 卸载 = 删除目录。

## 配置（config.json）

```json
{
  "endpoint": "http://omp-bot.local:8787"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://omp-bot.local:8787` | omp-bot 主界面基地址。事件路径 `/api/sessions/events` 与 `{ proxy: false }` 是协议常量，写死在代码里，不配置 |

- 缺文件 → 用默认值 + 启动告警一次（`connect-bot: config.json not found next to index.ts; using the default endpoint …`）。
- 内容不是 JSON 对象、或 `endpoint` 不是非空字符串 → 扩展装载失败，omp loader 在启动时报错（地址写错立刻可见，不会静默用坏值）。
- 未知键被忽略；无 env/CLI 覆盖。

### 与 omp-bot `listen_addr` 对齐

omp-bot 的 `omp-bot.toml`：

```toml
listen_addr = "0.0.0.0:8787"
```

- **端口必须与 `endpoint` 一致**：默认端点端口 `8787` 就是 `listen_addr` 的端口。改了 `listen_addr` 的端口后，同步改 `config.json` 的 `endpoint`（运行中的 omp-bot 不会自动重读配置，改完需重启）。
- 主机名 `omp-bot.local` 是 omp-bot 发布的 mDNS 名，与 `0.0.0.0` 的监听地址不是一回事；`0.0.0.0` 只表示监听面向本机与局域网。
- 名字解析不了（或 omp-bot 关掉了 `[mdns]`）时，把 `endpoint` 换成同一端口的本机地址，例如 `http://127.0.0.1:8787`：扩展的写入来源校验接受回环地址。
- `endpoint` 只写基地址（不要带路径）；请求 URL 为 `<endpoint>/api/sessions/events`。

## 测试

无 npm scripts，直调 bun：

```text
bun test tests/connect-bot/          # L1：纯模块单测（config/state/connection）+ 真 factory 的命令/hook 行为（假 api/ctx、注入的 push 端口）
bun tests/connect-bot/smoke-omp.ts   # L2：真 omp loader / ExtensionRunner / 原生发现逻辑的装载冒烟（不真连 omp-bot）
```

- `smoke-omp.ts` 动态 import 本机安装的 omp：装了 omp 的机器才实际执行，缺 omp 的平台不会硬失败。
- **不跑 toolkit 根 `tsc`**：本扩展对 `@oh-my-pi/*` 只做 `import type`，工具包本地没有这些包，根 `tsc` 只会报未解析模块。类型与运行时行为由 L2 冒烟（真 loader/runner 装载）与 L1 断言保证；因此也不要用非 type 的 `import` 引入 `@oh-my-pi/*`。

## L3 手动端到端验收清单

L2 冒烟通过后，用**真 omp + 真 omp-bot** 逐条执行。每条都写明观察点与预期文案；不做脚本化 pty。

**前置**

1. omp-bot 已启动（后端控制台打印 `[omp-bot] 主界面已启动`），浏览器打开 `http://omp-bot.local:8787/`（或 `http://127.0.0.1:8787/`）并保持页面开着（SSE 长连接）。
2. omp 与 omp-bot 同机；omp 在目标项目目录中启动。

**A. 面板就绪**

3. 打开面板。观察点：页面标题与可见标题为 `omp-bot`；两个 tab 为 `控制面板`（默认选中）与 `会话列表`；「会话列表」无会话时显示引导空态，无任何卡片。

**B. 接入成功**

4. 在 omp 中执行 `/connect-bot`。观察点：瞬时通知 `已接入 omp-bot 面板（当前 1 个在线会话）`（N 含本会话，已有别的在线会话则为 2、3…）；footer 出现常驻标记 `已接入 omp-bot 面板`。
5. 切到「会话列表」。观察点：1s 内出现一张卡片，在线灯亮；会话名（未命名时回退 `<cwd 目录名> · <sessionId> 前 8 位`）；agent 状态 `空闲`（新会话尚未开跑；若执行第 4 步时正好在流式中，则显示 `工作中`）；cwd 为 omp 的工作目录；model 为注册时的模型展示名（空则隐藏该字段）。无需刷新页面。

**C. 幂等重注册**

6. 再次执行 `/connect-bot`。观察点：成功通知同上、N 不变；卡片**仍只有一张**、不闪烁、不新增行（重发 `register`，不先 `unregister`）。

**D. 轮次结束 → 等待用户输入**

7. 发一句能自然结束的 prompt（例如 `用一句话介绍你自己`）。观察点：卡片状态先转 `工作中`；模型回答结束、omp 回到输入提示后转 `等待用户输入`，卡片置顶并高亮；「会话列表」tab 出现圆点；组头出现 `1 个刚结束轮次` 与「知道了」按钮。
8. 点「知道了」。观察点：组头计数与额外高亮清除（N=0 时组头只显示「等待用户输入」），但卡片仍留在等待组、状态仍为 `等待用户输入`；tab 上的圆点按等待组非空派生，因此**保留**（点「知道了」与点 tab 都不清零圆点）。
9. 静置 ≥35s（覆盖至少 3 次心跳）。观察点：卡片仍在线、状态仍 `等待用户输入`，不重复弹提示、组头不再计数（心跳只刷 keepAlive 与当前状态，不迁移、不提示）。

**E. 兜底终态（可手动复现者）**

10. **abort**：发一个会长跑的任务，在状态为 `工作中` 时按 Esc（omp 的中断）。观察点：轮次结束进入 `等待用户输入`（走 `agent_end` 兜底），卡片不会卡在 `工作中`。
11. **无 assistant 消息**：发起一轮，在模型产出任何 assistant 消息前立即中断（Esc / abort）。观察点：同样进入 `等待用户输入`，面板不会停在 `工作中`。

**F. 主动离线**

12. 执行 `/connect-bot offline`。观察点：瞬时通知 `已断开 omp-bot 面板`；footer 标记消失；面板该行**立即消失**（不是转成「已离线」）。

**G. 崩溃留下的离线行（可选，验证 30s 过期）**

13. 重新 `/connect-bot`，不执行 offline，直接杀掉 omp 进程。观察点：面板该行保留；自最后一次心跳起约 30–35s 内转「已离线」并下沉到列表末尾，卡片保留最后已知 agent 状态。

**H. 面板失联与自动 disarm（可选）**

14. 已接入状态下停掉 omp-bot。观察点：下一次心跳失败时通知一次 `与 omp-bot 面板连接中断；若持续失败将自动断开`（浏览器侧同时显示「可能已经过期」）；约 30s（连续 3 次失败）后通知 `与 omp-bot 连接中断，已断开；重新执行 /connect-bot 可重连`，footer 标记消失。重启 omp-bot **不会**自动恢复，需手动 `/connect-bot`。
15. omp-bot 已停时执行 `/connect-bot offline`。观察点：本地立即断开、通知 `omp-bot 面板未响应`；浏览器只剩最后快照并标注「可能已经过期」；omp-bot 重启后内存清空，旧行消失。

**I. 拒绝与守卫（可选）**

16. 无 UI 模式：在 `omp --mode rpc --no-ui`（或 print/json 模式）中执行 `/connect-bot`。观察点：stderr 打印 `当前模式无 UI，不支持接入面板`；不发请求、状态不变。
17. 未知参数：`/connect-bot off`。观察点：提示 `未知参数「off」；用法：/connect-bot（接入 omp-bot 面板）或 /connect-bot offline（断开）。`；仍是已接入并继续推送（状态不变）。

**7 类兜底终态的覆盖口径**

| 终态 | 手动复现 | 覆盖 |
|---|---|---|
| abort | 可（清单 10） | L1 + L3 |
| 无 assistant 消息 | 可（清单 11） | L1 + L3 |
| 尾消息仍带 toolCall | 不可稳定复现 | L1 |
| skip-post-turn-maintenance | 不可稳定复现 | L1 |
| successful yield | 不可稳定复现 | L1 |
| compaction `deferredHandoff`/`automaticContinuationBlocked` | 不可稳定复现 | L1 |
| 子代理（由 main 守卫排除，面板无行） | 不可复现 | L1 |

不可手动复现的 5 类由 `tests/connect-bot/extension.test.ts` 的 `every terminal agent_end shape that omits session_stop falls back to 等待用户输入` 与子代理守卫用例覆盖（同为不带 `willContinue` 的 `agent_end` 形状）。

## 边界与已知限制

- 写入只接受本机来源（回环/本机网卡地址），读取（页面 + SSE）对局域网全开、无 token；这是来源校验而非认证，同机任意进程都能写。v1 假设 omp-bot 单实例、无持久化（重启即清空，离线行不老化）。
- 「指向另一实例」与「原实例重启」不可区分，行为一致：非 `register` 事件收到 `404` → 计失败 → 连续 3 次自动 disarm。
- 面板重启后需要手动 `/connect-bot` 重连；不过期判定在服务端（扩展侧无 30s 逻辑）。
- 开发与测试环境：omp 18.4.4（bun 1.4.2）。omp 是快速迭代的开发者预览，升级后如遇命令/hook 语义变化，先跑 `bun tests/connect-bot/smoke-omp.ts` 复核 loader 装载与本扩展订阅的事件（`agent_start`、`session_stop`、`agent_end`、`session_switch`、`session_branch`）。
