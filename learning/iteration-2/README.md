# Iteration 2: 最简 Proxy — 纯文本，无流式

## 本节目标

写一个 ~80 行的 HTTP proxy，实现最基础的翻译：
- 接收 Anthropic Messages API 请求
- 翻译成 OpenAI Chat Completions API 请求
- 拿到 GPT 的回复
- 翻译回 Anthropic 格式返回

**不支持：** streaming、tools、tool_choice、多轮历史。只做纯文本的一问一答。

---

## 1. 核心思路

整个 proxy 就是一个 HTTP server，只处理一个路由：

```
POST /v1/messages
```

收到请求后做三步：

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ 1. Parse     │   ───▶  │ 2. Translate  │   ───▶  │ 3. Forward   │
│ Anthropic    │         │ to OpenAI     │         │ to GPT       │
│ request body │         │ format        │         │              │
└─────────────┘         └──────────────┘         └──────┬──────┘
                                                         │
┌─────────────┐         ┌──────────────┐                │
│ 5. Return    │   ◀──  │ 4. Translate  │   ◀───────────┘
│ to Claude    │         │ GPT response  │
│ Code         │         │ to Anthropic  │
└─────────────┘         └──────────────┘
```

## 2. 代码讲解

### Step 1: HTTP Server 骨架

```typescript
import http from "node:http";

const PORT = 3456;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TARGET_MODEL = "gpt-4o";
const SPOOF_MODEL = "claude-sonnet-4-5-20250929";  // 假装是这个模型

const server = http.createServer(async (req, res) => {
  // 只处理 POST /v1/messages
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // ... 翻译逻辑
});

server.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
```

为什么端口是 3456？因为 Claude Code 的 teammate 进程会被设置：
```bash
ANTHROPIC_BASE_URL=http://localhost:3456
```
它原本发给 `api.anthropic.com/v1/messages` 的请求，现在发到我们这里。

为什么需要 `SPOOF_MODEL`？因为 Claude Code 会检查响应中的 model 字段，如果不是 Claude 模型名会报错。所以我们在回复中伪装成 Claude。

### Step 2: 读取请求体

```typescript
// 读取完整的 request body
const chunks: Buffer[] = [];
for await (const chunk of req) chunks.push(chunk);
const body = JSON.parse(Buffer.concat(chunks).toString());
```

`body` 现在是一个 Anthropic Messages API 请求对象，长这样：
```json
{
  "model": "claude-sonnet-4-5-20250929",
  "system": "You are a helpful assistant.",
  "messages": [{ "role": "user", "content": "Hello" }],
  "max_tokens": 4096,
  "stream": true
}
```

### Step 3: 翻译请求（Anthropic → OpenAI）

这一步做 Iteration 1 讲到的三个翻译：
1. `system` 字段 → `messages[0]` with `role: "system"`
2. 拼接 `messages` 数组
3. 设置 `stream: false`（这个 iteration 不做 streaming）

```typescript
const openaiMessages = [];

// System prompt → system message
if (body.system) {
  const text = typeof body.system === "string"
    ? body.system
    : body.system.map(b => b.text).join("\n");
  openaiMessages.push({ role: "system", content: text });
}

// User/assistant messages（简化版：只处理 string content）
for (const msg of body.messages) {
  openaiMessages.push({
    role: msg.role,
    content: typeof msg.content === "string"
      ? msg.content
      : msg.content.map(b => b.text || "").join(""),
  });
}

const openaiReq = {
  model: TARGET_MODEL,
  messages: openaiMessages,
  max_tokens: body.max_tokens || 4096,
  stream: false,  // 不要流式！
};
```

注意：我们把 `stream` 设为 `false`。这样 OpenAI 会返回一个完整的 JSON 响应而不是 SSE 流。先把简单的跑通，streaming 留给 Iteration 3。

### Step 4: 发给 OpenAI

```typescript
const upstream = await fetch(OPENAI_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
  },
  body: JSON.stringify(openaiReq),
});

const openaiRes = await upstream.json();
```

`openaiRes` 长这样：
```json
{
  "id": "chatcmpl-abc123",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 8
  }
}
```

### Step 5: 翻译响应（OpenAI → Anthropic）

把 OpenAI 的 flat response 翻译成 Anthropic Messages API 的 non-streaming response：

```typescript
const choice = openaiRes.choices?.[0];

const anthropicRes = {
  id: `msg_${Date.now()}`,
  type: "message",
  role: "assistant",
  model: SPOOF_MODEL,  // 伪装成 Claude！
  content: [
    { type: "text", text: choice?.message?.content || "" }
  ],
  stop_reason: choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
  usage: {
    input_tokens: openaiRes.usage?.prompt_tokens || 0,
    output_tokens: openaiRes.usage?.completion_tokens || 0,
  },
};

res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify(anthropicRes));
```

关键点：
- `model` 用 `SPOOF_MODEL` 而不是 `"gpt-4o"` — 骗过 Claude Code 的模型检查
- `content` 是数组格式，包含一个 `text` block — 这是 Anthropic 的格式
- `stop_reason` 而不是 `finish_reason` — 术语不同
- `"stop"` → `"end_turn"`, `"length"` → `"max_tokens"` — 值也不同

---

## 3. 完整代码

见 `code/proxy.ts`。总共 ~80 行，是整个 HydraTeams 最核心的骨架。

## 4. 测试方法

### 用 curl 模拟 Claude Code teammate 的请求：

```bash
curl -X POST http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "Say hello in 3 words"}],
    "max_tokens": 100,
    "stream": false
  }'
```

期望返回：
```json
{
  "id": "msg_1234567890",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5-20250929",
  "content": [{ "type": "text", "text": "Hello, dear friend!" }],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 20, "output_tokens": 5 }
}
```

Claude Code 收到这个响应，完全不会怀疑——格式跟真正的 Anthropic API 一模一样。

### 运行方式：

```bash
cd learning/iteration-2/code
OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
```

---

## 5. 这个版本的局限

| 不支持 | 为什么 | 哪个 Iteration 解决 |
|--------|--------|-------------------|
| Streaming | 需要 SSE 翻译 | Iteration 3 |
| Tools | 需要 tool definition + tool_call 翻译 | Iteration 4 |
| 多轮 tool 历史 | 需要 tool_result 消息翻译 | Iteration 5 |
| 错误处理 | 需要格式翻译 + 重试 | Iteration 6 |

但是！这 80 行代码已经能让 GPT 回答简单的文本问题了。
Claude Code teammate 发问 → Proxy 翻译 → GPT 回答 → Proxy 翻译回来 → Teammate 拿到回答。

**核心翻译循环已经跑通了。**

---

准备好了就说 **"开始 Iteration 3"**，我们加入 SSE streaming！
