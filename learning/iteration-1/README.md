# Iteration 1: 理解两个 API 的格式差异

## 本节目标

不写代码。纯粹理解两个关键 API 的结构差异：
- **Anthropic Messages API** — Claude Code teammate 发出的请求格式
- **OpenAI Chat Completions API** — GPT 接受的请求格式

理解了差异，你就理解了 proxy 要做什么。

---

## 1. 先搞清楚全局

Claude Code Agent Teams 的工作方式：

```
┌─────────────────┐     POST /v1/messages      ┌──────────────────┐
│  Claude Code    │  ─────────────────────────▶ │  Anthropic API   │
│  Teammate 进程   │  ◀───────────────────────── │  (api.anthropic  │
│                 │     SSE streaming response   │   .com)          │
└─────────────────┘                              └──────────────────┘
```

每个 teammate 就是一个独立的 Claude Code 进程。它跟 Anthropic API 之间的通信走的是 **Anthropic Messages API**。

现在我们要把后面的 Anthropic API 换成 GPT：

```
┌─────────────────┐     POST /v1/messages      ┌──────────┐     POST /v1/chat/completions     ┌──────────┐
│  Claude Code    │  ─────────────────────────▶ │  Hydra   │  ──────────────────────────────▶  │  OpenAI  │
│  Teammate 进程   │  ◀───────────────────────── │  Proxy   │  ◀──────────────────────────────  │  API     │
│                 │     Anthropic SSE stream     │          │     OpenAI SSE stream             │          │
└─────────────────┘                              └──────────┘                                   └──────────┘
```

Proxy 需要做的翻译：
- **→ 方向 (Request):** Anthropic 格式 → OpenAI 格式
- **← 方向 (Response):** OpenAI SSE 格式 → Anthropic SSE 格式

---

## 2. Request 格式对比

