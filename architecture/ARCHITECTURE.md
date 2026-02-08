# HydraTeams Architecture

## The Pivot: From Framework to Proxy

The original architecture designed a full agent framework — custom Agent Runtime, Universal Tool System, Provider Adapters, Coordination Layer, Spawner. ~2000+ lines of new code reinventing what Claude Code already does perfectly.

The new architecture: **a translation proxy**. ~580 lines.

Claude Code Agent Teams already solved every hard problem — agentic loops, tool execution, file-based coordination, task management, messaging, plan approval, graceful shutdown. Each teammate is a full Claude Code instance with 15+ tools. The ONLY thing tying it to Anthropic is the API endpoint.

HydraTeams is a proxy server that intercepts the teammate's API calls and translates them from Anthropic Messages API format to OpenAI Chat Completions format (and back). The teammate is still a full Claude Code instance with every tool. It just doesn't know its brain is GPT instead of Claude.

**One environment variable. One proxy. Any model.**

---

## 1. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       USER / CLI                             │
│                 "Create a team to refactor auth"             │
└──────────────────────┬───────────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────────┐
│               LEAD AGENT (Claude Opus 4.6)                   │
│                                                              │
│  Uses native Claude Code Agent Teams:                        │
│  - TeamCreate, TaskCreate, TaskUpdate, SendMessage           │
│  - Spawns teammates with Task tool (subagent_type)           │
│  - Coordinates via standard file-based protocol              │
│                                                              │
│  Spawns teammate with:                                       │
│    ANTHROPIC_BASE_URL=http://localhost:3456                   │
│    ANTHROPIC_API_KEY=<real-openai-key or proxy-token>        │
└──────────────────────┬───────────────────────────────────────┘
                       │
           ┌───────────▼───────────┐
           │   TEAMMATE PROCESS    │
           │   (Claude Code CLI)   │
           │                       │
           │  Full Claude Code     │
           │  instance with ALL    │
           │  15+ tools:           │
           │  - Read, Write, Edit  │
           │  - Bash, Glob, Grep   │
           │  - TaskCreate/Update  │
           │  - SendMessage        │
           │  - WebSearch/Fetch    │
           │  etc.                 │
           │                       │
           │  Thinks it's calling  │
           │  Anthropic API...     │
           └───────────┬───────────┘
                       │
                       │  POST /v1/messages (Anthropic format)
                       │  SSE stream
                       │
           ┌───────────▼───────────┐
           │     HYDRA PROXY       │
           │   localhost:3456      │
           │                       │
           │  1. Receive Anthropic │
           │     Messages request  │
           │  2. Translate to      │
           │     OpenAI format     │
           │  3. Forward to real   │
           │     OpenAI API        │
           │  4. Receive OpenAI    │
           │     SSE stream        │
           │  5. Translate back    │
           │     to Anthropic SSE  │
           │  6. Stream to Claude  │
           │     Code teammate     │
           └───────────┬───────────┘
                       │
                       │  POST /v1/chat/completions (OpenAI format)
                       │  SSE stream
                       │
           ┌───────────▼───────────┐
           │     OpenAI API        │
           │  (GPT-5.3 Codex)     │
           │                       │
           │  Receives tool defs,  │
           │  message history,     │
           │  returns tool calls   │
           │  and text responses   │
           └───────────────────────┘
```

### Why This Works

Claude Code's teammate process communicates with its "brain" via the Anthropic Messages API. It sends:
- System prompt (injected by Agent Teams with team context, tools, coordination instructions)
- Message history (including tool calls and tool results)
- Tool definitions (all 15+ Claude Code tools in Anthropic schema format)

It expects back:
- SSE stream of Anthropic events (message_start, content_block_start, content_block_delta, etc.)
- Text responses and/or tool_use blocks

**The teammate process never validates WHO is on the other end of the API.** It just sends Anthropic-format requests and expects Anthropic-format responses. If those responses come from GPT instead of Claude — the process doesn't know or care. It executes the tool calls regardless.

The `ANTHROPIC_BASE_URL` environment variable is the hook. Confirmed working — when set to `http://localhost:9999`, Claude Code hangs waiting for connection, proving it respects the override completely.

