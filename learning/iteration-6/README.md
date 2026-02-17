# Iteration 6: Edge Cases & 健壮性

## 本节目标

Iteration 5 给了我们一个能工作的 agent proxy。但在生产环境中，它会因各种问题崩溃或表现异常。

本节加入 **4 个健壮性机制**：

1. **Rate Limiting — 429 指数退避重试**
2. **Non-streaming 回退 — `stream: false` 请求处理**
3. **Token Counting — `/v1/messages/count_tokens` endpoint**
4. **Error 格式翻译 — OpenAI 错误 → Anthropic 错误格式**

---

## 1. Rate Limiting: 429 指数退避重试

### 问题

OpenAI API 在高并发时会返回 `429 Too Many Requests`。
Claude Code agent loop 发请求很快——多个 teammate 并行工作时，很容易打到 rate limit。

如果 proxy 直接把 429 返回给 Claude Code，agent loop 会失败。

### 解决方案：指数退避重试

```typescript
const MAX_RETRIES = 5;
let upstream: Response | null = null;

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  upstream = await fetch(OPENAI_URL, { ... });

  // 只在 429 时重试
  if (upstream.status !== 429) break;

  if (attempt < MAX_RETRIES) {
    // 指数退避: 1s → 2s → 4s → 8s → 10s (capped)
    const waitMs = Math.min(1000 * Math.pow(2, attempt), 10000);
    console.log(`Rate limited (429), retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}
```

等待时间序列：`1s → 2s → 4s → 8s → 10s`

为什么 cap 在 10 秒？因为 Claude Code 有请求超时，等太久会被当作超时处理。

### 为什么只重试 429？

- `429` — 临时的速率限制，等一会就好 → 重试有意义
- `401` — 认证失败，key 错了 → 重试无意义
- `400` — 请求格式错误 → 重试无意义
- `500` — 服务端错误，可能也值得重试，但生产版本选择只重试 429

---

## 2. Non-streaming 回退

### 问题

虽然 Claude Code 基本总是 `stream: true`，但某些内部操作（如 warmup、model check）会发 `stream: false` 的请求。如果 proxy 对所有请求都强制 streaming，这些请求会收到错误格式的响应。

### 解决方案

检测 `anthropicReq.stream !== false`，如果是 non-streaming：
1. 对 OpenAI 也不开 streaming（`stream: false`）
2. 等完整的 JSON 响应
3. 翻译成 Anthropic 的 non-streaming 格式

```typescript
const isStreaming = anthropicReq.stream !== false;

if (!isStreaming) {
  // 对 OpenAI 也关闭 streaming
  openaiReq.stream = false;
  delete openaiReq.stream_options;
}
```

Non-streaming 响应翻译（跟 Iteration 2 类似，但现在也处理 tool calls）：

```typescript
if (!isStreaming) {
  const openaiRes = await upstream.json();
  const choice = openaiRes.choices?.[0];
  const content = [];

  // 文本
  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Tool calls（Iteration 2 没有的！）
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  // stop_reason 翻译
  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use"
    : choice?.finish_reason === "length" ? "max_tokens"
    : "end_turn";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: SPOOF_MODEL,
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
    },
  }));
  return;
}
```

---

## 3. Token Counting: `/v1/messages/count_tokens`

### 问题

Claude Code 在发送请求前会调用 count_tokens 来估算 token 用量，确保不超过 context window。

```
POST /v1/messages/count_tokens
```

这个 endpoint 如果没有处理，Claude Code 会收到 404 并可能报错。

### 解决方案：估算

我们使用 [tiktoken](https://www.npmjs.com/package/tiktoken) 来精确计算 token 数：

```typescript
import { get_encoding } from "tiktoken";

// 启动时初始化一次，所有请求复用
const tokenEncoder = get_encoding("o200k_base");

// 在 count_tokens handler 中：
if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
  const body = JSON.parse(await readBody(req));
  const text = JSON.stringify(body.messages || []);
  const estimatedTokens = tokenEncoder.encode(text).length;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ input_tokens: Math.ceil(estimatedTokens) }));
  return;
}
```

`o200k_base` 是 GPT-4o / GPT-5 系列使用的 BPE encoding，比 `string.length / 4` 的粗估准确得多。

### 兜底

如果解析失败（比如 body 格式不对），返回一个保守的默认值：

```typescript
catch {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ input_tokens: 1000 }));
}
```

---

## 4. Error 格式翻译

### 问题

OpenAI 返回错误时，格式跟 Anthropic 不同。如果原样返回，Claude Code 可能无法解析。

### Anthropic 的错误格式

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded"
  }
}
```

error.type 的可能值：
- `rate_limit_error` — 429
- `authentication_error` — 401
- `invalid_request_error` — 400
- `api_error` — 500+

### 翻译逻辑

```typescript
if (!upstream.ok) {
  const errText = await upstream.text();
  const status = upstream.status;

  // 把 HTTP status code 映射到 Anthropic error type
  const errorType =
    status === 429 ? "rate_limit_error" :
    status === 401 ? "authentication_error" :
    status >= 500  ? "api_error" :
    "invalid_request_error";

  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    type: "error",
    error: { type: errorType, message: errText },
  }));
}
```

---

## 5. Health Check

一个小但有用的功能——让你能快速检查 proxy 是否在运行：

```typescript
if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    targetModel: TARGET_MODEL,
    spoofModel: SPOOF_MODEL,
  }));
  return;
}
```

```bash
curl http://localhost:3456/health
# {"status":"ok","targetModel":"gpt-5.2","spoofModel":"claude-sonnet-4-5-20250929"}
```

---

## 6. 对照生产代码

| 机制 | 生产版本位置 | 行号 |
|------|------------|------|
| 429 重试 (OpenAI) | `src/proxy.ts` | 246-263 |
| 429 重试 (ChatGPT) | `src/proxy.ts` | 195-215 |
| Non-streaming 回退 | `src/proxy.ts` | 241-244 (检测) + 275-292 (处理) |
| count_tokens | `src/proxy.ts` | 116-131 |
| Error 格式翻译 | `src/proxy.ts` | 265-273 |
| Health check | `src/proxy.ts` | 104-113 |

---

## 7. 跟 Iteration 5 的差异总结

| | Iteration 5 | Iteration 6 |
|---|---|---|
| 429 处理 | 直接返回错误 | 最多重试 5 次，指数退避 |
| stream: false | 忽略（强制 streaming） | 正确处理 non-streaming |
| count_tokens | 404 | 返回估算值 |
| 错误响应 | 原样转发 | 翻译成 Anthropic 格式 |
| Health check | 无 | GET / 和 /health |
| 新增路由 | 1 个 | 3 个 (messages + count_tokens + health) |

---

准备好了就说 **"开始 Iteration 7"**！
