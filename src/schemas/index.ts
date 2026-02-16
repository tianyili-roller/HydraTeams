// ─── Anthropic Messages API ──────────────────────────────────

export {
  // Request / Response
  zCreateMessageParams,
  zMessage,

  // Messages
  zInputMessage,

  // Content blocks — request side
  zRequestTextBlock,
  zRequestToolUseBlock,
  zRequestToolResultBlock,
  zRequestImageBlock,

  // Content blocks — response side
  zContentBlock,
  zResponseTextBlock,
  zResponseToolUseBlock,

  // Tools
  zTool,
  zToolChoice,
  zToolChoiceAny,
  zToolChoiceAuto,
  zToolChoiceTool,
  zInputSchema,

  // Metadata & usage
  zMetadata,
  zUsage,
  zModel,

  // Streaming
  zMessageStreamEvent,
  zMessageStartEvent,
  zMessageDeltaEvent,
  zContentBlockStartEvent,
  zContentBlockDeltaEvent,
  zContentBlockStopEvent,
  zMessageStopEvent,
} from './generated/anthropic/zod.gen.js';

// ─── OpenAI Chat Completions API ─────────────────────────────

export {
  // Request / Response
  zCreateChatCompletionRequest,
  zCreateChatCompletionResponse,
  zCreateChatCompletionStreamResponse,

  // Messages
  zChatCompletionRequestMessage,
  zChatCompletionRequestSystemMessage,
  zChatCompletionRequestUserMessage,
  zChatCompletionRequestAssistantMessage,
  zChatCompletionRequestToolMessage,
  zChatCompletionResponseMessage,

  // Tool calls
  zChatCompletionMessageToolCall,
  zChatCompletionMessageToolCalls,
  zChatCompletionMessageToolCallChunk,
  zChatCompletionTool,
  zChatCompletionToolChoiceOption,
  zChatCompletionNamedToolChoice,

  // Streaming
  zChatCompletionStreamResponseDelta,
  zChatCompletionStreamOptions,

  // Usage
  zCompletionUsage,
} from './generated/openai/zod.gen.js';