---

## 2. API Translation Map

### Request Translation: Anthropic → OpenAI

| Anthropic Messages API | OpenAI Chat Completions API |
|---|---|
| `POST /v1/messages` | `POST /v1/chat/completions` |
| `model: "claude-sonnet-4-5-20250929"` | `model: "gpt-5.3-codex"` (configured target) |
| `system: "You are a teammate..."` | `messages[0]: { role: "system", content: "..." }` |
| `messages: [...]` | `messages: [...]` (translated format) |
| `tools: [{ name, description, input_schema }]` | `tools: [{ type: "function", function: { name, description, parameters } }]` |
| `tool_choice: { type: "auto" }` | `tool_choice: "auto"` |
| `max_tokens: 16384` | `max_tokens: 16384` |
| `stream: true` | `stream: true, stream_options: { include_usage: true }` |
| `temperature: 1.0` | `temperature: 1.0` |

### Tool Definition Translation

```typescript
// Anthropic format (what Claude Code sends)
{
  name: "Read",
  description: "Read a file from the filesystem...",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file" },
      offset: { type: "number", description: "Line number to start from" },
      limit: { type: "number", description: "Number of lines to read" }
    },
    required: ["file_path"]
  }
}

// OpenAI format (what proxy sends to GPT)
{
  type: "function",
  function: {
    name: "Read",
    description: "Read a file from the filesystem...",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from" },
        limit: { type: "number", description: "Number of lines to read" }
      },
      required: ["file_path"]
    }
  }
}
```

The translation is nearly 1:1. `input_schema` → `parameters`. Wrapped in `{ type: "function", function: { ... } }`.

### Message History Translation

```typescript
// ─── User message ──────────────────────────────
// Anthropic:
{ role: "user", content: "Read the file at /src/auth.ts" }
// OpenAI:
{ role: "user", content: "Read the file at /src/auth.ts" }
// Identical.

// ─── Assistant text ────────────────────────────
// Anthropic:
{ role: "assistant", content: [{ type: "text", text: "I'll read that file." }] }
// OpenAI:
{ role: "assistant", content: "I'll read that file." }

// ─── Assistant tool call ───────────────────────
// Anthropic:
{
  role: "assistant",
  content: [{
    type: "tool_use",
    id: "toolu_abc123",
    name: "Read",
    input: { file_path: "/src/auth.ts" }
  }]
}
// OpenAI:
{
  role: "assistant",
  content: null,
  tool_calls: [{
    id: "toolu_abc123",
    type: "function",
    function: {
      name: "Read",
      arguments: "{\"file_path\":\"/src/auth.ts\"}"
    }
  }]
}

// ─── Tool result ───────────────────────────────
// Anthropic:
{
  role: "user",
  content: [{
    type: "tool_result",
    tool_use_id: "toolu_abc123",
    content: "     1→import jwt from 'jsonwebtoken';\n..."
  }]
}
// OpenAI:
{
  role: "tool",
  tool_call_id: "toolu_abc123",
  content: "     1→import jwt from 'jsonwebtoken';\n..."
}
```

### Mixed Content Blocks

Anthropic messages can have multiple content blocks (text + tool_use mixed). OpenAI separates these:

```typescript
// Anthropic: one message, two content blocks
{
  role: "assistant",
  content: [
    { type: "text", text: "Let me read both files." },
    { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.ts" } },
    { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/b.ts" } }
  ]
}

// OpenAI: one message with content + tool_calls
{
  role: "assistant",
  content: "Let me read both files.",
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/a.ts\"}" } },
    { id: "call_2", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"/b.ts\"}" } }
  ]
}
```

---

