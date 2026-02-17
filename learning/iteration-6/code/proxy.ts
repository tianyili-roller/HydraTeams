#!/usr/bin/env npx tsx

/**
 * HydraProxy — Iteration 6: Edge Cases & 健壮性
 *
 * 在 Iteration 5 基础上加入：
 * - 429 指数退避重试 (MAX_RETRIES=5)
 * - Non-streaming 回退 (stream: false)
 * - Token counting endpoint (/v1/messages/count_tokens)
 * - Error 格式翻译 (OpenAI error → Anthropic error)
 * - Health check (GET / 和 /health)
 *
 * 运行: OPENAI_API_KEY=sk-xxx npx tsx proxy.ts
 */

import http from "node:http";
import { get_encoding } from "tiktoken";

// ─── Tokenizer ─────────────────────────────────────────────────
// o200k_base is the encoding used by GPT-4o / GPT-5 family.
// Initialize once at startup; reuse across all requests.
const tokenEncoder = get_encoding("o200k_base");

// ─── Config ─────────────────────────────────────────────────────
const PORT = 3456;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TARGET_MODEL = "gpt-5.2";
const SPOOF_MODEL = "claude-sonnet-4-5-20250929";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MAX_RETRIES = 5;

if (!OPENAI_API_KEY) {
  console.error("Error: Set OPENAI_API_KEY environment variable");
  process.exit(1);
}

// ─── Anthropic Types ────────────────────────────────────────────

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

// ─── OpenAI Types ───────────────────────────────────────────────

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ─── Stream Types ───────────────────────────────────────────────

interface TrackedToolCall {
  id: string;
  name: string;
  anthropicIndex: number;
}

interface StreamState {
  blockIndex: number;
  textBlockStarted: boolean;
  activeToolCalls: Map<number, TrackedToolCall>;
}

// ─── Token Parameter Compatibility ──────────────────────────────

function needsMaxCompletionTokens(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model);
}

// ─── Helpers ────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendSSE(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * 把 HTTP status code 映射到 Anthropic error type。
 * Claude Code 根据这个 type 来决定是否重试。
 */
function mapErrorType(status: number): string {
  if (status === 429) return "rate_limit_error";
  if (status === 401) return "authentication_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

// ═══════════════════════════════════════════════════════════════
// REQUEST TRANSLATION (unchanged from Iteration 5)
// ═══════════════════════════════════════════════════════════════

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
  choice?: AnthropicToolChoice,
): string | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto": return "auto";
    case "any":  return "required";
    case "tool": return { type: "function", function: { name: choice.name } };
    case "none": return "none";
  }
}

function translateMessages(
  system: string | AnthropicSystemBlock[] | undefined,
  messages: AnthropicMessage[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (system) {
    const text = typeof system === "string"
      ? system
      : system.map(b => b.text).join("\n");
    result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(translateAssistantMessage(msg));
    } else {
      result.push(...translateUserMessage(msg));
    }
  }

  return result;
}

function translateAssistantMessage(msg: AnthropicMessage): OpenAIMessage {
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content };
  }

  const blocks = msg.content;
  const textParts = blocks.filter(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  const toolUses = blocks.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
      b.type === "tool_use"
  );

  const result: OpenAIMessage & { role: "assistant" } = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.map(b => b.text).join("") : null,
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