### Anthropic Messages API Request

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 8096,
  "system": "You are a helpful coding assistant.",
  "messages": [
    {
      "role": "user",
      "content": "Write a hello world in Python"
    }
  ],
  "stream": true
}
```

### OpenAI Chat Completions API Request

```json
{
  "model": "gpt-4o",
  "max_tokens": 8096,
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful coding assistant."
    },
    {
      "role": "user",
      "content": "Write a hello world in Python"
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

### 差异 #1: System Prompt 的位置

| | Anthropic | OpenAI |
|---|---|---|
| **System prompt** | 顶层字段 `"system"` | 放在 `messages` 数组里，`role: "system"` |

Anthropic 把 system prompt 当作一个独立的请求字段。
OpenAI 把它当作消息列表中的第一条消息。

**翻译方式：** 把 `req.system` 提取出来，变成 `messages[0]` with `role: "system"`。

而且 Anthropic 的 system 可以是两种格式：
```typescript
// 简单字符串
system: "You are a helpful assistant."

// 或者结构化的 block 数组（支持 cache_control 等高级功能）
system: [
  { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } }
]
```

翻译时需要统一处理这两种形式。

### 差异 #2: stream_options

Anthropic 只需要 `"stream": true`。
OpenAI 还需要额外加 `"stream_options": { "include_usage": true }` 才能在流的最后拿到 token 用量。

---

## 3. Tool Definition 格式对比

这是 Claude Code 最核心的能力——工具调用。15+ 个内置工具（Read, Write, Edit, Bash, Glob, Grep...）都通过 tool definition 告诉模型。

### Anthropic Tool Definition

```json
{
  "name": "Read",
  "description": "Reads a file from the local filesystem.",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path to the file" }
    },
    "required": ["file_path"]
  }
}
```

### OpenAI Tool Definition

```json
{
  "type": "function",
  "function": {
    "name": "Read",
    "description": "Reads a file from the local filesystem.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "The absolute path to the file" }
      },
      "required": ["file_path"]
    }
  }
}
```

### 差异 #3: Tool Definition 结构

| | Anthropic | OpenAI |
|---|---|---|
| **顶层** | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters } }` |
| **Schema 字段名** | `input_schema` | `parameters` |

OpenAI 多了一层嵌套（`function` 包装），schema 字段名从 `input_schema` 变成了 `parameters`。
内部的 JSON Schema 结构完全相同，不需要翻译。

### 差异 #4: tool_choice

| Anthropic | OpenAI | 含义 |
|---|---|---|
| `{ type: "auto" }` | `"auto"` | 模型自己决定是否用工具 |
| `{ type: "any" }` | `"required"` | 必须调用至少一个工具 |
| `{ type: "tool", name: "Read" }` | `{ type: "function", function: { name: "Read" } }` | 必须调用指定工具 |
| `{ type: "none" }` | `"none"` | 不允许用工具 |

Anthropic 用对象格式，OpenAI 部分用字符串格式。

---

## 4. Message 格式对比（对话历史）

简单的文本消息差异不大。**关键差异在 tool 调用相关的消息。**

### 场景：模型调用了 Read 工具读取一个文件

#### Anthropic 格式

```json
[
  { "role": "user", "content": "Read the file /tmp/hello.py" },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Let me read that file." },
      {
        "type": "tool_use",
        "id": "toolu_abc123",
        "name": "Read",
        "input": { "file_path": "/tmp/hello.py" }
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_abc123",
        "content": "print('hello world')"
      }
    ]
  }
]
```

#### OpenAI 格式

```json
[
  { "role": "user", "content": "Read the file /tmp/hello.py" },
  {
    "role": "assistant",
    "content": "Let me read that file.",
    "tool_calls": [
      {
        "id": "toolu_abc123",
        "type": "function",
        "function": {
          "name": "Read",
          "arguments": "{\"file_path\":\"/tmp/hello.py\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "toolu_abc123",
    "content": "print('hello world')"
  }
]
```

### 差异 #5: Assistant 消息中的 Tool Call

| | Anthropic | OpenAI |
|---|---|---|
| **Text + Tool 混合** | `content` 是数组，text 和 tool_use 是同级 block | `content` 只放 text，tool_calls 是单独字段 |
| **Tool call 格式** | `{ type: "tool_use", id, name, input: {...} }` | `{ id, type: "function", function: { name, arguments: "JSON string" } }` |
| **Input 格式** | `input` 是 JSON 对象 | `arguments` 是 JSON **字符串** |

注意最后一点：Anthropic 的 `input` 是真正的 JSON 对象，OpenAI 的 `arguments` 是序列化的 JSON 字符串。翻译时需要 `JSON.stringify(input)`。

### 差异 #6: Tool Result（工具执行结果）

| | Anthropic | OpenAI |
|---|---|---|
| **角色** | `role: "user"` (包在 user 消息里) | `role: "tool"` (独立的 tool 消息) |
| **ID 引用** | `tool_use_id` | `tool_call_id` |
| **Block 类型** | `type: "tool_result"` | 不需要，靠 role 区分 |

Anthropic 把工具结果放在 `user` 消息的 content 数组中，类型为 `tool_result`。
OpenAI 给了工具结果一个独立的 `role: "tool"`。

这意味着一条 Anthropic user 消息可能要拆成多条 OpenAI 消息（tool results + user text）。

---

## 5. Streaming Response 格式对比

这是翻译最复杂的部分。两个 API 都用 SSE (Server-Sent Events)，但事件结构完全不同。

### Anthropic SSE 事件序列（一次完整响应）

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":100,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}
```

关键结构：
1. `message_start` — 消息开始，包含 metadata
2. `content_block_start` — 一个内容块开始（text 或 tool_use）
3. `content_block_delta` — 内容块的增量数据（逐 token 到达）
4. `content_block_stop` — 内容块结束
5. `message_delta` — 消息级别的增量（stop_reason + usage）
6. `message_stop` — 消息结束

**Anthropic 用 content block 概念**：一个消息可以有多个 block（text block, tool_use block），每个 block 有自己的 start/delta/stop 生命周期。

### OpenAI SSE 事件序列

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}}

data: [DONE]
```

关键结构：
1. 每个 chunk 是 `data: {JSON}` 格式，**没有 `event:` 行**
2. 第一个 chunk 的 delta 包含 `role: "assistant"`
3. 后续 chunk 的 delta 包含 `content: "text fragment"`
4. 最后一个 chunk 有 `finish_reason` 和可选的 `usage`
5. 以 `data: [DONE]` 结束

### 差异 #7: SSE 事件模型

| | Anthropic | OpenAI |
|---|---|---|
| **事件类型** | 用 `event:` 行区分（message_start, content_block_delta...） | **没有 event 行**，全是 `data:` 行 |
| **结构层次** | Message → Content Blocks → Deltas（三层） | Choices → Delta（两层） |
| **Content block** | 明确的 start/stop 生命周期 | 没有，靠 delta 中字段的出现/消失推断 |
| **结束标志** | `message_stop` 事件 | `data: [DONE]` 字符串 |
| **Stop reason** | 在 `message_delta` 事件中 | 在最后一个 chunk 的 `finish_reason` 字段 |

### Tool Call 的流式差异更大

**OpenAI** 流式 tool call：
```
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Read","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"fi"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"le_p"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\":"}}]}}]}
...
```

**翻译成 Anthropic** 格式：
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_abc","name":"Read"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"fi"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"le_p"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ath\":"}}
...

event: content_block_stop
data: {"type":"content_block_stop","index":0}
```

