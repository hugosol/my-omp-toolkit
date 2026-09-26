# codeBaseTools

独立的 OMP 扩展：让 agent 在理解代码库时优先走 codebase-memory-mcp 的图工具与 LSP，把 `grep` 留给字面/逐行搜索。

## 行为

`/codebase-tools` 切换注入，默认 off。开启后：

| 时机 | 注入 | 形态 |
| --- | --- | --- |
| 每个会话首次启用轮 | **init**：完整路由规则（`prompts/init.md`） | 隐藏持久化 developer 消息 |
| 之后每个启用轮 | **reminder**：一行指针（`prompts/reminder.md`） | 隐藏持久化 developer 消息 |

- 两条消息都是 `display:false`、`attribution:"agent"`，经 `before_agent_start` 注入，落在当轮 user prompt 之后；会写进会话历史并在 resume 时重放。
- `reminder` 只调用 init 定义的 `【codeBaseTools 路由】` token，不重复规则表（单一真相源）。
- off 只停止注入：不清理历史、不注入取消消息。
- 状态 `{on, initInjected}` 存在非 LLM 的 `codebase-tools:state` entry；`session_start` 与 `session_switch` 自动恢复。
- 子代理继承主会话开关（模块级共享），每个会话独立 init。
- 不探测索引：init 文案让 agent 自查 `list_projects` / `index_status` / `check_index_coverage`。

## 安装

复制整个目录到用户级或项目级 extensions 目录，重启 omp：

```text
~/.omp/agent/extensions/codebase-tools/
<project>/.omp/extensions/codebase-tools/
```

前置能力：会话里应存在 codebase-memory-mcp 与 `lsp` 工具。扩展**不做能力探测**，统一注入同一份文案——请只在具备这些工具时开启。

## 配置

无 `config.json`；`/codebase-tools` 是唯一开关，会话内生效、不跨会话保存（resume 由会话 entry 恢复）。

## 文件

```text
index.ts              工厂：命令 / 状态标记 / 事件钩子
state.ts              纯逻辑：状态解析、注入决策
prompts.ts            .md 文本导入
prompts/init.md       完整路由规则（唯一真相源）
prompts/reminder.md   一行指针
```

## 测试

```text
bun test tests/codebase-tools/
bun tests/codebase-tools/smoke-omp.ts
```

`smoke-omp.ts` 用已安装的 omp 真 loader/runner 跑：装载、开关、init→reminder、resume 恢复、子代理继承、off 静默。

## 已知限制

- reminder 每轮持久化，历史按会话线性增加一条短消息；压缩会折叠。
- 子代理定义里没有 `lsp` 时仍会收到含 LSP 的文案（按设计不切分）。
- 文案是编译期常量：改 `.md` 后需重启 omp 生效。
