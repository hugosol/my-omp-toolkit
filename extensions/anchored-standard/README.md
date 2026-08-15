# Anchored Standard

Persona 锚定扩展：主会话全程以最小 persona 作为 system prompt；会话记录首个 assistant 消息后，每次上下文组装把捕获的 omp 原提示词（剥离 persona 段）作为一条 developer 消息插到消息列表第 1 位，使模型恢复 omp 的工具说明、skills、规则与项目上下文，同时避免第二份 persona 与 system prompt 竞争。

## 机制

| 阶段 | system prompt | 对话消息 |
|---|---|---|
| **未 promote** | `personaText` | 不注入 |
| **首个 assistant 消息后** | `personaText`（不变） | 每次请求在 index 1 插入 developer 消息：剥离 `§ Role`…`§ Runtime` 区间后的 omp 原提示 |

- **promotion 信号**（硬编码）：会话持久条目中出现首个 assistant 消息即 promote；resume/reload 保相位，每进程按 session id memoize。
- **子代理豁免**：registry `kind !== "main"` 的会话（task 子代理、advisor）保持原 omp prompt，不注入 developer 消息。
- **缓存语义**：system prompt 全程恒定（persona）；promotion 时消息前缀只变化一次。
- **锚点契约**：剥离依赖 omp 提示词中的 `§ Role`/`§ Runtime` 段落标记。`session_start` 检查 base prompt，`before_agent_start` 用当轮 prompt 复检。标记缺失时本会话**停用扩展全部逻辑**并通知用户一次（文件日志 + 会话可见消息；TUI `notify`/`setStatus`；print 模式 stderr）；标记恢复后下一轮 agent start 自动恢复。
- 停用通知的会话消息会进入 LLM 上下文（有意为之，让模型同样知晓扩展已停用）。

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
| `personaText` | `"You are a helpful software engineer assistant."` | 主会话全程 system prompt |

旧版本的 `promoteOn` / `bootstrapMaxTokens` / `shellTools` / `commonTools` / `restoreMode` 键已被废弃，保留在配置文件中会被静默忽略。

## 健壮性约定

- 每个钩子失败都降级为原始输入并一次性告警；锚点缺失按上述协议停用并通知。任何 bug 都不会卡死会话或吞掉用户上下文。
- 非法配置（`enabled` 非布尔、`personaText` 空）在扩展加载时直接失败，omp loader 会显示错误。
- 本扩展不注册 `before_provider_request`：wire payload（工具目录、max_tokens）零干预。

## 测试

```
bun test tests/anchored-standard/        # 单元 + fake-harness 集成
bun tests/anchored-standard/smoke-omp.ts # L2：真实 omp loader/runner/registry 全链路烟测
```

## 已知限制

- developer 消息按最近一次 agent start 捕获的提示注入；promotion 后新增的 skills 不会更新它（下个会话生效）。
- 剥离锚点依赖 omp 提示词结构：omp 重排或改名 `§ Role`/`§ Runtime` 时扩展自动停用并通知用户，需要同步更新 `strip.ts` 中的常量。
- 副作用请求（advisor、标题生成）不走 `before_provider_request`/`before_agent_start` 主链路钩子，不受影响。

## 兼容性

开发与测试环境：omp 17.3.4（bun 1.3.14）。omp 是快速迭代的开发者预览，升级前检查本扩展使用的三个事件（`session_start`、`before_agent_start`、`context`）与 `ctx.getSystemPrompt()` 语义是否变化。