Proxy 需要：
1. 检测到 `tool_calls[0].id` 出现 → 发送 `content_block_start`
2. 后续的 `arguments` 片段 → 发送 `content_block_delta` with `input_json_delta`
3. `finish_reason: "tool_calls"` → 发送 `content_block_stop` + `message_delta` with `stop_reason: "tool_use"`

---

## 6. 总结：翻译清单

把所有差异整理成一张 proxy 需要做的事：

### Request 方向 (Anthropic → OpenAI)

| 翻译项 | From | To |
|--------|------|----|
| System prompt | `req.system` (string 或 block[]) | `messages[0]` with `role: "system"` |
| Tool definitions | `{ name, input_schema }` | `{ type: "function", function: { name, parameters } }` |
| tool_choice | `{ type: "auto" }` | `"auto"` |
| Assistant tool_use | `content: [{ type: "tool_use", input: {} }]` | `tool_calls: [{ function: { arguments: "JSON string" } }]` |
| User tool_result | `content: [{ type: "tool_result" }]` in user msg | 独立的 `{ role: "tool" }` 消息 |
| stream_options | 不需要 | 需要加 `{ include_usage: true }` |

### Response 方向 (OpenAI → Anthropic)

| 翻译项 | From | To |
|--------|------|----|
| 流开始 | 第一个 chunk (delta.role) | `message_start` 事件 |
| 文本块 | `delta.content` 出现 | `content_block_start` + `content_block_delta` (text_delta) |
| Tool call 开始 | `delta.tool_calls[i].id` 出现 | `content_block_start` (tool_use) |
| Tool call 参数 | `delta.tool_calls[i].function.arguments` | `content_block_delta` (input_json_delta) |
| 结束 | `finish_reason` + `[DONE]` | `content_block_stop` + `message_delta` + `message_stop` |
| Stop reason | `"stop"` / `"tool_calls"` / `"length"` | `"end_turn"` / `"tool_use"` / `"max_tokens"` |

---

## 7. 对照源码

打开 `src/translators/types.ts`，你会看到这些差异被精确地定义为 TypeScript 类型：

- **Lines 3-60:** Anthropic 的类型 — `AnthropicRequest`, `AnthropicMessage`, `AnthropicContentBlock` (text/tool_use/tool_result)
- **Lines 64-125:** OpenAI 的类型 — `OpenAIRequest`, `OpenAIMessage` (system/user/assistant/tool), `OpenAIToolCall`
- **Lines 129-160:** OpenAI 流式类型 — `OpenAIStreamChunk`, `OpenAIStreamChoice`, `OpenAIStreamToolCall`

这些类型定义就是翻译的"合同"——proxy 的工作就是把左边的结构变成右边的结构，反之亦然。

---

## 思考题

在进入 Iteration 2 写代码之前，想想这些问题：

1. **为什么 Anthropic 的 content 是数组（blocks），而 OpenAI 的 text 和 tool_calls 是分开的字段？** 哪种设计更灵活？

2. **流式翻译中最难的部分是什么？** 提示：考虑 text block 和 tool_use block 的生命周期管理。

3. **如果 GPT 在一个回复中同时返回文本和两个工具调用，proxy 需要生成哪些 Anthropic 事件？** 试着列出完整的事件序列。

4. **为什么需要 `stream_options: { include_usage: true }`？** 如果不加这个，proxy 会缺少什么信息？

---

准备好了就说 **"开始 Iteration 2"**，我们开始写代码！
