# Iteration 3: 加入 SSE Streaming

## 本节目标

让 proxy 支持流式响应。这是 Claude Code **强制要求**的——它发送 `stream: true`，期望收到 SSE 流。
Iteration 2 的非流式版本在真实环境中会被拒绝。

---

## 1. 为什么必须 Streaming？

Claude Code teammate 发请求时总是 `stream: true`。如果 proxy 返回一个 JSON blob 而不是 SSE 流，
Claude Code 会解析失败。

更重要的是，streaming 让 agent loop 更快——模型开始输出 tool call 的瞬间，Claude Code 就可以
开始准备执行工具，而不是等完整响应。

## 2. SSE (Server-Sent Events) 协议速览

SSE 是一种基于 HTTP 的单向流协议。格式非常简单：

```
event: 事件类型\n
data: 数据内容\n
\n                    ← 空行分隔事件
```

规则：
- 每行以 `event:`, `data:`, `id:`, 或 `retry:` 开头
- `event:` 行是可选的（OpenAI 不用，Anthropic 用）
- 一个空行 `\n` 表示当前事件结束
- `data:` 后面通常是 JSON 字符串

### OpenAI 的 SSE：只有 `data:` 行

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"}}]}\n
\n
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":" world"}}]}\n
\n
data: [DONE]\n
\n
```

### Anthropic 的 SSE：有 `event:` + `data:` 行

```
event: message_start\n
data: {"type":"message_start","message":{...}}\n
\n
event: content_block_start\n
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n
\n
event: content_block_delta\n
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n
\n
```

**关键区别：** Anthropic 每个事件有两行（event + data），OpenAI 只有一行（data）。

---

## 3. 翻译策略（纯文本版）

这个 iteration 只处理文本，不处理 tool calls。翻译逻辑：

```
OpenAI chunk 到达                        生成的 Anthropic 事件
─────────────────                        ──────────────────────
[流开始前]                               → message_start
delta.content 首次出现                    → content_block_start (text)
delta.content = "Hello"                  → content_block_delta (text_delta: "Hello")
delta.content = " world"                 → content_block_delta (text_delta: " world")
finish_reason = "stop"                   → content_block_stop
                                         → message_delta (stop_reason: "end_turn")
data: [DONE]                             → message_stop
```

需要一个 **状态机** 来跟踪：
- 文本 block 是否已经开始？（避免重复发 content_block_start）
- 当前的 block index（Anthropic 用 index 标识每个 content block）

```typescript
interface StreamState {
  textBlockStarted: boolean;  // text block 是否已经 start 过
  blockIndex: number;         // 当前 content block 的索引
}
```

---

## 4. 代码拆解

### Step 1: 发送 message_start（流的第一个事件）

在收到 OpenAI 的第一个 chunk 之前，我们就可以先发 `message_start`：

```typescript
function sendSSE(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 设置 SSE 响应头
res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
});

// 立即发送 message_start
sendSSE(res, "message_start", {
  type: "message_start",
  message: {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: SPOOF_MODEL,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
});
```

这告诉 Claude Code："我开始回复了"。注意 `content: []`，具体内容通过后续的 content_block 事件到达。

### Step 2: 读取 OpenAI 的 SSE 流

OpenAI 返回的是 `ReadableStream<Uint8Array>`，我们需要：
1. 逐 chunk 读取字节
2. 解码成文本
3. 按换行符切分成行
4. 找到 `data: ` 开头的行
5. 解析 JSON

```typescript
const reader = upstream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  // 按换行切分
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";  // 最后一行可能不完整，留在 buffer

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) continue;

    const payload = trimmed.slice(6);  // 去掉 "data: " 前缀
    if (payload === "[DONE]") {
      // 流结束
      break;
    }

    const chunk = JSON.parse(payload);
    // ... 翻译这个 chunk
  }
}
```

**为什么需要 buffer？** 因为 `reader.read()` 返回的字节是按**网络包**切分的，不是按**行**切分的。
一个 SSE data 行可能被拆成两个 read() 调用返回。所以我们需要一个 buffer 来累积，
只处理完整的行（以 `\n` 结尾的），不完整的留到下一次。

#### 具体示例：没有 buffer 会怎样？

假设 OpenAI 要发送这两个 SSE 事件：

```
data: {"choices":[{"delta":{"content":"Hello"}}]}\n
\n
data: {"choices":[{"delta":{"content":" world"}}]}\n
\n
```

但网络层可能这样拆包——在 JSON 中间截断：

```
// 第 1 次 read() 返回：
'data: {"choices":[{"delta":{"content":"He'

// 第 2 次 read() 返回：
'llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n'
```

第一次 read 的内容在 `"He` 处被截断了——JSON 不完整，直接 `JSON.parse` 会报错。