## 3. Response Stream Translation (SSE)

This is the hardest part. Both APIs stream via Server-Sent Events, but the event structure is completely different.

### Anthropic SSE Events (what Claude Code expects)

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":500,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"read that file."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc","name":"Read"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"path\":\"/src/auth.ts\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

### OpenAI SSE Events (what GPT actually sends)

```
data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"content":"I'll "},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"content":"read that file."},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file_"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\":\"/src/auth.ts\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

### Translation State Machine

The proxy must maintain state as it translates chunks:

```typescript
interface StreamState {
  blockIndex: number;          // Current content_block index (Anthropic uses explicit indexing)
  activeToolCalls: Map<number, {  // Track OpenAI tool_call indexes → Anthropic block indexes
    id: string;
    name: string;
    anthropicIndex: number;
    started: boolean;          // Have we sent content_block_start yet?
  }>;
  textBlockStarted: boolean;   // Have we sent a text content_block_start?
  messageId: string;           // Generated fake Anthropic message ID
  spoofModel: string;          // Model name to report (e.g., "claude-sonnet-4-5-20250929")
}
```

### Translation Pseudocode

```typescript
async function translateStream(
  openaiStream: ReadableStream,
  response: ServerResponse,
  config: ProxyConfig
): Promise<void> {
  const state: StreamState = {
    blockIndex: 0,
    activeToolCalls: new Map(),
    textBlockStarted: false,
    messageId: `msg_${randomId()}`,
    spoofModel: config.spoofModel || "claude-sonnet-4-5-20250929",
  };

  // 1. Send message_start immediately
  sendSSE(response, "message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      model: state.spoofModel,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // 2. Process each OpenAI SSE chunk
  for await (const chunk of parseSSE(openaiStream)) {
    if (chunk === "[DONE]") {
      // Send message_stop
      sendSSE(response, "message_stop", { type: "message_stop" });
      break;
    }

    const data = JSON.parse(chunk);
    const choice = data.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;

    // ─── Text content ───
    if (delta.content) {
      if (!state.textBlockStarted) {
        sendSSE(response, "content_block_start", {
          type: "content_block_start",
          index: state.blockIndex,
          content_block: { type: "text", text: "" },
        });
        state.textBlockStarted = true;
      }
      sendSSE(response, "content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // ─── Tool calls ───
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const toolIndex = tc.index;

        if (tc.id) {
          // New tool call starting — close text block if open
          if (state.textBlockStarted) {
            sendSSE(response, "content_block_stop", {
              type: "content_block_stop",
              index: state.blockIndex,
            });
            state.blockIndex++;
            state.textBlockStarted = false;
          }

          // Register and start new tool_use block
          state.activeToolCalls.set(toolIndex, {
            id: tc.id,
            name: tc.function?.name || "",
            anthropicIndex: state.blockIndex,
            started: true,
          });

          sendSSE(response, "content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function?.name || "",
            },
          });
          state.blockIndex++;
        }

        // Stream tool call arguments as input_json_delta
        if (tc.function?.arguments) {
          const tracked = state.activeToolCalls.get(toolIndex);
          if (tracked) {
            sendSSE(response, "content_block_delta", {
              type: "content_block_delta",
              index: tracked.anthropicIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }
    }

    // ─── Finish ───
    if (choice.finish_reason) {
      // Close any open blocks
      if (state.textBlockStarted) {
        sendSSE(response, "content_block_stop", {
          type: "content_block_stop",
          index: state.blockIndex,
        });
      }
      for (const [, tc] of state.activeToolCalls) {
        sendSSE(response, "content_block_stop", {
          type: "content_block_stop",
          index: tc.anthropicIndex,
        });
      }

      // Map finish_reason
      const stopReason =
        choice.finish_reason === "tool_calls" ? "tool_use" :
        choice.finish_reason === "length" ? "max_tokens" :
        "end_turn";

      sendSSE(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: data.usage?.completion_tokens || 0 },
      });
    }
  }

  response.end();
}
```

---

## 4. Request Translator

```typescript
export function translateRequest(
  anthropicReq: AnthropicMessagesRequest,
  targetModel: string
): OpenAIChatCompletionsRequest {
  return {
    model: targetModel,
    messages: translateMessages(anthropicReq.system, anthropicReq.messages),
    tools: anthropicReq.tools?.map(translateToolDef),
    tool_choice: translateToolChoice(anthropicReq.tool_choice),
    max_tokens: anthropicReq.max_tokens,
    temperature: anthropicReq.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function translateToolDef(tool: AnthropicTool): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema,
    },
  };
}