function translateUserMessage(msg: AnthropicMessage): OpenAIMessage[] {
  if (typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  const blocks = msg.content;
  const toolResults = blocks.filter(
    (b): b is { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean } =>
      b.type === "tool_result"
  );

  if (toolResults.length === 0) {
    const text = blocks.map(b => b.type === "text" ? b.text : "").join("");
    return [{ role: "user", content: text }];
  }

  const result: OpenAIMessage[] = [];

  for (const tr of toolResults) {
    result.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: typeof tr.content === "string"
        ? tr.content
        : JSON.stringify(tr.content),
    });
  }

  const otherBlocks = blocks.filter(b => b.type !== "tool_result");
  if (otherBlocks.length > 0) {
    const text = otherBlocks.map(b => b.type === "text" ? b.text : "").join("");
    if (text) {
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE TRANSLATION — Streaming (unchanged from Iteration 5)
// ═══════════════════════════════════════════════════════════════

async function translateStream(
  upstreamBody: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const state: StreamState = {
    blockIndex: 0,
    textBlockStarted: false,
    activeToolCalls: new Map(),
  };

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

  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice(6);

        if (payload === "[DONE]") {
          sendSSE(res, "message_stop", { type: "message_stop" });
          res.end();
          return;
        }

        let chunk: {
          choices?: Array<{
            delta: {
              role?: string;
              content?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason: string | null;
          }>;
          usage?: { completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (chunk.usage?.completion_tokens) {
          outputTokens = chunk.usage.completion_tokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (delta.content) {
          if (!state.textBlockStarted) {
            sendSSE(res, "content_block_start", {
              type: "content_block_start",
              index: state.blockIndex,
              content_block: { type: "text", text: "" },
            });
            state.textBlockStarted = true;
          }
          sendSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const toolIndex = tc.index;

            if (tc.id) {
              if (state.textBlockStarted) {
                sendSSE(res, "content_block_stop", {
                  type: "content_block_stop",
                  index: state.blockIndex,
                });
                state.blockIndex++;
                state.textBlockStarted = false;
              }

              state.activeToolCalls.set(toolIndex, {
                id: tc.id,
                name: tc.function?.name || "",
                anthropicIndex: state.blockIndex,
              });

              sendSSE(res, "content_block_start", {
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

            if (tc.function?.arguments) {
              const tracked = state.activeToolCalls.get(toolIndex);
              if (tracked) {
                sendSSE(res, "content_block_delta", {
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

        if (choice.finish_reason) {
          if (state.textBlockStarted) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: state.blockIndex,
            });
          }

          for (const [, tc] of state.activeToolCalls) {
            sendSSE(res, "content_block_stop", {
              type: "content_block_stop",
              index: tc.anthropicIndex,
            });
          }

          const stopReason =
            choice.finish_reason === "tool_calls" ? "tool_use"
              : choice.finish_reason === "length" ? "max_tokens"
              : "end_turn";

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

  res.end();
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE TRANSLATION — Non-streaming（新增！）
// ═══════════════════════════════════════════════════════════════

/**
 * 翻译 non-streaming OpenAI 响应为 Anthropic 格式。
 * 处理 text + tool_calls 混合响应。
 */
function translateNonStreamingResponse(
  openaiRes: {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  },
): string {
  const choice = openaiRes.choices?.[0];
  const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = [];

  // 文本
  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Tool calls → tool_use blocks
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

  const stopReason =
    choice?.finish_reason === "tool_calls" ? "tool_use"
      : choice?.finish_reason === "length" ? "max_tokens"
      : "end_turn";

  return JSON.stringify({
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
  });
}

// ═══════════════════════════════════════════════════════════════
// SERVER — 多路由 + 重试 + 错误处理
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || "").split("?")[0];

  // ─── Health Check（新增！）───
  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      targetModel: TARGET_MODEL,
      spoofModel: SPOOF_MODEL,
    }));
    return;
  }

  // ─── Count Tokens（新增！）───
  if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      // 用 tiktoken 精确计算 token 数
      const text = JSON.stringify(parsed.messages || []);
      const estimatedTokens = tokenEncoder.encode(text).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: Math.ceil(estimatedTokens) }));
    } catch {
      // 解析失败，返回保守默认值
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1000 }));
    }
    return;
  }

  // ─── Only POST /v1/messages ───
  if (req.method !== "POST" || pathname !== "/v1/messages") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: "Not found" } }));
    return;
  }

  try {
    const body = JSON.parse(await readBody(req));

    // ── 翻译消息 ──
    const openaiMessages = translateMessages(body.system, body.messages);
    const isStreaming = body.stream !== false;

    // ── 构造 OpenAI 请求 ──
    const maxTokens = Math.min(body.max_tokens || 4096, 16384);
    const openaiReq: Record<string, unknown> = {
      model: TARGET_MODEL,
      messages: openaiMessages,
      ...(needsMaxCompletionTokens(TARGET_MODEL)
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens }),
    };

    // Streaming 设置（新增：non-streaming 分支不加 stream_options）
    if (isStreaming) {
      openaiReq.stream = true;
      openaiReq.stream_options = { include_usage: true };
    } else {
      openaiReq.stream = false;
    }

    if (body.tools && body.tools.length > 0) {
      openaiReq.tools = body.tools.map(translateToolDef);
    }

    const toolChoice = translateToolChoice(body.tool_choice);
    if (toolChoice !== undefined) {
      openaiReq.tool_choice = toolChoice;
    }

    console.log(`→ ${TARGET_MODEL} (${body.messages?.length || 0} msgs, ${body.tools?.length || 0} tools, stream=${isStreaming})`);

    // ── 发给 OpenAI（新增：429 重试！）──
    let upstream: Response | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      upstream = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(openaiReq),
      });

      if (upstream.status !== 429) break;

      if (attempt < MAX_RETRIES) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.log(`  ⏳ Rate limited (429), retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    // ── 错误处理（新增：Anthropic 格式错误）──
    if (!upstream || !upstream.ok) {
      const errText = upstream ? await upstream.text() : "No response";
      const status = upstream?.status || 500;
      console.error(`← Error ${status}: ${errText.slice(0, 200)}`);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: mapErrorType(status), message: errText },
      }));
      return;
    }

    // ── Non-streaming 回退（新增！）──
    if (!isStreaming) {
      const openaiRes = await upstream.json();
      const translated = translateNonStreamingResponse(openaiRes as Parameters<typeof translateNonStreamingResponse>[0]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(translated);
      console.log(`← Non-streaming response complete`);
      return;
    }

    // ── Streaming ──
    if (!upstream.body) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "No body" } }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    await translateStream(upstream.body, res);
    console.log(`← Stream complete`);

  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal proxy error";
    console.error("Proxy error:", message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    }));
  }
});

// ─── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   HydraProxy Iteration 6 — Edge Cases & Robustness  ║
╠══════════════════════════════════════════════════════╣
║   Port:       :${PORT}                                ║
║   Target:     ${TARGET_MODEL.padEnd(41)}║
║   Spoof:      ${SPOOF_MODEL.padEnd(41)}║
║   Retries:    ${String(MAX_RETRIES).padEnd(41)}║
║   Endpoints:  /v1/messages                           ║
║               /v1/messages/count_tokens              ║
║               /health                                ║
╚══════════════════════════════════════════════════════╝
  `);
});
