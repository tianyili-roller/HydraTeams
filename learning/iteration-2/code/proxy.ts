#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 2: 最简版本 + Zod runtime validation
 *
 * 纯文本，无流式，无 tools。
 * 把 Anthropic Messages API 请求翻译成 OpenAI Chat Completions，再把响应翻译回来。
 * 每一步都用项目 src/schemas 中的 Zod schema 做运行时校验。
 *
 * 运行: OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
 * 测试: curl -X POST http://localhost:3456/v1/messages \
 *        -H "Content-Type: application/json" \
 *        -d '{"model":"claude-sonnet-4-5-20250929","system":"You are helpful.","messages":[{"role":"user","content":"Say hi"}],"max_tokens":100,"stream":false}'
 */

import http from "node:http";
import {
  // Anthropic
  zCreateMessageParams,
  zMessage,
  // OpenAI
  zCreateChatCompletionRequest,
  zCreateChatCompletionResponse,
} from "../../../src/schemas/index.js";

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
    // ── 1. 读取并校验 Anthropic 请求体 ──
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = JSON.parse(Buffer.concat(chunks).toString());

    const inboundParsed = zCreateMessageParams.safeParse(raw);
    if (!inboundParsed.success) {
      console.error("✗ Invalid Anthropic request:", inboundParsed.error.issues);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: inboundParsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
          },
        }),
      );
      return;
    }
    const anthropicReq = inboundParsed.data;

    // ── 2. 翻译请求: Anthropic → OpenAI ──
    const openaiMessages: Array<{ role: string; content: string }> = [];

    // System prompt → system message
    if (anthropicReq.system) {
      const text =
        typeof anthropicReq.system === "string"
          ? anthropicReq.system
          : anthropicReq.system.map((b) => b.text).join("\n");
      openaiMessages.push({ role: "system", content: text });
    }

    // Messages（简化：只处理 string content 和 text blocks）
    for (const msg of anthropicReq.messages) {
      openaiMessages.push({
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .map((b) => ("text" in b ? b.text : ""))
                .join(""),
      });
    }

    const openaiReqBody = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      max_tokens: Math.min(anthropicReq.max_tokens, 16384),
      stream: false,
    };

    // ── 2b. 校验翻译后的 OpenAI 请求 ──
    const openaiReqParsed =
      zCreateChatCompletionRequest.safeParse(openaiReqBody);
    if (!openaiReqParsed.success) {
      console.error(
        "✗ Invalid OpenAI request:",
        openaiReqParsed.error.issues,
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Failed to construct valid OpenAI request: ${openaiReqParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          },
        }),
      );
      return;
    }

    console.log(
      `→ Translating: ${anthropicReq.model} → ${TARGET_MODEL} (${anthropicReq.messages.length} msgs)`,
    );

    // ── 3. 发给 OpenAI ──
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(openaiReqParsed.data),
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

    // ── 3b. 校验 OpenAI 响应 ──
    const openaiResRaw = await upstream.json();
    const openaiResParsed =
      zCreateChatCompletionResponse.safeParse(openaiResRaw);
    if (!openaiResParsed.success) {
      console.error(
        "✗ Invalid OpenAI response:",
        openaiResParsed.error.issues,
      );
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Invalid upstream response: ${openaiResParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          },
        }),
      );
      return;
    }
    const openaiRes = openaiResParsed.data;

    // ── 4. 翻译响应: OpenAI → Anthropic ──
    const choice = openaiRes.choices[0];
    const text = choice.message.content || "";
    const stopReason =
      choice.finish_reason === "length" ? "max_tokens" : "end_turn";

    const anthropicResBody = {
      id: `msg_${Date.now()}`,
      type: "message" as const,
      role: "assistant" as const,
      model: SPOOF_MODEL,
      content: [{ type: "text" as const, text, citations: null }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: openaiRes.usage?.prompt_tokens ?? 0,
        output_tokens: openaiRes.usage?.completion_tokens ?? 0,
      },
    };

    // ── 4b. 校验翻译后的 Anthropic 响应 ──
    const anthropicResParsed = zMessage.safeParse(anthropicResBody);
    if (!anthropicResParsed.success) {
      console.error(
        "✗ Invalid Anthropic response:",
        anthropicResParsed.error.issues,
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `Failed to construct valid Anthropic response: ${anthropicResParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          },
        }),
      );
      return;
    }

    console.log(
      `← Response: ${text.slice(0, 80)}... (${anthropicResParsed.data.usage.output_tokens} tokens)`,
    );

    // ── 5. 返回给 Claude Code ──
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicResParsed.data));
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
║   Zod:    runtime validation enabled   ║
╚════════════════════════════════════════╝
  `);
});
