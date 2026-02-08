import type {
  AnthropicMessage,
  AnthropicSystemBlock,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  OpenAIMessage,
  OpenAIAssistantMessage,
} from "./types.js";

/**
 * Translate Anthropic message history (including system prompt) to OpenAI format.
 */
export function translateMessages(
  system: string | AnthropicSystemBlock[] | undefined,
  messages: AnthropicMessage[]
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // System prompt → system message
  if (system) {
    const text =
      typeof system === "string"
        ? system
        : system.map((b) => b.text).join("\n");
    result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(translateAssistantMessage(msg));
    } else {
      // User messages may contain tool_result blocks mixed with other content
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      const blocks = msg.content;
      const toolResults = blocks.filter(
        (b): b is AnthropicToolResultBlock => b.type === "tool_result"
      );

      if (toolResults.length > 0) {
        // Each tool_result becomes a separate "tool" role message
        for (const tr of toolResults) {
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content:
              typeof tr.content === "string"
                ? tr.content
                : JSON.stringify(tr.content),
          });
        }

        // Any non-tool_result content becomes a user message
        const otherContent = blocks.filter(
          (b): b is AnthropicTextBlock => b.type !== "tool_result"
        );
        if (otherContent.length > 0) {
          result.push({
            role: "user",
            content: otherContent.map((b) => extractText(b)).join(""),
          });
        }
      } else {
        // Plain user message with content blocks
        result.push({
          role: "user",
          content: blocks.map((b) => extractText(b)).join(""),
        });
      }
    }
  }

  return result;
}

function translateAssistantMessage(msg: AnthropicMessage): OpenAIAssistantMessage {
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content };
  }

  const blocks = msg.content;
  const textParts = blocks.filter(
    (b): b is AnthropicTextBlock => b.type === "text"
  );
  const toolUses = blocks.filter(
    (b): b is AnthropicToolUseBlock => b.type === "tool_use"
  );

  const result: OpenAIAssistantMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.map((b) => b.text).join("") : null,
  };

  if (toolUses.length > 0) {
    result.tool_calls = toolUses.map((tu) => ({
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

function extractText(block: AnthropicContentBlock): string {
  if (block.type === "text") return block.text;
  return "";
}