function translateToolChoice(
  choice?: AnthropicToolChoice
): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function translateMessages(
  system: string | AnthropicSystemBlock[] | undefined,
  messages: AnthropicMessage[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System prompt → system message
  if (system) {
    const text = typeof system === "string"
      ? system
      : system.map(b => b.text).join("\n");
    result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(translateAssistantMessage(msg));
    } else if (msg.role === "user") {
      // User messages may contain tool_result blocks
      const toolResults = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "tool_result")
        : [];

      if (toolResults.length > 0) {
        // Each tool_result becomes a separate "tool" role message
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string"
              ? tr.content
              : JSON.stringify(tr.content),
          });
        }
        // Any non-tool_result content becomes a user message
        const otherContent = Array.isArray(msg.content)
          ? msg.content.filter(b => b.type !== "tool_result")
          : [];
        if (otherContent.length > 0) {
          result.push({
            role: "user",
            content: otherContent.map(b => b.text || "").join(""),
          });
        }
      } else {
        // Plain user message
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content.map(b => b.text || "").join("");
        result.push({ role: "user", content: text });
      }
    }
  }

  return result;
}

function translateAssistantMessage(msg: AnthropicMessage): OpenAIMessage {
  const content = Array.isArray(msg.content) ? msg.content : [];
  const textParts = content.filter(b => b.type === "text");
  const toolUses = content.filter(b => b.type === "tool_use");

  const result: OpenAIMessage = {
    role: "assistant",
    content: textParts.map(b => b.text).join("") || null,
  };

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map(tu => ({
      id: tu.id,
      type: "function" as const,
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      },
    }));
  }

  return result;
}
```

---

## 5. Proxy Server

```typescript
import http from "node:http";
import { translateRequest } from "./translators/request";
import { translateStream } from "./translators/response";
import { loadConfig } from "./config";

const config = loadConfig();

