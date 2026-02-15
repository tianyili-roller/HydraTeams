#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 2: 最简版本
 *
 * 纯文本，无流式，无 tools。
 * 把 Anthropic Messages API 请求翻译成 OpenAI Chat Completions，再把响应翻译回来。
 *
 * 运行: OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
 * 测试: curl -X POST http://localhost:3456/v1/messages \
 *        -H "Content-Type: application/json" \
 *        -d '{"model":"claude-sonnet-4-5-20250929","system":"You are helpful.","messages":[{"role":"user","content":"Say hi"}],"max_tokens":100,"stream":false}'
 */

import http from "node:http";

// ─── Config ─────────────────────────────────────────────────────
const PORT = 3456;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TARGET_MODEL = "gpt-4o-mini";
const SPOOF_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("Error: Set OPENAI_API_KEY environment variable");
  process.exit(1);
}

// ─── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // 只处理 POST /v1/messages
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

    // System prompt → system message
    if (body.system) {
      const text =
        typeof body.system === "string"
          ? body.system
          : body.system.map((b: { text: string }) => b.text).join("\n");
      openaiMessages.push({ role: "system", content: text });
    }

    // Messages（简化：只处理 string content 和 text blocks）
    for (const msg of body.messages) {
      openaiMessages.push({
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((b: { text?: string }) => b.text || "").join(""),
      });
    }

    const openaiReq = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      max_tokens: Math.min(body.max_tokens || 4096, 16384),
      stream: false,
    };

    console.log(
      `→ Translating: ${body.model} → ${TARGET_MODEL} (${body.messages.length} msgs)`,
    );

    // ── 3. 发给 OpenAI ──
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiReq),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(
        `← OpenAI error ${upstream.status}: ${errText.slice(0, 200)}`,
      );
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: errText },
        }),
      );
      return;
    }

    const openaiRes = (await upstream.json()) as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // ── 4. 翻译响应: OpenAI → Anthropic ──
    const choice = openaiRes.choices?.[0];
    const text = choice?.message?.content || "";
    const stopReason =
      choice?.finish_reason === "length" ? "max_tokens" : "end_turn";

    const anthropicRes = {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: SPOOF_MODEL,
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: {
        input_tokens: openaiRes.usage?.prompt_tokens || 0,
        output_tokens: openaiRes.usage?.completion_tokens || 0,
      },
    };

    console.log(
      `← Response: ${text.slice(0, 80)}... (${anthropicRes.usage.output_tokens} tokens)`,
    );

    // ── 5. 返回给 Claude Code ──
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicRes));
  } catch (err) {
    console.error("Proxy error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: String(err) },
      }),
    );
  }
});

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   HydraProxy Iteration 2 — Minimal    ║
╠════════════════════════════════════════╣
║   Port:   :${PORT}                      ║
║   Target: ${TARGET_MODEL.padEnd(29)}║
║   Spoof:  ${SPOOF_MODEL.padEnd(29)}║
║   Mode:   text-only, no streaming      ║
╚════════════════════════════════════════╝
  `);
});
