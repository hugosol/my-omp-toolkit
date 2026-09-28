# codeBaseTools

这是一个为促使 agent 主动调用 codebase-memory-mcp 相关工具而开发的独立 OMP 扩展。它按会话开关与注入时机，将目录中的 Markdown 提示词作为隐藏消息加入对话；提示词文本请直接查看对应的 `.md` 文件。

## 行为

`/codebase-tools` 切换注入，默认 off。开启后：

| 时机 | 注入 | 形态 |
| --- | --- | --- |
| 每个会话首次启用轮 | **init**：注入 `prompts/init.md` 的提示词 | 隐藏持久化 developer 消息 |
| 之后每个启用轮 | **reminder**：注入 `prompts/reminder.md` 的提示词 | 隐藏持久化 developer 消息 |

- 两条消息都是 `display:false`、`attribution:"agent"`，经 `before_agent_start` 注入，落在当轮 user prompt 之后；会写进会话历史并在 resume 时重放。
- 两个 `.md` 文件独立导入；扩展只按注入时机选择其中一个，不建立两份提示词之间的依赖关系。
- 开启时在编辑器上方显示一行 `◈ codeBaseTools` 标记（`aboveEditor` widget）；每个启用轮重新设置标记，关闭时清除。
- off 只停止注入：不清理历史、不注入取消消息。
- 状态 `{on, initInjected}` 存在非 LLM 的 `codebase-tools:state` entry；`session_start` 与 `session_switch` 自动恢复。
- 子代理继承主会话开关（模块级共享），每个会话独立 init。
- 扩展不探测索引或工具能力；注入决策只依据开关状态和 `initInjected`。

## 安装

复制整个目录到用户级或项目级 extensions 目录，重启 omp：

```text
~/.omp/agent/extensions/codebase-tools/
<project>/.omp/extensions/codebase-tools/
```

扩展不校验会话中的工具是否满足提示词要求；启用前请自行查看 `prompts/init.md` 和 `prompts/reminder.md`。

## 配置

无 `config.json`；`/codebase-tools` 是唯一开关，会话内生效、不跨会话保存（resume 由会话 entry 恢复）。

## 文件

```text
index.ts              工厂：命令 / aboveEditor 标记 / 事件钩子
state.ts              纯逻辑：状态解析、注入决策、标记常量
prompts.ts            .md 文本导入
prompts/init.md       首次启用轮注入的提示词
prompts/reminder.md   后续启用轮注入的提示词
```

## 测试

```text
bun test tests/codebase-tools/
bun tests/codebase-tools/smoke-omp.ts
```

`smoke-omp.ts` 用已安装的 omp 真 loader/runner 跑：装载、开关、标记、init→reminder、resume 恢复、子代理继承、off 静默。

## 已知限制

- 子代理使用同一套提示词文件，扩展不会按其可用工具裁剪注入内容。
- 文案是编译期常量：改 `.md` 后需重启 omp 生效。