const server = http.createServer(async (req, res) => {
  // Only handle POST /v1/messages (the Anthropic Messages endpoint)
  if (req.method === "POST" && req.url === "/v1/messages") {
    const body = await readBody(req);
    const anthropicReq = JSON.parse(body);

    // Passthrough: if target is a Claude model, forward to real Anthropic
    if (config.passthrough && isClaudeModel(anthropicReq.model)) {
      return proxyPassthrough(anthropicReq, req.headers, res);
    }

    // Translate Anthropic → OpenAI
    const openaiReq = translateRequest(anthropicReq, config.targetModel);

    // Call OpenAI
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err } }));
      return;
    }

    // Stream translated response
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await translateStream(upstream.body!, res, config);
  } else {
    // Health check or unknown routes
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(config.port, () => {
  console.log(`HydraProxy listening on :${config.port}`);
  console.log(`Target model: ${config.targetModel}`);
  console.log(`Spoofing as: ${config.spoofModel}`);
});
```

---

## 6. Configuration

```typescript
interface ProxyConfig {
  port: number;              // Default: 3456
  targetModel: string;       // e.g., "gpt-5.3-codex"
  targetProvider: string;    // "openai" | "google" | "ollama"
  openaiApiKey: string;      // From env or ~/.hydramcp/.env
  spoofModel: string;        // Model name reported to Claude Code (e.g., "claude-sonnet-4-5-20250929")
  passthrough: boolean;      // If true, Claude model requests go to real Anthropic API
  anthropicApiKey?: string;  // Needed if passthrough is enabled
}
```

**Environment variables:**
```bash
HYDRA_PROXY_PORT=3456
HYDRA_TARGET_MODEL=gpt-5.3-codex
HYDRA_TARGET_PROVIDER=openai
OPENAI_API_KEY=sk-...
HYDRA_SPOOF_MODEL=claude-sonnet-4-5-20250929
HYDRA_PASSTHROUGH=true
ANTHROPIC_API_KEY=sk-ant-...  # Only needed with passthrough
```

---

## 7. Edge Cases & Challenges

### Extended Thinking
Claude supports `thinking` content blocks. OpenAI doesn't have an equivalent. The proxy should:
- Strip `thinking` from the request if present (or map to reasoning_effort if supported)
- Never generate `thinking` blocks in responses (GPT doesn't produce them)

### Model Name Spoofing
Claude Code validates model names in some code paths. The proxy must report a valid Claude model name in `message_start`. Using `claude-sonnet-4-5-20250929` as default since teammates typically run Sonnet.

### Token Counting
Claude Code may send `usage` fields. The proxy maps OpenAI's `prompt_tokens`/`completion_tokens` to Anthropic's `input_tokens`/`output_tokens`. Not 1:1 accurate (different tokenizers) but close enough for coordination purposes.

### System Prompt Compatibility
Claude's system prompt is a top-level field. OpenAI uses a system message. The translation is straightforward, but some models handle long system prompts differently. Claude Code's system prompt is very long (includes all tool descriptions) — the target model needs sufficient context window.

### Multi-turn Tool Use
Claude Code often chains 5-10+ tool calls in sequence (read file → edit → read again → bash → etc.). The message history grows rapidly. The proxy must faithfully translate the entire chain — every tool_use/tool_result pair must map correctly, or the model loses context on what tools returned.

### Anthropic-Specific Headers
Claude Code sends headers like `anthropic-version`, `x-api-key`, `anthropic-beta`. The proxy ignores these — they're meaningful only to the real Anthropic API.

### Content Block Ordering
Anthropic uses explicit `index` fields on content blocks. OpenAI uses `index` on tool_calls but not on text. The proxy must track and generate correct indexes for Anthropic's format.

### Error Response Format
When OpenAI returns an error (429 rate limit, 500 server error), the proxy must translate it to Anthropic's error format so Claude Code handles it correctly:
```typescript
// OpenAI error:
{ "error": { "message": "Rate limit exceeded", "type": "tokens", "code": "rate_limit_exceeded" } }

// Anthropic error format (what Claude Code expects):
{ "type": "error", "error": { "type": "rate_limit_error", "message": "Rate limit exceeded" } }
```

---

## 8. File Structure

```
hydra-proxy/
├── src/
│   ├── index.ts               ~30 lines   Entry point, server startup
│   ├── proxy.ts               ~80 lines   HTTP server, request routing
│   ├── config.ts              ~40 lines   Configuration loading
│   └── translators/
│       ├── types.ts           ~60 lines   TypeScript interfaces for both APIs
│       ├── request.ts         ~120 lines  Anthropic request → OpenAI request
│       ├── response.ts        ~150 lines  OpenAI SSE stream → Anthropic SSE stream
│       └── messages.ts        ~100 lines  Message history translation
├── package.json
├── tsconfig.json
└── README.md
                               ─────────
                               ~580 lines total
```

---

## 9. How To Use It

### Start the proxy
```bash
npx hydra-proxy --model gpt-5.3-codex --port 3456
```

### Spawn a teammate (from Claude Code lead)
The lead agent sets the env var when spawning via Agent Teams:
```
ANTHROPIC_BASE_URL=http://localhost:3456 claude code --teammate
```

Or configured in the Agent Teams spawn config so the lead does it automatically.

### What the teammate experiences
From the teammate's perspective, nothing changes. It's a full Claude Code instance. It reads files, writes code, runs tests, sends messages to the lead — using all 15+ tools. The only difference is its LLM responses come from GPT instead of Claude.

### Passthrough mode
When `HYDRA_PASSTHROUGH=true`, requests for Claude models (detected by model name) are forwarded to the real Anthropic API unchanged. This means you can run a mixed team where some teammates use Claude (passthrough) and others use GPT (translated). The proxy routes based on the model name in each request.

---

## 10. Implementation Plan

### Phase 1: Core Proxy (MVP)
**Goal:** One Claude Code teammate powered by GPT Codex.

1. Build the proxy server (`proxy.ts`, `config.ts`, `index.ts`)
2. Implement request translator (`request.ts`, `messages.ts`)
3. Implement response stream translator (`response.ts`)
4. Define TypeScript types (`types.ts`)
5. Test with `ANTHROPIC_BASE_URL=http://localhost:3456 claude --print "hello"`
6. Test with Agent Teams: lead spawns one teammate, teammate completes a simple task

**Success criteria:** A teammate process powered by GPT Codex successfully reads a file, makes an edit, and reports back to the lead.

### Phase 2: Multi-Provider
**Goal:** Support Google Gemini and Ollama in addition to OpenAI.

- Add Gemini translator (Google's API format differs from OpenAI)
- Add Ollama translator (OpenAI-compatible API, mostly passthrough)
- Provider auto-detection from model name
- Config supports multiple target providers

### Phase 3: Smart Routing
**Goal:** Multiple proxies running simultaneously, lead auto-selects.

- Start multiple proxy instances on different ports (one per provider/model)
- Lead agent config maps model names to proxy ports
- Agent Teams integration: spawn teammates with different ANTHROPIC_BASE_URL per model
- Cost tracking per proxy/model

---

## Why This Beats the Original Architecture

| | Original (Custom Framework) | New (Translation Proxy) |
|---|---|---|
| **Lines of code** | ~2000+ | ~580 |
| **Tool system** | Build from scratch (9 tools) | Claude Code's 15+ tools, for free |
| **Agentic loop** | Build from scratch | Claude Code's battle-tested loop, for free |
| **Coordination** | Build from scratch | Agent Teams file-based protocol, for free |
| **Task management** | Build from scratch | Agent Teams tasks, for free |
| **Messaging** | Build from scratch | Agent Teams JSONL inboxes, for free |
| **Plan approval** | Build from scratch | Agent Teams plan mode, for free |
| **Graceful shutdown** | Build from scratch | Agent Teams shutdown protocol, for free |
| **Context window** | Limited by our implementation | Full 1M context (whatever the model supports) |
| **Agent quality** | Custom agent, limited tools | Full Claude Code instance, every tool |
| **Time to MVP** | Weeks | Days |
| **Maintenance** | Update everything when Claude Code updates | Update only translation layer |

The proxy approach gets 95% of the value at 5% of the complexity. We don't build an agent framework. We make the best agent framework (Claude Code) model-agnostic.

---

## Research Sources

- [ANTHROPIC_BASE_URL override](https://docs.anthropic.com/en/api/client-sdks) — Confirmed working via manual test
- [Claude Code Agent Teams](https://docs.anthropic.com/en/docs/claude-code/agent-teams) — Shipped Feb 5, 2026 with Opus 4.6
- [Anthropic Messages API Streaming](https://docs.anthropic.com/en/api/messages-streaming) — SSE event format
- [OpenAI Chat Completions Streaming](https://platform.openai.com/docs/api-reference/chat/create) — SSE event format
- [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts/) — Reverse-engineered tool definitions
- [paddo.dev — Agent Teams Architecture](https://paddo.dev/blog/agent-teams-the-switch-got-flipped/) — File-based coordination internals
