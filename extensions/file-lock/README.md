# File Lock

文件编辑锁扩展。防止 Agent 对同一文件连续编辑而不重新 read，导致 hashline 行号漂移造成文件损坏。

## 为什么需要这个扩展

OMP 的 `edit` 工具（hashline 模式）使用 **行号** 定位编辑位置（`replace 5..7:`）。当 Agent 对同一个文件连续编辑时：

1. 第一次编辑成功，文件内容改变，行号漂移
2. 第二次编辑使用旧的行号，标记了错误的编辑位置
3. hashline 的 Recovery 机制尝试三路合并恢复，但 **不能保证正确性**
4. 结果：编辑应用到错误行号 → 文件结构损坏

Claude Code 使用 `old_string`/`new_string` 做**内容寻址**编辑，天然不怕行号漂移。OMP 的 hashline 是**位置寻址**，必须有额外的守卫。

## 原理

两层守卫：

### 1. 锁守卫

```
read  → 锁授予（可编辑）
edit  → 锁消费（不可编辑）
edit  → 阻止："文件已被修改，请重新 read 获取最新内容和行号"
```

追踪每个文件的"read → edit"生命周期。一次 read 只允许一次 edit。

### 2. Tag 校验（仅 hashline）

```
read 输出 → [src/foo.ts#1A2B]         记录 tag
edit 输入 → [src/foo.ts#1A2B]         必须与记录的 tag 一致
edit 输入 → [src/foo.ts#9C3F]         ← 旧 tag，阻止
```

即使 Agent 重新 read 了文件，仍可能错误使用旧的 tag。Tag 校验确保编辑使用的 tag 与最近一次 read 的 tag 一致。

### 三层错误消息

| 场景 | 拦截消息 |
|------|---------|
| 未读取就编辑 | "文件未被读取，请先使用 read 工具读取文件内容" |
| 编辑后未重新 read | "文件已被修改，请重新 read 获取最新内容和行号，然后重新计算编辑位置" |
| 使用了过期 tag | "tag 已过期（使用了 XXXX，最新为 YYYY），请使用最近一次 read 输出中的 tag" |

## 使用

```
/lock    → 开启文件锁（状态栏显示 🔒 hardcore edit）
/lock    → 关闭文件锁（状态栏清除）
```

默认关闭，不影响 OMP 原生行为。开启后 `edit` 操作受锁保护；`write` 操作不依赖行号定位，不受锁限制，但成功执行后仍会标记文件为已修改（后续 `edit` 需要重新 `read`）。

## 覆盖范围

| 工具 | 锁守卫 | Tag 校验 |
|------|-------|---------|
| edit（hashline） | ✅ | ✅ |
| edit（replace） | ✅ | —（无 tag） |
| edit（patch） | ✅ | —（无 tag） |
| write | —（不依赖行号） | —（无 tag） |

## 局限性

- **外部修改**：如果用户在另一个编辑器修改了文件，Agent 的 tag 过期，也会被拦截要求重新 read（而非尝试 Recovery 合并）。
- **LLM 推理错误**：锁不保证 Agent 正确理解了重新 read 的内容。如果 Agent 看到正确行号仍然写错，这是 LLM 推理问题，不是工具守卫的范畴。
- **会话内生效**：锁状态仅在当前会话有效，重新启动 OMP 后恢复为关闭。

## 技术细节

纯扩展实现，通过 OMP Extension API 的 `tool_call` + `tool_result` hook 实现，**不修改 OMP 源代码**。版本升级后扩展代码不受影响。
