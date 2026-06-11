# Read-only Mode

模式切换扩展，在对话中控制 Agent 的文件访问和工具权限。通过对话框上方的彩色标签提示当前模式。

## 模式总览

| 模式 | 标签颜色 | 进入命令 | 退出命令 |
|---|---|---|---|
| **Build** | 蓝 | 默认 / `/readonly` | — |
| **Chat** | 橙 | `/readonly` | `/readonly` |
| **Explore** | 绿 | `/readonly <path>` / `/readonly all` | `/readonly` |
| **Debug** | 黄 | `/readonly debug` | `/readonly` |

## 各模式详情

### Build（构建模式）

默认模式，Agent 拥有完整读写和执行权限。

```
标签: [Build]（蓝色）
命令: /readonly       → 切换到 Chat
```

### Chat（对话模式）

只读模式，限制工作区内操作。

```
标签: [Chat]（橙色）
命令: /readonly       → 切换回 Build

权限:
  ✓ read, search, find, ast_grep, web_search, ask, todo, resolve
  ✓ lsp (仅 definition/hover/references/symbols/diagnostics)
  ✓ browser (仅 open/close)
  ✓ bash (仅只读命令: ls, cat, grep, git log, npm ls...)
  ✓ task (仅 explore, librarian, plan, reviewer)
  ✗ write, edit, ast_edit, eval, debug
  ✗ browser run, lsp rename/code_actions:apply
  ✗ bash 命令链、输出重定向、sed -i
```

### Explore（探索模式）

Chat 模式的范围扩展版，可读取指定外部路径。

```
标签: [Explore: <paths>]（绿色）
命令: /readonly <path1 path2...>     → 限定路径
      /readonly all                   → 所有路径
      /readonly add <path>            → 追加路径
      /readonly remove <path>         → 移除路径
      /readonly clear                 → 回到 Chat
      /readonly                       → 回到 Build

权限: 与 Chat 相同，仅搜索范围扩展
```

### Debug（调试模式）

面向 bug 调查的半自治模式。Agent 可以读所有文件、运行测试、临时插桩，但不能做永久性代码修改。

```
标签: [Debug]（黄色）
命令: /readonly debug   → 进入
      /readonly         → 退回 Build
      /readonly audit   → 展开/收起审计列表

权限:
  ✓ Chat/Explore 的全部读取权限
  ✓ write, edit, ast_edit (仅限临时插桩，靠 prompt 约束)
  ✓ eval, debug
  ✓ browser run (模拟用户操作)
  ✓ bash (放行测试和诊断命令，拦截破坏性操作)
  ✓ task (explore, librarian, plan, reviewer, oracle)
  ✗ bash 破坏性操作:
      rm, rmdir, mv, mkdir, touch, chmod, chown, cp
      git push/commit/merge/rebase/reset --hard
      sed -i, 输出重定向, 命令链
      npm/pip/cargo install/uninstall

兼容性:
  与 Build 模式共用同一个 system prompt，
  频繁切换不影响 DeepSeek 前缀缓存命中率。
```

## 审计列表

Debug 模式下，每轮对话结束后，Agent 的非只读操作会自动记录。

```
默认: 折叠为一行 "Debug Audit: 3 ops | /readonly audit to expand"
展开: /readonly audit → 显示操作详情（工具名 + 目标文件/命令）
收起: /readonly audit → 再次执行收起
```

审计列表每轮自动清空，不会跨轮积压。

## 典型工作流

### Bug 调查流程

```
1. /readonly           → Chat 模式，讨论问题
2. /readonly debug     → Debug 模式，让 Agent 跑测试、加日志
3. 审查 /readonly audit → 查看 Agent 做了哪些操作
4. /readonly           → 切回 Build，执行修复
```

### 跨项目查阅

```
1. /readonly /other/project   → Explore 模式，可读外部项目
2. /readonly                  → 回到 Build
```

### 快速问询

```
1. /readonly             → Chat 模式，问 Agent 关于代码的问题
2. /readonly             → 回到 Build，Agent 执行修改
```