#### 有 buffer 的逐步模拟

```
── 第 1 次 read() ──
value = 'data: {"choices":[{"delta":{"content":"He'

buffer += value
buffer = 'data: {"choices":[{"delta":{"content":"He'

split("\n") → ['data: {"choices":[{"delta":{"content":"He']
               只有 1 段，pop() 后全部留在 buffer
lines  = []        ← 没有完整行，什么都不处理
buffer = 'data: {"choices":[{"delta":{"content":"He'   ← 等下一次 read 补全


── 第 2 次 read() ──
value = 'llo"}}]}\n\ndata: {"choices":[...}]}\n\n'

buffer += value
buffer = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[...}]}\n\n'

split("\n") → [
  'data: {"choices":[{"delta":{"content":"Hello"}}]}',   ← ✅ 完整！上次的残片拼上了
  '',                                                     ← 空行（SSE 事件分隔符）
  'data: {"choices":[{"delta":{"content":" world"}}]}',   ← ✅ 完整
  '',                                                     ← 空行
  ''                                                      ← 尾部空串
]

pop() → buffer = ''    ← 这次刚好对齐，没有残片
lines  = [完整行, 空行, 完整行, 空行]   ← 全部可以安全 JSON.parse
```

核心思路就一句话：**`split("\n")` 之后，`pop()` 掉最后一段（可能不完整），剩下的都是以 `\n` 结尾的完整行，可以安全解析。**

#### 补充：`split("\n")` 的边界行为

`pop()` 能正确工作，依赖于 `split` 在不同边界情况下的行为：

```javascript
"A\n".split("\n")     // → ["A", ""]        ← 末尾有 \n → 尾部空串
"A".split("\n")       // → ["A"]            ← 末尾没 \n → 没有尾部空串
"\n".split("\n")      // → ["", ""]         ← 切点前空，切点后也空
"".split("\n")        // → [""]             ← 无切点，返回原字符串（空串）
```

这意味着 `lines.pop()` 天然区分了两种情况：

- buffer 末尾是 `\n` → `pop()` 拿到 `""`（空串），说明最后一行是完整的，没有残片
- buffer 末尾不是 `\n` → `pop()` 拿到一段不完整的文本，留给下一轮 read 拼接

### Step 3: 翻译每个 chunk

```typescript
const choice = chunk.choices?.[0];
if (!choice) continue;

const delta = choice.delta;

// 文本内容到达
if (delta.content) {
  if (!state.textBlockStarted) {
    // 第一次收到文本 → 发送 content_block_start
    sendSSE(res, "content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: { type: "text", text: "" },
    });
    state.textBlockStarted = true;
  }

  // 发送文本增量
  sendSSE(res, "content_block_delta", {
    type: "content_block_delta",
    index: state.blockIndex,
    delta: { type: "text_delta", text: delta.content },
  });
}

// 流结束
if (choice.finish_reason) {
  if (state.textBlockStarted) {
    sendSSE(res, "content_block_stop", {
      type: "content_block_stop",
      index: state.blockIndex,
    });
  }

  sendSSE(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 0, output_tokens: chunk.usage?.completion_tokens || 0 },
  });
}
```

### Step 4: 发送 message_stop

```typescript
if (payload === "[DONE]") {
  sendSSE(res, "message_stop", { type: "message_stop" });
  res.end();
  return;
}
```

---

## 5. 完整的事件序列示例

用户问 "Say hello"，GPT 回复 "Hello there!"

### OpenAI 发来的 SSE 流：

```
data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":" there"},"finish_reason":null}]}

data: {"choices":[{"delta":{"content":"!"},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}

data: [DONE]
```

### Proxy 发给 Claude Code 的 SSE 流：

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
```

Claude Code 收到这个流后，会在 UI 上逐 token 显示 "Hello there!"。体验跟真正的 Claude 一模一样。

---

## 6. 对照生产版本

打开 `src/translators/response.ts`，你会看到我们这个 iteration 实现的正是它的 **文本部分**（lines 120-134）。
生产版本多了 tool call 的处理（lines 137-188），我们在 Iteration 4 加。

---

## 7. 跟 Iteration 2 的差异总结

| | Iteration 2 | Iteration 3 |
|---|---|---|
| OpenAI request | `stream: false` | `stream: true` + `stream_options` |
| OpenAI response | 一个完整 JSON | SSE 流 (多个 chunk) |
| 回给 Claude Code | 一个完整 JSON | SSE 流 (Anthropic 格式) |
| Response headers | `application/json` | `text/event-stream` |
| 需要状态管理 | 不需要 | 需要 `StreamState` |
| 能被 Claude Code 使用 | 不能（它要求 streaming） | 能！ |

---

准备好了就说 **"开始 Iteration 4"**，我们加入 Tool Use！
