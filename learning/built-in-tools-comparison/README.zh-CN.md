> 翻译基于英文版（未提交） | [English Version](./README.md)

# Claude Code vs Codex CLI：内置工具（Built-in Tools）全面对比

> **调研日期**：2026-02-16
> **范围**：Claude Code（Anthropic）与 Codex CLI（OpenAI）内置工具的完整对比
> **来源**：官方文档、GitHub 仓库（`anthropics/claude-code`、`openai/codex`）、源码分析、社区调研
> **方法**：10 个并行 agent 覆盖两套工具系统的所有方面

---

## 目录

1. [架构概览](#1-架构概览)
2. [完整工具清单](#2-完整工具清单)
3. [工具逐项对比矩阵](#3-工具逐项对比矩阵)
4. [共有工具——详细对比](#4-共有工具详细对比)
5. [Claude Code 独有工具](#5-claude-code-独有工具)
6. [Codex CLI 独有工具](#6-codex-cli-独有工具)
7. [参数级别差异](#7-参数级别差异)
8. [权限与沙箱模型](#8-权限与沙箱模型)
9. [核心结论](#9-核心结论)

---

## 1. 架构概览

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| **实现语言** | TypeScript/Node.js | Rust（96%）+ TypeScript |
| **模型** | Claude Opus 4.6 / Sonnet 4.5 / Haiku 4.5 | GPT-5.x-codex 系列（默认 gpt-5.3-codex） |
| **工具数量** | ~16 个内部工具 + 团队/任务工具 | ~25+ 个工具（许多处于 feature-gated / 实验阶段） |
| **工具设计理念** | 大量专用、细粒度工具 | 历史上以 shell 为中心，正朝专用工具演进 |
| **文件编辑** | 精确字符串替换（`Edit`/`MultiEdit`）+ 全量覆写（`Write`） | 统一 diff 补丁（`apply_patch`） |
| **Shell** | 专用 `Bash` 工具，附带丰富元数据 | `shell`/`shell_command` + `exec_command`/`write_stdin`（PTY） |
| **搜索** | 专用 `Glob` + `Grep`（基于 ripgrep） | 实验性 `grep_files` + `list_dir`；历史上依赖 shell |
| **Web 访问** | 内置 `WebFetch` + `WebSearch` | 内置 `web_search`（cached/live 模式） |
| **Multi-Agent** | 完整团队系统（`Task`、`TeamCreate`、`SendMessage`） | 实验性 `spawn_agent`/`send_input`/`resume_agent`/`wait`/`close_agent` |
| **MCP 支持** | 完整 MCP client + server（多传输协议） | 仅 stdio MCP client（无 HTTP）；可作为 MCP server 运行 |
| **扩展模型** | Skills、Hooks、MCP servers、自定义 agents | MCP servers、Skills（SKILL.md）、配置自定义工具、feature flags |
| **沙箱** | OS 级：Seatbelt（macOS）、Landlock+seccomp（Linux） | OS 级：Seatbelt（macOS）、Landlock+seccomp（Linux）、Docker 选项 |

---

## 2. 完整工具清单

### Claude Code（~16+ 个工具）

| 分类 | 工具 |
|------|------|
| **文件 I/O** | `Read`、`Write`、`Edit`、`MultiEdit`、`NotebookEdit` |
| **搜索** | `Glob`、`Grep` |
| **Shell** | `Bash`（含后台模式 + `TaskOutput`） |
| **Web** | `WebFetch`、`WebSearch` |
| **Agent/团队** | `Task`（sub-agent 生成）、`TeamCreate`、`TeamDelete`、`SendMessage` |
| **任务管理** | `TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet` |
| **UX** | `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`、`Skill` |

### Codex CLI（~25+ 个工具，大量 feature-gated）

| 分类 | 工具 | 状态 |
|------|------|------|
| **Shell** | `shell`、`shell_command` | 稳定 |
| **交互式 Shell** | `exec_command`、`write_stdin` | Beta（unified exec） |
| **文件编辑** | `apply_patch`（freeform + JSON 变体） | 稳定（freeform: 实验性） |
| **文件 I/O** | `read_file`、`list_dir` | 实验性（feature-gated） |
| **搜索** | `grep_files`、`search_tool_bm25` | 实验性（feature-gated） |
| **Web** | `web_search` | 稳定 |
| **Agent** | `spawn_agent`、`send_input`、`resume_agent`、`wait`、`close_agent` | 实验性（Collab feature flag） |
| **图片** | `view_image` | 稳定 |
| **JavaScript** | `js_repl`、`js_repl_reset` | 实验性（JsRepl feature flag） |
| **UX** | `request_user_input`、`update_plan` | 稳定 |
| **MCP** | `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | 稳定 |
| **Skills** | `$skill-creator`、`$skill-installer` | 系统级 |

---

## 3. 工具逐项对比矩阵

### 图例
- ✅ 有专用工具（稳定）
- 🧪 实验性 / feature-gated
- ⚠️ 部分支持 / 通过其他机制实现
- ❌ 不支持

| 能力 | Claude Code | Codex CLI |
|------|------------|-----------|
| **文件读取** | ✅ `Read`（PDF、图片、Notebook、部分读取） | 🧪 `read_file`（含独特的缩进模式） |
| **文件写入** | ✅ `Write` | ⚠️ 通过 `apply_patch`（Add File） |
| **文件编辑** | ✅ `Edit` + `MultiEdit` | ✅ `apply_patch`（Update File） |
| **文件删除** | ⚠️ 通过 `Bash`（`rm`） | ✅ `apply_patch`（Delete File） |
| **文件重命名/移动** | ⚠️ 通过 `Bash`（`mv`） | ✅ `apply_patch`（`*** Move to:`） |
| **目录列表** | ⚠️ 通过 `Bash`（`ls`） | 🧪 `list_dir`（支持深度） |
| **Shell 执行** | ✅ `Bash` | ✅ `shell` / `shell_command` |
| **交互式 Shell** | ⚠️ 通过 `Bash` 后台模式 | ✅ `exec_command` + `write_stdin` |
| **文件搜索（glob）** | ✅ `Glob` | ❌（用 shell；`list_dir` 为实验性） |
| **内容搜索（grep）** | ✅ `Grep`（12+ 参数） | 🧪 `grep_files`（4 个参数） |
| **Web 抓取** | ✅ `WebFetch`（AI 处理） | ❌ |
| **Web 搜索** | ✅ `WebSearch`（域名过滤） | ✅ `web_search`（cached/live） |
| **图片查看** | ✅ `Read`（多模态，统一） | ✅ `view_image`（专用） |
| **PDF 读取** | ✅ `Read`（页码范围） | ❌ |
| **Notebook 编辑** | ✅ `NotebookEdit` | ❌ |
| **Notebook 读取** | ✅ `Read`（.ipynb） | ❌ |
| **JavaScript REPL** | ❌ | 🧪 `js_repl` + `js_repl_reset` |
| **任务/计划管理** | ✅ `TaskCreate/Update/List/Get`（依赖、负责人） | ✅ `update_plan`（更简单） |
| **Plan Mode** | ✅ `EnterPlanMode/ExitPlanMode` | ⚠️ 基于 prompt，无结构化审批 |
| **用户交互** | ✅ `AskUserQuestion`（结构化 UI） | ✅ `request_user_input`（多选） |
| **Sub-Agent 生成** | ✅ `Task`（10+ 类型，可恢复） | 🧪 `spawn_agent`（实验性） |
| **Agent 生命周期** | ✅ `Task`（通过 ID 恢复） | 🧪 `send_input`、`resume_agent`、`wait`、`close_agent` |
| **团队协作** | ✅ `TeamCreate/Delete` + `SendMessage` | ❌ |
| **Skill/插件系统** | ✅ `Skill`（工具调用） | ⚠️ Skills（通过 SKILL.md 的 prompt 模板） |
| **MCP 资源** | ⚠️ 通过 MCP 工具 | ✅ `list_mcp_resources`、`read_mcp_resource` |
| **会话分叉** | ❌ | ✅ `/fork` 命令 |

---

## 4. 共有工具——详细对比

### 4.1 文件读取

| 维度 | Claude Code `Read` | Codex CLI `read_file` |
|------|--------------------|-----------------------|
| **状态** | 稳定，自动批准 | 实验性（feature-gated） |
| **参数** | `file_path`（string，必填）、`offset`（number）、`limit`（number）、`pages`（string） | `file_path`（string，必填）、`offset`（number）、`limit`（number）、`mode`（string）、`indentation`（object） |
| **默认行为** | 从文件开头读取最多 2000 行 | 以 1-indexed 行号读取文件内容 |
| **截断策略** | 超过 2000 字符的行会被截断；可通过 `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` 配置（默认约 25k tokens） | 工具输出限制约 10k tokens |
| **读取模式** | 单一模式（基于行的切片） | **两种模式**：`"slice"`（默认）和 `"indentation"` |
| **缩进模式（Indentation Mode）** | ❌ | ✅ 块级感知读取：`anchor_line`、`max_levels`、`include_siblings`、`include_header`、`max_lines` |
| **PDF 支持** | ✅（每次最多 20 页，超 10 页须指定页码） | ❌ |
| **图片支持** | ✅（PNG、JPG——多模态，统一在 Read 中） | ❌（需使用独立的 `view_image`） |
| **Jupyter 支持** | ✅（渲染所有 cell 及输出） | ❌ |
| **部分读取** | ✅ `offset` + `limit` | ✅ `offset` + `limit` |
| **权限** | 自动批准（只读分类） | 取决于沙箱模式 |

**核心差异：**
- Claude Code 的 `Read` 是瑞士军刀：PDF、图片、Notebook、截图一站式
- Codex 的 `read_file` 拥有**独特的"缩进模式"**——可按结构缩进层级提取函数/类体（Claude Code 无对应功能）
- Claude Code 强制执行"先读后写"模式（Edit/Write 未先读取文件会失败）
- Codex 的 `read_file` 仍处于实验/feature-gated 阶段

### 4.2 文件编辑

| 维度 | Claude Code `Edit` / `MultiEdit` | Codex CLI `apply_patch` |
|------|----------------------------------|------------------------|
| **方式** | 精确字符串替换 | 统一 diff 风格补丁（自定义格式） |
| **参数** | `file_path`、`old_string`、`new_string`、`replace_all` | 单个结构化格式的 `patch` 字符串 |
| **多文件** | ❌ 每次调用一个文件（但 `MultiEdit` 可批量编辑同一文件） | ✅ 一个 patch 可包含多个文件 |
| **创建文件** | ❌（需用 `Write`） | ✅ `*** Add File:` 操作 |
| **删除文件** | ❌（需用 `Bash rm`） | ✅ `*** Delete File:` 操作 |
| **重命名/移动** | ❌（需用 `Bash mv`） | ✅ `*** Move to:` 操作 |
| **定位机制** | `old_string` 必须唯一，或使用 `replace_all` | 上下文行（前后各 3 行）+ `@@` 头部 |
| **路径类型** | 必须使用绝对路径 | 必须使用相对路径（绝不能用绝对路径） |
| **前置条件** | 必须先 `Read` 文件（强制执行） | 无前置条件 |
| **批量替换** | ✅ `replace_all: true` | ❌ 需在不同 hunk 中逐一列出 |
| **原子批量编辑** | ✅ `MultiEdit`——单文件全有或全无 | ✅ 整个 patch 是原子的 |
| **格式复杂度** | 简单（只是字符串） | 复杂（自定义 diff 语法） |

**Patch 格式语法（Codex）：**
```
Patch     := "*** Begin Patch" { FileOp } "*** End Patch"
FileOp    := AddFile | DeleteFile | UpdateFile
AddFile   := "*** Add File: " path { "+" line }
DeleteFile:= "*** Delete File: " path
UpdateFile:= "*** Update File: " path [ "*** Move to: " newPath ] { Hunk }
Hunk      := "@@" [ context_header ] { (" " | "-" | "+") line }
```

### 4.3 文件写入/创建

| 维度 | Claude Code `Write` | Codex CLI（通过 `apply_patch`） |
|------|---------------------|-------------------------------|
| **参数** | `file_path`（string）、`content`（string） | 嵌入 patch 中：`*** Add File: path` |
| **行为** | 覆写整个文件 | 逐行添加新文件（每行前缀 `+`） |
| **前置条件** | 编辑已有文件时须先 `Read`（强制执行） | 无前置条件 |
| **新建文件** | ✅ 文件不存在时自动创建（含父目录） | ✅ `*** Add File:` |
| **覆写** | ✅ 直接全量替换 | ⚠️ 需先 `*** Delete File:` 再 `*** Add File:` |

### 4.4 Shell 执行

| 维度 | Claude Code `Bash` | Codex CLI `shell` / `shell_command` |
|------|--------------------|------------------------------------|
| **命令参数** | `command`（string，必填） | `command`（string 或 array，必填） |
| **工作目录** | 跨调用持久化（隐式） | 每次调用通过 `workdir` 参数指定（显式） |
| **超时** | `timeout`（number，最大 600,000ms，默认 120,000ms） | `timeout_ms`（number） |
| **描述/理由** | `description`（string，可选元数据） | `justification`（string，仅在权限提升时使用） |
| **后台执行** | ✅ `run_in_background`（boolean）；Ctrl+B 可将运行中命令转后台 | ❌（需用 `exec_command`） |
| **沙箱绕过** | `dangerouslyDisableSandbox`（boolean） | `with_escalated_permissions`（boolean） |
| **输出限制** | 30,000 字符（可通过 `BASH_MAX_OUTPUT_LENGTH` 配置） | 约 10,000 tokens（可通过 `tool_output_token_limit` 配置） |
| **Shell 状态** | 工作目录持久化，Shell 状态每次重置 | 每次调用独立，无状态 |
| **权限提升** | ❌（沙箱绕过是全有或全无） | ✅ `with_escalated_permissions`（逐命令） |
| **Login Shell** | ❌ | ✅ `login` 参数 |

**Claude Code Bash 环境变量：**
| 变量 | 说明 |
|------|------|
| `BASH_DEFAULT_TIMEOUT_MS` | 默认超时 |
| `BASH_MAX_OUTPUT_LENGTH` | 截断前最大字符数 |
| `BASH_MAX_TIMEOUT_MS` | 模型可设置的最大超时 |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | 每次命令后返回原始目录 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 禁用后台任务 |

### 4.5 交互式 Shell / 长时间运行进程

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| **工具** | `Bash` + `run_in_background: true` | `exec_command` + `write_stdin` |
| **方式** | 单一工具的后台模式 | 两个专用工具（基于 PTY） |
| **stdin 支持** | ❌ 无法向运行中的进程写入 | ✅ `write_stdin` 可向 PTY 发送按键 |
| **流式输出** | 通过 `TaskOutput` 工具轮询 | 通过 `yield_time_ms` 内置流式支持 |
| **REPL 支持** | ⚠️ 有限 | ✅ 完整 PTY 支持 |
| **会话管理** | 后台任务 ID；通过 `/tasks` 管理 | Session ID；`send_input`、`resume_agent` |

**Codex `exec_command` 参数：**
| 参数 | 类型 | 说明 |
|------|------|------|
| `cmd` | string | 要执行的命令 |
| `workdir` | string | 工作目录 |
| `shell` | string | 使用的 Shell |
| `login` | boolean | Login Shell |
| `tty` | boolean | 分配 TTY |
| `yield_time_ms` | number | 产出输出前等待时间 |
| `max_output_tokens` | number | 输出 token 限制 |
| `sandbox_permissions` | string | 沙箱级别 |
| `justification` | string | 执行理由 |

### 4.6 Web 搜索

| 维度 | Claude Code `WebSearch` | Codex CLI `web_search` |
|------|-------------------------|------------------------|
| **查询参数** | `query`（string，必填，显式） | 隐式（agent 上下文的一部分） |
| **域名过滤** | ✅ `allowed_domains`、`blocked_domains` | ❌ 无域名过滤 |
| **模式** | 单一模式（实时搜索） | `cached` / `live` / `disabled` |
| **缓存** | ❌ 无显式缓存 | ✅ `cached` 模式（OpenAI 预建索引） |
| **区域限制** | 仅限美国 | 无区域限制 |
| **输出** | `title` + `url`（精简；获取内容需使用 WebFetch） | 因模式而异 |

### 4.7 任务/计划管理

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| **工具** | `TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet` | `update_plan` |
| **粒度** | 完整 CRUD，支持依赖关系、负责人、阻塞 | 简单计划：步骤（每步 1-5 词）+ 状态 |
| **状态值** | `pending`、`in_progress`、`completed`、`deleted` | `pending`、`in_progress`、`completed` |
| **依赖关系** | ✅ `blocks` / `blockedBy` | ❌ |
| **所有权** | ✅ 可分配给不同 agent | ❌ |
| **团队共享** | ✅ 团队成员共享 | ❌ |
| **元数据** | ✅ 任意键值元数据 | ❌ |

### 4.8 用户交互

| 维度 | Claude Code `AskUserQuestion` | Codex CLI `request_user_input` |
|------|-------------------------------|-------------------------------|
| **结构** | 1-4 个问题，每个 2-4 个选项 | 带标签选项的多选 |
| **多选** | ✅ 每个问题可设 `multiSelect` | 未记录 |
| **标题** | ✅ 短标签（最多 12 字符） | 未记录 |
| **选项格式** | `label` + `description` | `label` + `description` |
| **自由文本** | ✅ 始终有"Other"选项 | 未记录 |

### 4.9 Sub-Agent 系统

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| **生成** | `Task` 工具（单一工具） | `spawn_agent`（实验性，Collab flag） |
| **Agent 类型** | 10+ 内置：`Bash`、`general-purpose`、`Explore`、`Plan`、自定义 agents | 可配置 `agent_type` |
| **通信** | 通过 `SendMessage`（DM、广播、关闭请求） | `send_input`（向 agent 发送消息） |
| **恢复** | ✅ 通过 agent ID 的 `resume` 参数 | ✅ `resume_agent`（按 ID） |
| **等待/同步** | 通过 `TaskOutput` 隐式等待 | ✅ `wait` 工具（等待 agent IDs + 超时） |
| **终止** | 通过 `SendMessage` shutdown_request | ✅ `close_agent`（按 ID） |
| **团队层** | ✅ `TeamCreate/Delete`，共享任务列表 | ❌ 无团队抽象 |
| **最大并发** | 最多 7 个同时运行的 agents | 未记录 |
| **模型选择** | ✅ 逐 agent 选择模型（opus/sonnet/haiku） | 未记录 |
| **嵌套** | ❌ Sub-agent 不能生成 sub-agent | 未记录 |
| **后台** | ✅ `run_in_background` | 未记录 |

**核心差异：** Claude Code 拥有更高层的团队抽象（TeamCreate、共享任务列表、带消息类型的 SendMessage）。Codex 拥有更细粒度的 agent 生命周期 API（5 个独立工具：spawn/send/resume/wait/close）。Claude Code 用更少但更强大的工具实现同样的功能。

### 4.10 图片查看

| 维度 | Claude Code | Codex CLI |
|------|-------------|-----------|
| **工具** | `Read`（统一——图片、PDF、Notebook、文本） | `view_image`（专用图片工具） |
| **参数** | `file_path`（string） | `path`（string） |
| **集成** | 与所有文件读取统一 | 独立工具 |
| **CLI 输入** | 读取截图路径 | `--image` / `-i` 标志 |

---

## 5. Claude Code 独有工具

以下工具仅存在于 Claude Code，Codex CLI **无对应实现**：

### 5.1 `Glob` — 文件模式匹配
```
Parameters:
  pattern: string (required) — glob pattern like "**/*.ts"
  path: string (optional) — directory to search in
Returns: matching file paths sorted by modification time
```
**Codex 缺失原因：** Codex 有实验性的 `list_dir`（支持深度）但无 glob 模式匹配。历史上依赖 shell 命令（`find`、`rg --files`）。特性请求：[Issue #4443](https://github.com/openai/codex/issues/4443)。

### 5.2 `Grep`（完整版）— 内容搜索
```
Parameters (12+):
  pattern, path, glob, type, output_mode ("content"|"files_with_matches"|"count"),
  context/-A/-B/-C, -i, -n, multiline, head_limit, offset
```
**Codex 对比：** 有实验性 `grep_files`，仅 4 个参数（`pattern`、`include`、`path`、`limit`）。无输出模式、无上下文行、无跨行匹配、无大小写敏感开关、无分页偏移。Claude Code 的 Grep **远比** Codex 的实验等价物强大。

### 5.3 `WebFetch` — URL 内容抓取 + AI 处理
```
Parameters:
  url: string/uri (required) — URL to fetch
  prompt: string (required) — what to extract from the content
Pipeline: URL 验证 → 域名安全检查 → 抓取 → HTML→Markdown（Turndown）
         → 截断至 100KB → 通过 Claude 3.5 Haiku 处理 → 返回摘要
```
**Codex 缺失原因：** 无对应实现。Codex 用户只能通过 shell 使用 `curl`——无 AI 处理的摘要。双阶段注入防御（Haiku 过滤）是 Claude Code 独有的。

### 5.4 `NotebookEdit` — Jupyter Notebook 编辑
```
Parameters:
  notebook_path: string (required), new_source: string (required)
  cell_id: string (optional), cell_type: "code"|"markdown" (optional)
  edit_mode: "replace"|"insert"|"delete" (optional)
```
**Codex 缺失原因：** 零 Jupyter 支持。Codex 用户只能通过 `apply_patch` 编辑原始 .ipynb JSON。

### 5.5 `MultiEdit` — 单文件原子批量编辑
在单个文件上批量执行多个查找替换操作，全有或全无的原子执行。
**Codex 缺失原因：** Codex 的 `apply_patch` 处理单文件多 hunk 编辑，但没有单独的原子批量工具。

### 5.6 `TeamCreate` / `TeamDelete` — 团队协调
创建具有共享任务列表、协调 agent 生命周期和 agent 间消息传递的团队。
**Codex 缺失原因：** Codex 有实验性 `spawn_agent` 但无具有共享任务列表的团队级抽象。

### 5.7 `SendMessage` — Agent 间消息传递协议
```
Types: "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response"
Parameters: recipient, content, summary, request_id, approve
```
**Codex 缺失原因：** Codex 有 `send_input` 向 agent 发消息，但无消息类型、无广播、无关闭协议、无计划审批流。

### 5.8 `EnterPlanMode` / `ExitPlanMode` — 结构化计划工作流
基于工具的 Plan Mode，包含文件支持的计划、结构化审批流和团队集成的计划审批。
**Codex 缺失原因：** Codex 有基于 prompt 的 Plan Mode，但无结构化的工具级审批流。

### 5.9 `Skill` — 插件调用系统
```
Parameters: skill (string, required), args (string, optional)
```
将注册的 Skills 作为工具调用。Skills 可发现、有描述、可编程调用。
**Codex 对比：** Codex 有 Skills（SKILL.md 文件），但作为注入上下文的 prompt 模板，而非工具调用。机制不同。

---

## 6. Codex CLI 独有工具

以下工具仅存在于 Codex CLI，Claude Code **无直接对应实现**：

### 6.1 `exec_command` + `write_stdin` — 基于 PTY 的交互式 Shell
```
exec_command params: cmd, workdir, shell, login, tty, yield_time_ms,
                     max_output_tokens, sandbox_permissions, justification
write_stdin params: session_id (required), chars, yield_time_ms, max_output_tokens
```
启动长时间运行的 PTY 进程；向 stdin 写入按键；轮询流式输出。
**Claude Code 缺口：** 后台 Bash 是"发射后不管"——可通过 `TaskOutput` 读取输出，但无法写入 stdin。

### 6.2 `js_repl` + `js_repl_reset` — 持久化 JavaScript REPL
```
js_repl: 在持久化 Node 内核中运行 JavaScript，支持顶层 await
js_repl_reset: 重启内核并清除所有绑定
```
**Claude Code 缺失原因：** Claude Code 无进程内 REPL。只能通过 `Bash` 运行 `node -e`（临时性，无状态）。

### 6.3 `list_dir` — 结构化目录列表
```
Parameters:
  dir_path: string (required) — 绝对路径
  offset: number (optional) — 条目起始位置（1-indexed）
  limit: number (optional) — 最大条目数
  depth: number (optional) — 最大目录遍历深度（≥1）
```
**Claude Code 缺口：** 无专用目录列表工具。使用 `Bash` + `ls` 或 `Glob` 模式。

### 6.4 `apply_patch` — 文件重命名/移动
```
*** Update File: old/path.ts
*** Move to: new/path.ts
```
**Claude Code 缺口：** 无专用重命名。须通过 `Bash` + `mv`。

### 6.5 `apply_patch` — 文件删除
```
*** Delete File: path/to/file
```
**Claude Code 缺口：** 无专用删除。须通过 `Bash` + `rm`。

### 6.6 `search_tool_bm25` — BM25 搜索
使用 BM25 排序算法搜索应用/工具。
**Claude Code 缺口：** 无对应实现。Claude Code 的 `Grep` 基于正则，而非相关性排序。

### 6.7 MCP 资源工具
```
list_mcp_resources — 列出 MCP 服务器的所有资源
list_mcp_resource_templates — 列出资源模板
read_mcp_resource — 按 URI 读取特定资源
```
**Claude Code 缺口：** 访问 MCP 工具但无专用工具浏览/读取 MCP 资源。

### 6.8 会话分叉（`/fork`）
将当前会话克隆到新线程中进行替代方案探索。
**Claude Code 缺口：** 无会话分叉。须启动新会话。

### 6.9 `read_file` 缩进模式（独特功能）
```
Parameters (indentation mode):
  mode: "indentation"
  indentation: {
    anchor_line: number (中心行)
    max_levels: number (要包含的父缩进层级)
    include_siblings: boolean (同缩进级别的块)
    include_header: boolean (上方的文档注释/属性)
    max_lines: number (硬上限)
  }
```
按结构缩进提取函数/类体——Claude Code 无对应功能。

### 6.10 Shell 权限提升
```
Parameter: with_escalated_permissions (boolean) + justification (string)
```
沙箱内逐命令提升权限。Claude Code 的 `dangerouslyDisableSandbox` 是全有或全无的。

---

## 7. 参数级别差异

### 7.1 Shell 工具参数

| 参数 | Claude Code `Bash` | Codex CLI `shell_command` |
|------|-------------------|--------------------------|
| 命令 | `command: string` | `command: string`（`shell` 中也可为 `string[]`） |
| 超时 | `timeout: number`（ms，最大 600000，默认 120000） | `timeout_ms: number` |
| 描述 | `description: string` | `justification: string`（仅在权限提升时） |
| 工作目录 | 隐式持久化 | `workdir: string`（每次显式指定） |
| 后台执行 | `run_in_background: boolean` | N/A（需用 `exec_command`） |
| 沙箱覆盖 | `dangerouslyDisableSandbox: boolean` | `with_escalated_permissions: boolean` |
| Login Shell | N/A | `login: boolean` |

### 7.2 文件读取参数

| 参数 | Claude Code `Read` | Codex CLI `read_file` |
|------|-------------------|----------------------|
| 路径 | `file_path: string`（绝对路径） | `file_path: string`（绝对路径） |
| 偏移量 | `offset: number`（基于行号） | `offset: number`（1-indexed） |
| 行数限制 | `limit: number`（行数） | `limit: number` |
| PDF 页码 | `pages: string`（如 "1-5"） | N/A |
| 读取模式 | N/A（始终基于行） | `mode: "slice" \| "indentation"` |
| 缩进参数 | N/A | `indentation: {anchor_line, max_levels, include_siblings, include_header, max_lines}` |

### 7.3 文件编辑参数

| 参数 | Claude Code `Edit` | Codex CLI `apply_patch` |
|------|-------------------|------------------------|
| 路径 | `file_path: string`（绝对路径） | 嵌入 patch 头部（相对路径） |
| 目标文本 | `old_string: string` | 上下文行 + `@@` 头部 |
| 替换内容 | `new_string: string` | `+`/`-` 前缀行（hunk 中） |
| 批量替换 | `replace_all: boolean` | N/A（逐一列出） |
| 多文件 | N/A（每次调用一个文件） | 多个 `*** Update File:` 块 |
| 创建文件 | N/A（用 Write） | 同一 patch 中的 `*** Add File:` |
| 删除文件 | N/A（用 Bash） | 同一 patch 中的 `*** Delete File:` |
| 重命名文件 | N/A（用 Bash） | 同一 patch 中的 `*** Move to:` |

### 7.4 内容搜索参数

| 参数 | Claude Code `Grep` | Codex CLI `grep_files` |
|------|-------------------|----------------------|
| 模式 | `pattern: string`（正则） | `pattern: string`（正则） |
| 路径 | `path: string` | `path: string` |
| 文件过滤 | `glob: string` + `type: string` | `include: string`（仅 glob） |
| 输出模式 | `"content"` / `"files_with_matches"` / `"count"` | 仅文件列表（按修改时间） |
| 上下文行 | `-A`、`-B`、`-C` / `context` | N/A |
| 大小写敏感 | `-i: boolean` | N/A |
| 行号 | `-n: boolean`（默认 true） | N/A |
| 跨行匹配 | `multiline: boolean` | N/A |
| 分页 | `head_limit` + `offset` | 仅 `limit`（默认 100） |

### 7.5 Web 搜索参数

| 参数 | Claude Code `WebSearch` | Codex CLI `web_search` |
|------|------------------------|------------------------|
| 查询 | `query: string`（必填，显式） | 隐式（agent 上下文） |
| 包含域名 | `allowed_domains: string[]` | N/A |
| 排除域名 | `blocked_domains: string[]` | N/A |
| 模式 | 始终实时 | `cached` / `live` / `disabled` |

### 7.6 Sub-Agent 参数

| 参数 | Claude Code `Task` | Codex CLI `spawn_agent` |
|------|-------------------|------------------------|
| 指令 | `prompt: string` | `message: string` 或 `items: array` |
| Agent 类型 | `subagent_type: string`（必填） | `agent_type: string`（可选） |
| 模型 | `model: "sonnet" \| "opus" \| "haiku"` | N/A |
| 权限 | `mode: string`（6 个选项） | N/A |
| 后台 | `run_in_background: boolean` | N/A |
| 恢复 | `resume: string`（agent ID） | 独立的 `resume_agent` 工具 |
| 团队 | `team_name: string` | N/A |
| 最大轮次 | `max_turns: integer` | N/A |

---

## 8. 权限与沙箱模型

### Claude Code

**权限模式：**
| 模式 | 说明 |
|------|------|
| **default** | 允许读取；其他操作前询问 |
| **acceptEdits** | 自动接受文件编辑；Shell 仍需确认 |
| **bypassPermissions** | 跳过所有权限检查（IT 可禁用） |
| **plan** | 只读探索；不允许编辑 |
| **dontAsk** | 不询问确认 |
| **delegate** | 将决策委托给 sub-agent |

**OS 级沙箱：**
- macOS：**Seatbelt** 配置文件（内核级，从 deny 规则生成）
- Linux：**Landlock + seccomp**（内核级）
- 开源运行时：`npx @anthropic-ai/sandbox-runtime <cmd>`
- 在内部使用中减少 **84%** 的权限提示

**沙箱细节：**
- 写权限：限制在 CWD 及子目录
- 读权限：整个文件系统（除显式拒绝的路径）
- 网络：通过 Unix 域套接字代理路由；域名级限制
- `dangerouslyDisableSandbox`：逐命令逃逸舱（需批准，除非已自动批准）
- 可配置：`excludedCommands`、`allowedDomains`、`allowUnixSockets`

**规则评估顺序：** deny → ask → allow（首次匹配生效）

**配置优先级：**
1. Managed（IT 部署，最高）
2. CLI 参数
3. 本地项目（`.claude/settings.local.json`）
4. 项目（`.claude/settings.json`）
5. 用户（`~/.claude/settings.json`，最低）

### Codex CLI

**审批策略：**
| 策略 | 说明 |
|------|------|
| **untrusted** | 最大谨慎；仅自动运行已知安全的读操作 |
| **on-failure** | 仅在错误后提示 |
| **on-request** | 对重大操作提示（默认） |
| **never** | 无审批提示 |

**沙箱模式：**
| 模式 | 说明 |
|------|------|
| `read-only` | 任何地方都不可写 |
| `workspace-write` | 仅可写工作区 + /tmp |
| `danger-full-access` | 不受限的文件系统 + 网络访问 |

**OS 级沙箱：**
- macOS：**Seatbelt** 通过 `sandbox-exec`（模式特定配置文件）
- Linux：**Landlock + seccomp**（默认）；可选 **Bubblewrap**（`bwrap`）
- Windows：实验性受限令牌沙箱
- Docker：需单独配置；容器内可用 `enableWeakerNestedSandbox`

**智能默认值：**
- 版本控制文件夹 → `workspace-write` + `on-request`
- 非版本控制 → `read-only`
- 网络 → 默认禁用
- CLI 快捷方式：`--full-auto` = `on-request` + `workspace-write`

**核心对比：**
| 特性 | Claude Code | Codex CLI |
|------|-------------|-----------|
| OS 沙箱 | ✅ Seatbelt / Landlock+seccomp | ✅ Seatbelt / Landlock+seccomp / Bwrap |
| 网络隔离 | 域名级代理 | 防火墙（沙箱中仅允许 OpenAI API） |
| 逐命令提升 | ❌（全有或全无） | ✅ `with_escalated_permissions` |
| 智能默认值 | 手动配置 | 自动检测 git 仓库 |
| 权限规则语法 | gitignore 风格模式 | 配置文件 + CLI 标志 |
| 开源沙箱 | ✅ `@anthropic-ai/sandbox-runtime` | ✅ 完整源码在 `codex-rs/` |

---

## 9. 核心结论

### Claude Code 的优势
1. **更成熟的专用工具** — 稳定的 `Glob`、`Grep`（12+ 参数）、`Read`（PDF/图片/Notebook）、`Edit`、`Write`，相比 Codex 的实验性等价物
2. **WebFetch + AI 处理** — 双阶段管线（抓取 → Haiku 摘要）+ 注入防御；Codex 无对应功能
3. **团队编排** — 完整团队抽象（`TeamCreate`、共享任务列表、带 5 种消息类型的 `SendMessage`）；Codex 有 agent 生成但无团队层
4. **更丰富的任务管理** — 完整 CRUD + 依赖、所有权、阻塞，对比 Codex 的简单步骤列表
5. **结构化 Plan Mode** — 基于工具的计划工作流，文件支持的计划和审批流
6. **Jupyter Notebook 支持** — 读取和编辑（.ipynb）；Codex 两者都不支持
7. **PDF 读取** — 页码范围支持；Codex 无法读取 PDF
8. **内容搜索深度** — `Grep` 有 12+ 参数（输出模式、上下文行、跨行、分页），对比 Codex 的 4 参数 `grep_files`

### Codex CLI 的优势
1. **统一文件操作** — `apply_patch` 一个原子工具搞定创建 + 编辑 + 删除 + 重命名；多文件补丁
2. **更强的交互式 Shell** — `exec_command` + `write_stdin` 实现真正的 PTY + stdin 支持和流式输出
3. **JavaScript REPL** — 持久化 `js_repl` + 顶层 await；Claude Code 无对应功能
4. **缩进感知文件读取** — `read_file` 缩进模式按结构嵌套提取代码块
5. **缓存 Web 搜索** — 离线/沙箱环境下的预建索引结果
6. **会话分叉** — `/fork` 分支会话进行替代方案探索
7. **逐命令权限提升** — 细粒度 `with_escalated_permissions`，相比全有或全无
8. **细粒度 Agent 生命周期** — 5 个独立工具（spawn/send/resume/wait/close）实现精细 agent 控制
9. **MCP 资源浏览** — 专用工具列出和读取 MCP 资源
10. **Rust 性能** — 核心用 Rust 编写，速度更快

### 设计哲学

| | Claude Code | Codex CLI |
|-|-------------|-----------|
| **工具设计** | 大量参数丰富的专用工具 | 较少工具，正朝专用化演进 |
| **文件编辑** | 字符串匹配（简单、显式） | Diff/Patch 格式（强大、复杂） |
| **Agent 模型** | 团队导向（共享状态、消息传递） | Agent 导向（生命周期管理） |
| **沙箱** | OS 级 + 权限提示 | OS 级 + 审批策略 + 智能默认值 |
| **扩展** | Skills（工具调用）+ Hooks + MCP | Skills（prompt 模板）+ MCP + feature flags |
| **成熟度** | 大多数工具稳定且经过实战检验 | 许多工具处于实验/feature-gated 阶段 |

---

## 参考来源

### Claude Code
- [Claude Code 官方文档](https://code.claude.com/docs)
- [Claude Code 权限](https://code.claude.com/docs/en/permissions)
- [Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing)
- [Anthropic 工程博客：Claude Code 沙箱](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Claude Code 内部实现（Kir Shatrov）](https://kirshatrov.com/posts/claude-code-internals)
- [Claude Code 工具参考（vtrivedy）](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [系统 Prompt 提取（wong2）](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [沙箱运行时源码](https://github.com/anthropic-experimental/sandbox-runtime)

### Codex CLI
- [Codex CLI 官方文档](https://developers.openai.com/codex/cli/)
- [Codex CLI 功能特性](https://developers.openai.com/codex/cli/features/)
- [Codex CLI 命令参考](https://developers.openai.com/codex/cli/reference/)
- [Codex 配置参考](https://developers.openai.com/codex/config-reference/)
- [Codex 安全](https://developers.openai.com/codex/security/)
- [Codex 模型](https://developers.openai.com/codex/models/)
- [Codex GitHub 仓库](https://github.com/openai/codex)
- [Codex 工具定义（spec.rs）](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec.rs)
- [Codex apply_patch 说明](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md)
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)

### 对比文章
- [DeepWiki: Codex 工具系统](https://deepwiki.com/openai/codex/6-node.js-implementation-(codex-cli))
- [Claude Code vs Codex（Builder.io）](https://www.builder.io/blog/codex-vs-claude-code)
- [Claude Code vs Codex（Composio）](https://composio.dev/blog/claude-code-vs-openai-codex)
- [Claude Code vs Codex（Graphite）](https://graphite.com/guides/claude-code-vs-codex)
