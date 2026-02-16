# Claude Code vs Codex CLI: Built-in Tools Comparison

> **Research Date**: 2026-02-16
> **Scope**: Complete comparison of built-in tools between Claude Code (Anthropic) and Codex CLI (OpenAI)
> **Sources**: Official docs, GitHub repos (`anthropics/claude-code`, `openai/codex`), source code analysis, community research
> **Method**: 10 parallel research agents covering every aspect of both tool systems

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Complete Tool Inventory](#2-complete-tool-inventory)
3. [Tool-by-Tool Comparison Matrix](#3-tool-by-tool-comparison-matrix)
4. [Shared Tools — Detailed Comparison](#4-shared-tools--detailed-comparison)
5. [Claude Code-Only Tools](#5-claude-code-only-tools)
6. [Codex CLI-Only Tools](#6-codex-cli-only-tools)
7. [Parameter-Level Differences](#7-parameter-level-differences)
8. [Permission & Sandbox Models](#8-permission--sandbox-models)
9. [Key Takeaways](#9-key-takeaways)

---

## 1. Architecture Overview

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| **Language** | TypeScript/Node.js | Rust (96%) + TypeScript |
| **Model** | Claude Opus 4.6 / Sonnet 4.5 / Haiku 4.5 | GPT-5.x-codex series (default: gpt-5.3-codex) |
| **Tool Count** | ~16 internal tools + team/task tools | ~25+ tools (many feature-gated/experimental) |
| **Tool Paradigm** | Many specialized, fine-grained tools | Historically shell-centric; evolving toward dedicated tools |
| **File Editing** | Exact string replacement (`Edit`/`MultiEdit`) + overwrite (`Write`) | Unified diff patches (`apply_patch`) |
| **Shell** | Dedicated `Bash` tool with rich metadata | `shell`/`shell_command` + `exec_command`/`write_stdin` (PTY) |
| **Search** | Dedicated `Glob` + `Grep` (ripgrep-based) | Experimental `grep_files` + `list_dir`; historically shell-only |
| **Web Access** | Built-in `WebFetch` + `WebSearch` | Built-in `web_search` (cached/live modes) |
| **Multi-Agent** | Full team system (`Task`, `TeamCreate`, `SendMessage`) | Experimental `spawn_agent`/`send_input`/`resume_agent`/`wait`/`close_agent` |
| **MCP Support** | Full MCP client + server (multi-transport) | stdio-based MCP client (no HTTP); can run AS MCP server |
| **Extension Model** | Skills, Hooks, MCP servers, custom agents | MCP servers, Skills (SKILL.md), custom tools via config, feature flags |
| **Sandbox** | OS-level: Seatbelt (macOS), Landlock+seccomp (Linux) | OS-level: Seatbelt (macOS), Landlock+seccomp (Linux), Docker option |

---

## 2. Complete Tool Inventory

### Claude Code (~16+ tools)

| Category | Tools |
|----------|-------|
| **File I/O** | `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` |
| **Search** | `Glob`, `Grep` |
| **Shell** | `Bash` (includes background mode + `TaskOutput`) |
| **Web** | `WebFetch`, `WebSearch` |
| **Agent/Team** | `Task` (subagent spawning), `TeamCreate`, `TeamDelete`, `SendMessage` |
| **Task Mgmt** | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` |
| **UX** | `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Skill` |

### Codex CLI (~25+ tools, many feature-gated)

| Category | Tools | Status |
|----------|-------|--------|
| **Shell** | `shell`, `shell_command` | Stable |
| **Interactive Shell** | `exec_command`, `write_stdin` | Beta (unified exec) |
| **File Editing** | `apply_patch` (freeform + JSON variants) | Stable (freeform: experimental) |
| **File I/O** | `read_file`, `list_dir` | Experimental (feature-gated) |
| **Search** | `grep_files`, `search_tool_bm25` | Experimental (feature-gated) |
| **Web** | `web_search` | Stable |
| **Agent** | `spawn_agent`, `send_input`, `resume_agent`, `wait`, `close_agent` | Experimental (Collab feature flag) |
| **Image** | `view_image` | Stable |
| **JavaScript** | `js_repl`, `js_repl_reset` | Experimental (JsRepl feature flag) |
| **UX** | `request_user_input`, `update_plan` | Stable |
| **MCP** | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | Stable |
| **Skills** | `$skill-creator`, `$skill-installer` | System-level |

---

## 3. Tool-by-Tool Comparison Matrix

### Legend
- ✅ Has dedicated tool (stable)
- 🧪 Experimental / feature-gated
- ⚠️ Partially available / via different mechanism
- ❌ Not available

| Capability | Claude Code | Codex CLI |
|------------|------------|-----------|
| **File Reading** | ✅ `Read` (PDF, images, notebooks, partial) | 🧪 `read_file` (with unique indentation mode) |
| **File Writing** | ✅ `Write` | ⚠️ Via `apply_patch` (Add File) |
| **File Editing** | ✅ `Edit` + `MultiEdit` | ✅ `apply_patch` (Update File) |
| **File Deletion** | ⚠️ Via `Bash` (`rm`) | ✅ `apply_patch` (Delete File) |
| **File Rename/Move** | ⚠️ Via `Bash` (`mv`) | ✅ `apply_patch` (`*** Move to:`) |
| **Dir Listing** | ⚠️ Via `Bash` (`ls`) | 🧪 `list_dir` (with depth) |
| **Shell Execution** | ✅ `Bash` | ✅ `shell` / `shell_command` |
| **Interactive Shell** | ⚠️ Via `Bash` background | ✅ `exec_command` + `write_stdin` |
| **File Search (glob)** | ✅ `Glob` | ❌ (uses shell; `list_dir` is experimental) |
| **Content Search (grep)** | ✅ `Grep` (12+ params) | 🧪 `grep_files` (4 params) |
| **Web Fetch** | ✅ `WebFetch` (AI-processed) | ❌ |
| **Web Search** | ✅ `WebSearch` (domain filtering) | ✅ `web_search` (cached/live) |
| **Image Viewing** | ✅ `Read` (multimodal, unified) | ✅ `view_image` (dedicated) |
| **PDF Reading** | ✅ `Read` (page ranges) | ❌ |
| **Notebook Editing** | ✅ `NotebookEdit` | ❌ |
| **Notebook Reading** | ✅ `Read` (.ipynb) | ❌ |
| **JavaScript REPL** | ❌ | 🧪 `js_repl` + `js_repl_reset` |
| **Task/Plan Mgmt** | ✅ `TaskCreate/Update/List/Get` (deps, owners) | ✅ `update_plan` (simpler) |
| **Plan Mode** | ✅ `EnterPlanMode/ExitPlanMode` | ⚠️ Prompt-based, no structured approval |
| **User Interaction** | ✅ `AskUserQuestion` (structured UI) | ✅ `request_user_input` (multiple-choice) |
| **Sub-Agent Spawning** | ✅ `Task` (10+ types, resumable) | 🧪 `spawn_agent` (experimental) |
| **Agent Lifecycle** | ✅ `Task` (resume via ID) | 🧪 `send_input`, `resume_agent`, `wait`, `close_agent` |
| **Team Coordination** | ✅ `TeamCreate/Delete` + `SendMessage` | ❌ |
| **Skill/Plugin System** | ✅ `Skill` (tool invocation) | ⚠️ Skills (prompt templates via SKILL.md) |
| **MCP Resources** | ⚠️ Via MCP tools | ✅ `list_mcp_resources`, `read_mcp_resource` |
| **Conversation Fork** | ❌ | ✅ `/fork` command |

---

## 4. Shared Tools — Detailed Comparison

### 4.1 File Reading

| Aspect | Claude Code `Read` | Codex CLI `read_file` |
|--------|--------------------|-----------------------|
| **Status** | Stable, auto-approved | Experimental (feature-gated) |
| **Parameters** | `file_path` (string, required), `offset` (number), `limit` (number), `pages` (string) | `file_path` (string, required), `offset` (number), `limit` (number), `mode` (string), `indentation` (object) |
| **Default behavior** | Reads up to 2000 lines from start | Reads file contents with 1-indexed line numbers |
| **Line numbers** | Returns with `cat -n` format (numbered) | Returns with 1-indexed line numbers |
| **Truncation** | Lines >2000 chars truncated; configurable via `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` (~25k tokens default) | Tool output capped at ~10k tokens |
| **Read modes** | Single mode (line-based slice) | **Two modes**: `"slice"` (default) and `"indentation"` |
| **Indentation mode** | ❌ | ✅ Block-aware reading: `anchor_line`, `max_levels`, `include_siblings`, `include_header`, `max_lines` |
| **PDF support** | ✅ (max 20 pages/request, must specify pages for >10 pages) | ❌ |
| **Image support** | ✅ (PNG, JPG — multimodal, unified in Read) | ❌ (separate `view_image` tool) |
| **Jupyter support** | ✅ (renders all cells with outputs) | ❌ |
| **Partial read** | ✅ `offset` + `limit` | ✅ `offset` + `limit` |
| **Path type** | Absolute paths required | Absolute paths |
| **Permission** | Auto-approved (read-only classification) | Depends on sandbox mode |
| **Empty file** | Returns system reminder warning | Not documented |
| **Parallel reads** | Encouraged by system prompt | Not specifically documented |

**Key Differences:**
- Claude Code's `Read` is a swiss-army-knife: PDF, images, notebooks, screenshots
- Codex's `read_file` has a **unique "indentation mode"** — can extract a function/class body by structural indentation levels (no equivalent in Claude Code)
- Claude Code enforces a "read-before-write" pattern (Edit/Write fail if file not read first)
- Codex's `read_file` is still experimental/feature-gated

### 4.2 File Editing

| Aspect | Claude Code `Edit` / `MultiEdit` | Codex CLI `apply_patch` |
|--------|----------------------------------|------------------------|
| **Approach** | Exact string replacement | Unified diff-style patches (custom format) |
| **Parameters** | `file_path`, `old_string`, `new_string`, `replace_all` | Single `patch` string in structured format |
| **Multi-file** | ❌ One file per call (but `MultiEdit` batches edits on same file) | ✅ Multiple files in one patch |
| **Create files** | ❌ (use `Write`) | ✅ `*** Add File:` operation |
| **Delete files** | ❌ (use `Bash rm`) | ✅ `*** Delete File:` operation |
| **Rename/move** | ❌ (use `Bash mv`) | ✅ `*** Move to:` operation |
| **Matching** | `old_string` must be unique OR use `replace_all` | Context lines (3 above/below) + `@@` headers |
| **Path type** | Absolute paths required | Relative paths required (NEVER absolute) |
| **Prerequisite** | Must `Read` file first (enforced) | No prerequisite |
| **Bulk replace** | ✅ `replace_all: true` | ❌ Must list each occurrence in separate hunks |
| **Atomic multi-edit** | ✅ `MultiEdit` — all-or-nothing on single file | ✅ Entire patch is atomic |
| **Format complexity** | Simple (just strings) | Complex (custom diff grammar) |

**Patch Format Grammar (Codex):**
```
Patch     := "*** Begin Patch" { FileOp } "*** End Patch"
FileOp    := AddFile | DeleteFile | UpdateFile
AddFile   := "*** Add File: " path { "+" line }
DeleteFile:= "*** Delete File: " path
UpdateFile:= "*** Update File: " path [ "*** Move to: " newPath ] { Hunk }
Hunk      := "@@" [ context_header ] { (" " | "-" | "+") line }
```

### 4.3 File Writing / Creation

| Aspect | Claude Code `Write` | Codex CLI (via `apply_patch`) |
|--------|---------------------|-------------------------------|
| **Parameters** | `file_path` (string), `content` (string) | Embedded in patch: `*** Add File: path` |
| **Behavior** | Overwrites entire file | Adds new file line by line (each prefixed with `+`) |
| **Prerequisite** | Must `Read` existing file first (enforced) | No prerequisite |
| **New file** | ✅ Creates if doesn't exist (incl. parent dirs) | ✅ `*** Add File:` |
| **Overwrite** | ✅ Full content replacement | ⚠️ Must `*** Delete File:` then `*** Add File:` |

### 4.4 Shell Execution

| Aspect | Claude Code `Bash` | Codex CLI `shell` / `shell_command` |
|--------|--------------------|------------------------------------|
| **Command param** | `command` (string, required) | `command` (string or array, required) |
| **Working directory** | Persists across calls (implicit) | `workdir` parameter per call (explicit) |
| **Timeout** | `timeout` (number, max 600,000ms, default 120,000ms) | `timeout_ms` (number) |
| **Description** | `description` (string, optional metadata) | `justification` (string, only with escalated perms) |
| **Background exec** | ✅ `run_in_background` (boolean); Ctrl+B to background running cmd | ❌ (use `exec_command` instead) |
| **Sandbox bypass** | `dangerouslyDisableSandbox` (boolean) | `with_escalated_permissions` (boolean) |
| **Output limit** | 30,000 chars (configurable via `BASH_MAX_OUTPUT_LENGTH`) | ~10,000 tokens (configurable via `tool_output_token_limit`) |
| **Shell state** | Working dir persists, shell state resets each call | Per-call, stateless |
| **Permission escalation** | ❌ (sandbox bypass is all-or-nothing) | ✅ `with_escalated_permissions` (per-command) |
| **Login shell** | ❌ | ✅ `login` parameter |
| **Shell init** | From user's profile (bash or zsh) | Configurable shell |
| **Security** | MCP-based shell tool intercepts `execve(2)` for Codex | Seatbelt/Landlock enforcement |
| **Interactive** | ❌ No vim/less/nano/password prompts | ❌ Same limitation for `shell_command` |

**Environment Variables (Claude Code Bash):**
| Variable | Description |
|----------|-------------|
| `BASH_DEFAULT_TIMEOUT_MS` | Default timeout |
| `BASH_MAX_OUTPUT_LENGTH` | Max chars before truncation |
| `BASH_MAX_TIMEOUT_MS` | Maximum timeout the model can set |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` | Return to original dir after each command |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disable background tasks |

### 4.5 Interactive Shell / Long-Running Processes

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| **Tool** | `Bash` with `run_in_background: true` | `exec_command` + `write_stdin` |
| **Approach** | Single tool, background mode | Two dedicated tools (PTY-based) |
| **Stdin support** | ❌ Cannot write to running process | ✅ `write_stdin` sends keystrokes to PTY |
| **Streaming output** | Poll via `TaskOutput` tool | Built-in streaming via `yield_time_ms` |
| **REPL support** | ⚠️ Limited | ✅ Full PTY support |
| **Session management** | Background task ID; manage via `/tasks` | Session ID; `send_input`, `resume_agent` |

**Codex `exec_command` Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `cmd` | string | Command to execute |
| `workdir` | string | Working directory |
| `shell` | string | Shell to use |
| `login` | boolean | Login shell |
| `tty` | boolean | Allocate TTY |
| `yield_time_ms` | number | Time before yielding output |
| `max_output_tokens` | number | Output token limit |
| `sandbox_permissions` | string | Sandbox level |
| `justification` | string | Reason for execution |

### 4.6 Web Search

| Aspect | Claude Code `WebSearch` | Codex CLI `web_search` |
|--------|-------------------------|------------------------|
| **Query parameter** | `query` (string, required) | Implicit (part of agent context) |
| **Domain filtering** | ✅ `allowed_domains`, `blocked_domains` | ❌ No domain filtering |
| **Modes** | Single mode (live search) | `cached` / `live` / `disabled` |
| **Cache** | ❌ No explicit cache | ✅ `cached` mode (pre-indexed by OpenAI) |
| **Region** | US only | Not region-restricted |
| **Output** | `title` + `url` (minimal; use WebFetch for content) | Varies by mode |
| **Configuration** | Always available | Configurable in `config.toml` |
| **Multi-search** | Model can execute multiple per turn | Model can execute multiple per turn |

### 4.7 Task / Plan Management

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| **Tools** | `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | `update_plan` |
| **Granularity** | Full CRUD with dependencies, owners, blocking | Simple plan with steps (1-5 words each) and status |
| **Status values** | `pending`, `in_progress`, `completed`, `deleted` | `pending`, `in_progress`, `completed` |
| **Dependencies** | ✅ `blocks` / `blockedBy` | ❌ |
| **Ownership** | ✅ Assignable to agents | ❌ |
| **Team sharing** | ✅ Shared across team members | ❌ |
| **Metadata** | ✅ Arbitrary key-value metadata | ❌ |

### 4.8 User Interaction

| Aspect | Claude Code `AskUserQuestion` | Codex CLI `request_user_input` |
|--------|-------------------------------|-------------------------------|
| **Structure** | 1-4 questions, each with 2-4 options | Multiple-choice with labeled options |
| **Multi-select** | ✅ `multiSelect` boolean per question | Not documented |
| **Header** | ✅ Short label (max 12 chars) | Not documented |
| **Option format** | `label` + `description` | `label` + `description` |
| **Free text** | ✅ "Other" option always available | Not documented |

### 4.9 Sub-Agent Systems

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| **Spawn** | `Task` tool (single tool) | `spawn_agent` (experimental, Collab flag) |
| **Agent types** | 10+ built-in: `Bash`, `general-purpose`, `Explore`, `Plan`, custom agents | Configurable `agent_type` |
| **Communication** | Via `SendMessage` (DM, broadcast, shutdown) | `send_input` (send message to agent) |
| **Resume** | ✅ `resume` parameter with agent ID | ✅ `resume_agent` (by ID) |
| **Wait/sync** | Implicit via `TaskOutput` | ✅ `wait` tool (wait for agent IDs + timeout) |
| **Terminate** | Via `SendMessage` shutdown_request | ✅ `close_agent` (by ID) |
| **Team layer** | ✅ `TeamCreate/Delete`, shared task lists | ❌ No team abstraction |
| **Max concurrent** | Up to 7 simultaneous agents | Not documented |
| **Model selection** | ✅ Per-agent model choice (opus/sonnet/haiku) | Not documented |
| **Nesting** | ❌ Subagents cannot spawn subagents | Not documented |
| **Background** | ✅ `run_in_background` | Not documented |
| **Status** | Experimental but widely used | Experimental (feature-gated) |

**Key Difference:** Claude Code has a higher-level team abstraction (TeamCreate, shared task lists, SendMessage with message types). Codex has a more granular agent lifecycle API (5 separate tools for spawn/send/resume/wait/close). Claude Code bundles it into fewer, more powerful tools.

### 4.10 Image Viewing

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| **Tool** | `Read` (unified — images, PDFs, notebooks, text) | `view_image` (dedicated image-only tool) |
| **Parameter** | `file_path` (string) | `path` (string) |
| **Integration** | Unified with all file reading | Separate tool |
| **CLI input** | Read a screenshot path | `--image` / `-i` flag for CLI input |

---

## 5. Claude Code-Only Tools

These tools exist in Claude Code but have **no equivalent** in Codex CLI:

### 5.1 `Glob` — File Pattern Matching
```
Parameters:
  pattern: string (required) — glob pattern like "**/*.ts"
  path: string (optional) — directory to search in
Returns: matching file paths sorted by modification time
```
**Why Codex lacks this:** Codex has experimental `list_dir` (with depth) but no glob pattern matching. Historically relies on shell commands (`find`, `rg --files`). Feature request: [Issue #4443](https://github.com/openai/codex/issues/4443).

### 5.2 `Grep` (full-featured) — Content Search
```
Parameters (12+):
  pattern, path, glob, type, output_mode ("content"|"files_with_matches"|"count"),
  context/-A/-B/-C, -i, -n, multiline, head_limit, offset
```
**Codex comparison:** Has experimental `grep_files` with only 4 params (`pattern`, `include`, `path`, `limit`). No output modes, no context lines, no multiline, no case sensitivity toggle, no pagination offset. Claude Code's Grep is **far more capable** than Codex's experimental equivalent.

### 5.3 `WebFetch` — URL Content Fetching + AI Processing
```
Parameters:
  url: string/uri (required) — URL to fetch
  prompt: string (required) — what to extract from the content
Pipeline: URL validation → domain safety check → fetch → HTML→Markdown (Turndown)
         → truncate to 100KB → process via Claude 3.5 Haiku → return summary
```
**Why Codex lacks this:** No equivalent. Codex users must use `curl` via shell — no AI-processed summaries. Two-stage injection defense (Haiku filtering) is unique to Claude Code.

### 5.4 `NotebookEdit` — Jupyter Notebook Editing
```
Parameters:
  notebook_path: string (required), new_source: string (required)
  cell_id: string (optional), cell_type: "code"|"markdown" (optional)
  edit_mode: "replace"|"insert"|"delete" (optional)
```
**Why Codex lacks this:** Zero Jupyter support. Codex users must edit raw .ipynb JSON via `apply_patch`.

### 5.5 `MultiEdit` — Atomic Batch Edits on Single File
Batches multiple find-and-replace operations on a single file with all-or-nothing execution.
**Why Codex lacks this:** Codex's `apply_patch` handles multi-hunk edits on a single file but doesn't have a separate atomic batch tool.

### 5.6 `TeamCreate` / `TeamDelete` — Team Coordination
Creates teams with shared task lists, coordinated agent lifecycle, and inter-agent messaging.
**Why Codex lacks this:** Codex has experimental `spawn_agent` but no team-level abstraction with shared task lists.

### 5.7 `SendMessage` — Inter-Agent Messaging Protocol
```
Types: "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response"
Parameters: recipient, content, summary, request_id, approve
```
**Why Codex lacks this:** Codex has `send_input` for sending to agents but no message types, no broadcast, no shutdown protocol, no plan approval flow.

### 5.8 `EnterPlanMode` / `ExitPlanMode` — Structured Plan Workflow
Tool-based plan mode with file-backed plans, structured approval workflow, and team-integrated plan approvals.
**Why Codex lacks this:** Codex has prompt-based plan mode but no structured tool-based approval flow.

### 5.9 `Skill` — Plugin Invocation System
```
Parameters: skill (string, required), args (string, optional)
```
Invokes registered skills as tools. Skills are discoverable, have descriptions, and are invoked programmatically.
**Codex comparison:** Codex has Skills (SKILL.md files) but they work as prompt templates injected into context, not as tool invocations. Different mechanism.

---

## 6. Codex CLI-Only Tools

These tools exist in Codex CLI but have **no direct equivalent** in Claude Code:

### 6.1 `exec_command` + `write_stdin` — PTY-Based Interactive Shell
```
exec_command params: cmd, workdir, shell, login, tty, yield_time_ms,
                     max_output_tokens, sandbox_permissions, justification
write_stdin params: session_id (required), chars, yield_time_ms, max_output_tokens
```
Launches long-running PTY processes; write keystrokes to stdin; poll streaming output.
**Claude Code gap:** Background Bash is fire-and-forget — can read output via `TaskOutput` but cannot write stdin.

### 6.2 `js_repl` + `js_repl_reset` — Persistent JavaScript REPL
```
js_repl: Runs JavaScript in a persistent Node kernel with top-level await
js_repl_reset: Restarts kernel and clears all bindings
```
**Why Claude Code lacks this:** Claude Code has no in-process REPL. Must use `Bash` to run `node -e` (ephemeral, no state).

### 6.3 `list_dir` — Structured Directory Listing
```
Parameters:
  dir_path: string (required) — absolute path
  offset: number (optional) — entry starting position (1-indexed)
  limit: number (optional) — max entries
  depth: number (optional) — max directory traversal depth (≥1)
```
**Claude Code gap:** No dedicated directory listing tool. Uses `Bash` with `ls` or `Glob` patterns.

### 6.4 `apply_patch` — File Rename/Move
```
*** Update File: old/path.ts
*** Move to: new/path.ts
```
**Claude Code gap:** No dedicated rename. Must use `Bash` with `mv`.

### 6.5 `apply_patch` — File Deletion
```
*** Delete File: path/to/file
```
**Claude Code gap:** No dedicated deletion. Must use `Bash` with `rm`.

### 6.6 `search_tool_bm25` — BM25 Search
Searches apps/tools using BM25 ranking algorithm.
**Claude Code gap:** No equivalent. Claude Code's `Grep` is regex-based, not relevance-ranked.

### 6.7 MCP Resource Tools
```
list_mcp_resources — Lists all resources from MCP servers
list_mcp_resource_templates — Lists resource templates
read_mcp_resource — Reads a specific resource by URI
```
**Claude Code gap:** Accesses MCP tools but has no dedicated tool for browsing/reading MCP resources.

### 6.8 Conversation Fork (`/fork`)
Clones current conversation into a new thread for alternative exploration.
**Claude Code gap:** No conversation forking. Must start new sessions.

### 6.9 `read_file` Indentation Mode (Unique Feature)
```
Parameters (indentation mode):
  mode: "indentation"
  indentation: {
    anchor_line: number (center line)
    max_levels: number (parent indentation levels to include)
    include_siblings: boolean (blocks at same indentation)
    include_header: boolean (doc comments/attributes above)
    max_lines: number (hard cap)
  }
```
Extracts a function/class body by structural indentation — no equivalent in Claude Code.

### 6.10 Shell Permission Escalation
```
Parameter: with_escalated_permissions (boolean) + justification (string)
```
Per-command escalation within the sandbox. Claude Code's `dangerouslyDisableSandbox` is all-or-nothing.

---

## 7. Parameter-Level Differences

### 7.1 Shell Tool Parameters

| Parameter | Claude Code `Bash` | Codex CLI `shell_command` |
|-----------|-------------------|--------------------------|
| Command | `command: string` | `command: string` (also `string[]` in `shell`) |
| Timeout | `timeout: number` (ms, max 600000, default 120000) | `timeout_ms: number` |
| Description | `description: string` | `justification: string` (only with escalated perms) |
| Working dir | Persists (implicit) | `workdir: string` (explicit per call) |
| Background | `run_in_background: boolean` | N/A (use `exec_command`) |
| Sandbox override | `dangerouslyDisableSandbox: boolean` | `with_escalated_permissions: boolean` |
| Login shell | N/A | `login: boolean` |

### 7.2 File Read Parameters

| Parameter | Claude Code `Read` | Codex CLI `read_file` |
|-----------|-------------------|----------------------|
| Path | `file_path: string` (absolute) | `file_path: string` (absolute) |
| Offset | `offset: number` (line-based) | `offset: number` (1-indexed) |
| Limit | `limit: number` (line count) | `limit: number` |
| PDF pages | `pages: string` (e.g. "1-5") | N/A |
| Read mode | N/A (always line-based) | `mode: "slice" \| "indentation"` |
| Indentation | N/A | `indentation: {anchor_line, max_levels, include_siblings, include_header, max_lines}` |

### 7.3 File Edit Parameters

| Parameter | Claude Code `Edit` | Codex CLI `apply_patch` |
|-----------|-------------------|------------------------|
| Path | `file_path: string` (absolute) | Embedded in patch header (relative) |
| Target text | `old_string: string` | Context lines with `@@` headers |
| Replacement | `new_string: string` | `+`/`-` prefixed lines in hunks |
| Bulk replace | `replace_all: boolean` | N/A (list each occurrence) |
| Multi-file | N/A (one file per call) | Multiple `*** Update File:` blocks |
| Create file | N/A (use Write) | `*** Add File:` in same patch |
| Delete file | N/A (use Bash) | `*** Delete File:` in same patch |
| Rename file | N/A (use Bash) | `*** Move to:` in same patch |

### 7.4 Content Search Parameters

| Parameter | Claude Code `Grep` | Codex CLI `grep_files` |
|-----------|-------------------|----------------------|
| Pattern | `pattern: string` (regex) | `pattern: string` (regex) |
| Path | `path: string` | `path: string` |
| File filter | `glob: string` + `type: string` | `include: string` (glob only) |
| Output mode | `"content"` / `"files_with_matches"` / `"count"` | Files only (by mod time) |
| Context lines | `-A`, `-B`, `-C` / `context` | N/A |
| Case sensitivity | `-i: boolean` | N/A |
| Line numbers | `-n: boolean` (default true) | N/A |
| Multiline | `multiline: boolean` | N/A |
| Pagination | `head_limit` + `offset` | `limit` only (default 100) |

### 7.5 Web Search Parameters

| Parameter | Claude Code `WebSearch` | Codex CLI `web_search` |
|-----------|------------------------|------------------------|
| Query | `query: string` (required, explicit) | Implicit (agent context) |
| Include domains | `allowed_domains: string[]` | N/A |
| Exclude domains | `blocked_domains: string[]` | N/A |
| Mode | Always live | `cached` / `live` / `disabled` |

### 7.6 Sub-Agent Parameters

| Parameter | Claude Code `Task` | Codex CLI `spawn_agent` |
|-----------|-------------------|------------------------|
| Instructions | `prompt: string` | `message: string` or `items: array` |
| Agent type | `subagent_type: string` (required) | `agent_type: string` (optional) |
| Model | `model: "sonnet" \| "opus" \| "haiku"` | N/A |
| Permission | `mode: string` (6 options) | N/A |
| Background | `run_in_background: boolean` | N/A |
| Resume | `resume: string` (agent ID) | Separate `resume_agent` tool |
| Team | `team_name: string` | N/A |
| Max turns | `max_turns: integer` | N/A |

---

## 8. Permission & Sandbox Models

### Claude Code

**Permission Modes:**
| Mode | Description |
|------|-------------|
| **default** | Allows reads; asks before other operations |
| **acceptEdits** | Auto-accepts file edits; prompts for shell |
| **bypassPermissions** | Skips all permission checks (can be disabled by IT) |
| **plan** | Read-only exploration; no edits allowed |
| **dontAsk** | Don't ask for confirmations |
| **delegate** | Delegate decisions to subagents |

**OS-Level Sandbox:**
- macOS: **Seatbelt** profiles (kernel-level, generated from deny rules)
- Linux: **Landlock + seccomp** (kernel-level)
- Open-source runtime: `npx @anthropic-ai/sandbox-runtime <cmd>`
- Reduces permission prompts by **84%** in internal usage

**Sandbox Details:**
- Write access: restricted to CWD and subdirectories
- Read access: entire filesystem except explicitly denied paths
- Network: routed through Unix domain socket proxy; domain-level restrictions
- `dangerouslyDisableSandbox`: per-command escape hatch (requires approval unless auto-approved)
- Configurable: `excludedCommands`, `allowedDomains`, `allowUnixSockets`

**Rule Evaluation:** deny → ask → allow (first match wins)

**Configuration Precedence:**
1. Managed (IT-deployed, highest)
2. CLI arguments
3. Local project (`.claude/settings.local.json`)
4. Project (`.claude/settings.json`)
5. User (`~/.claude/settings.json`, lowest)

### Codex CLI

**Approval Policies:**
| Policy | Description |
|--------|-------------|
| **untrusted** | Maximum caution; auto-runs known-safe reads only |
| **on-failure** | Prompts only after errors |
| **on-request** | Prompts for significant operations (default) |
| **never** | No approval prompts |

**Sandbox Modes:**
| Mode | Description |
|------|-------------|
| `read-only` | No writes anywhere |
| `workspace-write` | Write only to workspace + /tmp |
| `danger-full-access` | Unrestricted filesystem + network |

**OS-Level Sandbox:**
- macOS: **Seatbelt** via `sandbox-exec` (mode-specific profiles)
- Linux: **Landlock + seccomp** (default); optional **Bubblewrap** (`bwrap`)
- Windows: Experimental restricted-token sandbox
- Docker: Requires separate configuration; `enableWeakerNestedSandbox` for containers

**Smart Defaults:**
- Version-controlled folders → `workspace-write` + `on-request`
- Non-version-controlled → `read-only`
- Network → disabled by default
- CLI shortcut: `--full-auto` = `on-request` + `workspace-write`

**Key Comparison:**
| Feature | Claude Code | Codex CLI |
|---------|-------------|-----------|
| OS sandbox | ✅ Seatbelt / Landlock+seccomp | ✅ Seatbelt / Landlock+seccomp / Bwrap |
| Network isolation | Domain-level proxy | Firewall (OpenAI API only in sandbox) |
| Per-command escalation | ❌ (all-or-nothing) | ✅ `with_escalated_permissions` |
| Smart defaults | Manual configuration | Auto-detects git repos |
| Permission rule syntax | gitignore-style patterns | Config file + CLI flags |
| Open-source sandbox | ✅ `@anthropic-ai/sandbox-runtime` | ✅ Full source in `codex-rs/` |

---

## 9. Key Takeaways

### Claude Code Advantages
1. **More mature specialized tools** — Stable, dedicated `Glob`, `Grep` (12+ params), `Read` (PDF/images/notebooks), `Edit`, `Write` vs Codex's experimental equivalents
2. **WebFetch with AI processing** — Two-stage pipeline (fetch → Haiku summary) with injection defense; no Codex equivalent
3. **Team orchestration** — Full team abstraction (`TeamCreate`, shared task lists, `SendMessage` with 5 message types); Codex has agent spawning but no team layer
4. **Richer task management** — Full CRUD with dependencies, ownership, blocking vs Codex's simple step list
5. **Structured plan mode** — Tool-based plan workflow with file-backed plans and approval flow
6. **Jupyter Notebook support** — Both reading and editing (.ipynb); Codex has neither
7. **PDF reading** — Page-range support; Codex cannot read PDFs
8. **Content search depth** — `Grep` has 12+ parameters (output modes, context lines, multiline, pagination) vs Codex's 4-parameter `grep_files`

### Codex CLI Advantages
1. **Unified file operations** — `apply_patch` handles create + edit + delete + rename in one atomic tool; multi-file patches
2. **Better interactive shell** — `exec_command` + `write_stdin` for true PTY with stdin support and streaming output
3. **JavaScript REPL** — Persistent `js_repl` with top-level await; Claude Code has nothing equivalent
4. **Indentation-aware file reading** — `read_file` indentation mode extracts code blocks by structural nesting
5. **Cached web search** — Pre-indexed results for offline/sandboxed use
6. **Conversation forking** — `/fork` branches conversations for exploration
7. **Per-command permission escalation** — Granular `with_escalated_permissions` vs all-or-nothing
8. **Granular agent lifecycle** — 5 separate tools (spawn/send/resume/wait/close) for fine-grained agent control
9. **MCP resource browsing** — Dedicated tools to list and read MCP resources
10. **Rust performance** — Core written in Rust for speed

### Design Philosophy

| | Claude Code | Codex CLI |
|-|-------------|-----------|
| **Tool design** | Many specialized tools with rich parameters | Fewer tools, evolving toward specialization |
| **File editing** | String matching (simple, explicit) | Diff/patch format (powerful, complex) |
| **Agent model** | Team-oriented (shared state, messaging) | Agent-oriented (lifecycle management) |
| **Sandbox** | OS-level + permission prompts | OS-level + approval policies + smart defaults |
| **Extension** | Skills (tool invocation) + Hooks + MCP | Skills (prompt templates) + MCP + feature flags |
| **Maturity** | Most tools stable and battle-tested | Many tools experimental/feature-gated |

---

## Sources

### Claude Code
- [Claude Code Official Docs](https://code.claude.com/docs)
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Anthropic Engineering: Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Claude Code Internals (Kir Shatrov)](https://kirshatrov.com/posts/claude-code-internals)
- [Claude Code Tools Reference (vtrivedy)](https://www.vtrivedy.com/posts/claudecode-tools-reference)
- [System Prompt Extractions (wong2)](https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f)
- [Sandbox Runtime Source](https://github.com/anthropic-experimental/sandbox-runtime)

### Codex CLI
- [Codex CLI Official Docs](https://developers.openai.com/codex/cli/)
- [Codex CLI Features](https://developers.openai.com/codex/cli/features/)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Codex Config Reference](https://developers.openai.com/codex/config-reference/)
- [Codex Security](https://developers.openai.com/codex/security/)
- [Codex Models](https://developers.openai.com/codex/models/)
- [Codex GitHub Repository](https://github.com/openai/codex)
- [Codex Tool Definitions (spec.rs)](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec.rs)
- [Codex apply_patch Instructions](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/apply_patch_tool_instructions.md)
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)

### Comparisons
- [DeepWiki: Codex Tool System](https://deepwiki.com/openai/codex/6-node.js-implementation-(codex-cli))
- [Claude Code vs Codex (Builder.io)](https://www.builder.io/blog/codex-vs-claude-code)
- [Claude Code vs Codex (Composio)](https://composio.dev/blog/claude-code-vs-openai-codex)
- [Claude Code vs Codex (Graphite)](https://graphite.com/guides/claude-code-vs-codex)
