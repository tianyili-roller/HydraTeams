#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 3: SSE Streaming
 *
 * 在 Iteration 2 基础上加入流式响应翻译。
 * 支持：纯文本 streaming
 * 不支持：tools, tool_calls
 *
 * 运行: OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
 * 测试: curl -N -X POST http://localhost:3456/v1/messages \
 *        -H "Content-Type: application/json" \
 *        -d '{"model":"claude-sonnet-4-5-20250929","system":"You are helpful.","messages":[{"role":"user","content":"Count from 1 to 5 slowly"}],"max_tokens":200,"stream":true}'
 */

import http from "node:http";

// ─── Config ─────────────────────────────────────────────────────
const PORT = 3456;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TARGET_MODEL = "gpt-4o";
const SPOOF_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("Error: Set OPENAI_API_KEY environment variable");
  process.exit(1);
}

// ─── SSE Helper ─────────────────────────────────────────────────
// 往客户端写一个 Anthropic 格式的 SSE 事件
function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Stream State ───────────────────────────────────────────────
// 跟踪当前流的状态 —— text block 是否已经开始了？
interface StreamState {
  textBlockStarted: boolean;
  blockIndex: number;
}

// ─── Stream Translator ─────────────────────────────────────────
// 核心：从 OpenAI SSE 流中逐 chunk 读取，翻译成 Anthropic SSE 事件
async function translateStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const state: StreamState = {
    textBlockStarted: false,
    blockIndex: 0,
  };

  // ── Step 1: 先发 message_start ──
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

  // ── Step 2: 读取 OpenAI SSE 流 ──
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 解码字节 → 文本，累积到 buffer
      buffer += decoder.decode(value, { stream: true });

      // 按换行切分。最后一段可能不完整，留在 buffer 中。
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith(":")) continue;
        // 只处理 data: 行
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6); // 去掉 "data: "

        // ── [DONE] → 发 message_stop，结束 ──
        if (payload === "[DONE]") {
          sendSSE(res, "message_stop", { type: "message_stop" });
          res.end();
          return;
        }

        // ── 解析 JSON chunk ──
        let chunk: {
          choices?: Array<{
            delta: { role?: string; content?: string | null };
            finish_reason: string | null;
          }>;
          usage?: { completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // 跳过解析失败的行
        }

        // 记录 token 用量
        if (chunk.usage?.completion_tokens) {
          outputTokens = chunk.usage.completion_tokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // ── Step 3: 翻译文本内容 ──
        if (delta.content) {
          // 第一次收到文本 → 开启 text content block
          if (!state.textBlockStarted) {
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

        // ── Step 4: 处理流结束 ──
        if (choice.finish_reason) {
          // 关闭已打开的 text block
          if (state.textBlockStarted) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: state.blockIndex,
            });
          }

          // 发送 message_delta (stop_reason + usage)
          const stopReason = choice.finish_reason === "length" ? "max_tokens" : "end_turn";
          sendSSE(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { input_tokens: 0, output_tokens: outputTokens },
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // 兜底：如果 OpenAI 流异常结束没有 [DONE]
  res.end();
}

// ─── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  try {
    // ── 1. 读取 Anthropic 请求体 ──
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    // ── 2. 翻译请求: Anthropic → OpenAI ──
    const openaiMessages: Array<{ role: string; content: string }> = [];

    if (body.system) {
      const text = typeof body.system === "string"
        ? body.system
        : body.system.map((b: { text: string }) => b.text).join("\n");
      openaiMessages.push({ role: "system", content: text });
    }

    for (const msg of body.messages) {
      openaiMessages.push({
        role: msg.role,
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content.map((b: { text?: string }) => b.text || "").join(""),
      });
    }

    const openaiReq = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      max_tokens: Math.min(body.max_tokens || 4096, 16384),
      stream: true,                                // ← 改成 true！
      stream_options: { include_usage: true },      // ← 新增：要求返回 usage
    };

    console.log(`→ ${body.model} → ${TARGET_MODEL} (${body.messages.length} msgs, streaming)`);

    // ── 3. 发给 OpenAI ──
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`← OpenAI error ${upstream.status}: ${errText.slice(0, 200)}`);
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errText } }));
      return;
    }

    if (!upstream.body) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "No body" } }));
      return;
    }

    // ── 4. 设置 SSE 响应头 + 开始流翻译 ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",     // ← SSE 的 MIME 类型
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    await translateStream(upstream.body, res);
    console.log(`← Stream complete`);

  } catch (err) {
    console.error("Proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } }));
  }
});

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   HydraProxy Iteration 3 — Streaming  ║
╠════════════════════════════════════════╣
║   Port:   :${PORT}                      ║
║   Target: ${TARGET_MODEL.padEnd(29)}║
║   Spoof:  ${SPOOF_MODEL.padEnd(29)}║
║   Mode:   text streaming (no tools)    ║
╚════════════════════════════════════════╝
  `);
});
