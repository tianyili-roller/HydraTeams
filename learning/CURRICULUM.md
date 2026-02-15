# HydraTeams Learning Curriculum

**Goal:** 从零开始理解 HydraTeams 如何让 ChatGPT/GPT 成为 Claude Code Agent Teams 的 teammate。

**方法:** 每个 Iteration 聚焦一个核心概念，从最简单的实现开始，逐步添加复杂度，直到完整复现生产版本的所有功能。

---

## Overview: 这个项目到底在做什么？

```
Claude Code Lead Agent
        │
        │  POST /v1/messages  (Anthropic Messages API format)
        │
        ▼
  ┌──────────────┐
  │  HydraProxy  │  ← 翻译层，~580 行代码
  └──────┬───────┘
         │
         │  POST /v1/chat/completions  (OpenAI format)
         │
         ▼
   OpenAI / GPT / Ollama / Gemini
```

Claude Code teammate 进程调用 `POST /v1/messages`。正常情况下这去 Anthropic API。
但如果你设置 `ANTHROPIC_BASE_URL=http://localhost:3456`，请求就来到了我们的 proxy。
Proxy 做两件事：
1. **Request:** 把 Anthropic 格式翻译成 OpenAI 格式，发给 GPT
2. **Response:** 把 GPT 返回的 OpenAI SSE 流翻译回 Anthropic SSE 流

Teammate 进程完全不知道后面是 GPT 在回答。它看到的是标准的 Anthropic API 响应。

---

## Iteration Map

### Iteration 1: 理解两个 API 的格式差异
**Focus:** 不写代码，纯理论。对比 Anthropic Messages API vs OpenAI Chat Completions API。
**Key Question:** 这两个 API 的 request/response 结构有什么不同？
**Files to study:** `src/translators/types.ts`

### Iteration 2: 最简 Proxy — 纯文本，无流式
**Focus:** 搭建最基础的 HTTP server，接收 Anthropic 格式请求，翻译成 OpenAI 格式，拿到回复，翻译回来。
**Key Concept:** HTTP 代理的基本结构
**What we build:** ~50 行的 proxy，只支持纯文本对话，不支持 streaming，不支持 tools
**Files to study:** `src/proxy.ts` (核心结构), `src/translators/messages.ts` (消息翻译)

### Iteration 3: 加入 SSE Streaming
**Focus:** 理解 Server-Sent Events 协议。OpenAI 的 SSE 格式 vs Anthropic 的 SSE 格式。
**Key Concept:** 流式翻译 — 实时把 OpenAI chunk 转成 Anthropic event
**What we build:** 支持流式文本响应的 proxy
**Files to study:** `src/translators/response.ts` (前半部分，text streaming)

### Iteration 4: Tool Use — 让 GPT 能使用 Claude Code 的工具
**Focus:** 这是最关键的一步。Claude Code 的 15+ 工具（Read, Write, Edit, Bash, Grep...）都通过 tool_use 机制工作。
**Key Concept:**
- Request 方向：Anthropic tool definitions → OpenAI function definitions
- Response 方向：OpenAI tool_calls streaming → Anthropic tool_use content blocks
**What we build:** 支持 tool definition 翻译 + tool call 流式响应
**Files to study:** `src/translators/request.ts`, `src/translators/response.ts` (tool_calls 部分), `src/translators/messages.ts` (tool_result 处理)

### Iteration 5: 完整消息历史翻译
**Focus:** 真实的 agentic loop 中，消息历史包含多轮 tool_use → tool_result 的交互。
**Key Concept:**
- Assistant 消息可能同时包含 text + tool_use blocks
- User 消息可能包含 tool_result blocks（工具执行结果）
- 这些都要正确翻译
**What we build:** 完整的消息历史翻译，能支持多轮工具调用
**Files to study:** `src/translators/messages.ts` (完整版)

### Iteration 6: Edge Cases & 健壮性
**Focus:** 生产环境中会遇到的各种问题。
**Key Concepts:**
- Rate limiting (429) + 指数退避重试
- Non-streaming 回退
- Token counting endpoint (`/v1/messages/count_tokens`)
- Error handling + 错误格式翻译
**What we build:** 完善 proxy 的健壮性
**Files to study:** `src/proxy.ts` (retry logic, count_tokens, error handling)

### Iteration 7: Passthrough & 路由
**Focus:** 在混合团队中，Lead agent 用真正的 Claude，Teammate 用 GPT。
**Key Concepts:**
- 如何区分 Lead vs Teammate 的请求？
- Passthrough: 直接转发到真正的 Anthropic API
- Routing 逻辑：基于 model、marker、system prompt 来决定
**What we build:** Passthrough 功能 + 智能路由
**Files to study:** `src/proxy.ts` (shouldPassthrough, handlePassthrough, routing logic)

### Iteration 8: ChatGPT Responses API 支持
**Focus:** ChatGPT 的 Codex 后端使用 Responses API，这是一个完全不同的 API 格式。
**Key Concepts:**
- Responses API vs Chat Completions API 的区别
- 不同的 SSE event 类型（response.created, response.output_text.delta 等）
- 认证：使用 Codex CLI 的 auth token
**What we build:** 第二条翻译路径
**Files to study:** `src/translators/request-responses.ts`, `src/translators/response-responses.ts`

### Iteration 9: Config, Logging & 生产化
**Focus:** 让 proxy 可配置、可观测、可部署。
**Key Concepts:**
- CLI args + env vars 配置体系
- Per-worker logging（识别不同 teammate 的请求）
- Session tracking（通过 message count 推断是哪个 teammate）
**What we build:** 完整的配置系统 + 日志系统
**Files to study:** `src/config.ts`, `src/logger.ts`

---

## 项目源码文件对照表

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 39 | 入口：启动 HTTP server |
| `src/config.ts` | 93 | 配置：CLI args + env vars |
| `src/proxy.ts` | 315 | 核心：路由 + passthrough + 翻译调度 |
| `src/translators/types.ts` | 193 | 类型：两个 API 的 TypeScript 类型定义 |
| `src/translators/messages.ts` | 117 | 翻译：Anthropic 消息 → OpenAI 消息 |
| `src/translators/request.ts` | 93 | 翻译：完整请求 (Anthropic → OpenAI Chat Completions) |
| `src/translators/response.ts` | 231 | 翻译：SSE 流 (OpenAI → Anthropic) |
| `src/translators/request-responses.ts` | 210 | 翻译：请求 (Anthropic → ChatGPT Responses API) |
| `src/translators/response-responses.ts` | 347 | 翻译：SSE 流 (ChatGPT Responses API → Anthropic) |
| `src/logger.ts` | 249 | 日志：Per-worker 识别 + 彩色输出 |

Total: ~1887 lines (生产版本比 VISION.md 预估的 580 行大了不少，因为加了 ChatGPT Responses API 支持和完整的 logging)

---

## How to Use

每个 Iteration 文件夹下会有：
- `README.md` — 本节的概念讲解
- `code/` — 本节要写的代码（从 scratch 开始，逐步构建）
- `exercises/` — 练习题（可选）

告诉我 "开始 Iteration 1" 就可以了！
