import { describe, it, expect } from 'vitest';
import {
  // Anthropic
  zCreateMessageParams,
  zMessage,
  zInputMessage,
  zContentBlock,
  zTool,
  zToolChoice,
  zUsage,

  // OpenAI
  zCreateChatCompletionResponse,
  zChatCompletionRequestMessage,
  zChatCompletionRequestSystemMessage,
  zChatCompletionRequestUserMessage,
  zChatCompletionRequestAssistantMessage,
  zChatCompletionRequestToolMessage,
  zChatCompletionMessageToolCall,
  zChatCompletionTool,
  zCompletionUsage,
} from '../index.js';

// ─── Anthropic Schemas ───────────────────────────────────────

describe('Anthropic schemas', () => {
  describe('zCreateMessageParams', () => {
    it('accepts a valid messages request', () => {
      const request = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello, Claude!' },
        ],
      };
      const result = zCreateMessageParams.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('accepts a request with tools and structured content', () => {
      const request = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: 'You are a helpful assistant.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is the weather?' },
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01abc',
                name: 'get_weather',
                input: { location: 'San Francisco' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01abc',
                content: '72°F, sunny',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            input_schema: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
        tool_choice: { type: 'auto' },
        temperature: 0.7,
        stream: false,
      };
      const result = zCreateMessageParams.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects a request missing required max_tokens', () => {
      const request = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = zCreateMessageParams.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  describe('zMessage (response)', () => {
    it('accepts a valid text response', () => {
      const response = {
        id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! How can I help you?' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 15 },
      };
      const result = zMessage.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('accepts a tool_use response', () => {
      const response = {
        id: 'msg_02abc',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the weather.' },
          {
            type: 'tool_use',
            id: 'toolu_01abc',
            name: 'get_weather',
            input: { location: 'NYC' },
          },
        ],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 30 },
      };
      const result = zMessage.safeParse(response);
      expect(result.success).toBe(true);
    });
  });

  describe('zInputMessage', () => {
    it('accepts string content', () => {
      const result = zInputMessage.safeParse({
        role: 'user',
        content: 'Hello',
      });
      expect(result.success).toBe(true);
    });

    it('accepts array content blocks', () => {
      const result = zInputMessage.safeParse({
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('zContentBlock', () => {
    it('accepts a text block', () => {
      const result = zContentBlock.safeParse({ type: 'text', text: 'Hi' });
      expect(result.success).toBe(true);
    });

    it('accepts a tool_use block', () => {
      const result = zContentBlock.safeParse({
        type: 'tool_use',
        id: 'toolu_01',
        name: 'fn',
        input: {},
      });
      expect(result.success).toBe(true);
    });
  });

  describe('zTool', () => {
    it('accepts a valid tool definition', () => {
      const result = zTool.safeParse({
        name: 'search',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('zToolChoice', () => {
    it.each([
      { type: 'auto' },
      { type: 'any' },
      { type: 'tool', name: 'search' },
    ])('accepts %o', (choice) => {
      expect(zToolChoice.safeParse(choice).success).toBe(true);
    });
  });

  describe('zUsage', () => {
    it('accepts valid usage', () => {
      const result = zUsage.safeParse({
        input_tokens: 100,
        output_tokens: 50,
      });
      expect(result.success).toBe(true);
    });
  });
});

// ─── OpenAI Schemas ──────────────────────────────────────────

describe('OpenAI schemas', () => {
  describe('zChatCompletionRequestMessage', () => {
    it('accepts a system message', () => {
      const msg = { role: 'system', content: 'You are helpful.' };
      expect(zChatCompletionRequestSystemMessage.safeParse(msg).success).toBe(true);
      expect(zChatCompletionRequestMessage.safeParse(msg).success).toBe(true);
    });

    it('accepts a user message', () => {
      const msg = { role: 'user', content: 'Hello' };
      expect(zChatCompletionRequestUserMessage.safeParse(msg).success).toBe(true);
      expect(zChatCompletionRequestMessage.safeParse(msg).success).toBe(true);
    });

    it('accepts an assistant message with tool_calls', () => {
      const msg = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
          },
        ],
      };
      expect(zChatCompletionRequestAssistantMessage.safeParse(msg).success).toBe(true);
      expect(zChatCompletionRequestMessage.safeParse(msg).success).toBe(true);
    });

    it('accepts a tool result message', () => {
      const msg = {
        role: 'tool',
        tool_call_id: 'call_abc123',
        content: '72°F',
      };
      expect(zChatCompletionRequestToolMessage.safeParse(msg).success).toBe(true);
      expect(zChatCompletionRequestMessage.safeParse(msg).success).toBe(true);
    });
  });

  describe('zChatCompletionMessageToolCall', () => {
    it('accepts a valid tool call', () => {
      const result = zChatCompletionMessageToolCall.safeParse({
        id: 'call_abc',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"test"}' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('zChatCompletionTool', () => {
    it('accepts a valid tool definition', () => {
      const result = zChatCompletionTool.safeParse({
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('zCreateChatCompletionResponse', () => {
    it('accepts a valid chat completion response', () => {
      const response = {
        id: 'chatcmpl-abc123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help?',
              refusal: null,
            },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
        },
      };
      const result = zCreateChatCompletionResponse.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('accepts a response with tool_calls', () => {
      const response = {
        id: 'chatcmpl-tool123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              refusal: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      };
      const result = zCreateChatCompletionResponse.safeParse(response);
      expect(result.success).toBe(true);
    });
  });

  describe('zCompletionUsage', () => {
    it('accepts valid usage', () => {
      const result = zCompletionUsage.safeParse({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });
      expect(result.success).toBe(true);
    });
  });
});

// ─── Cross-cutting: barrel re-exports ────────────────────────

describe('barrel re-exports', () => {
  it('all exported schemas are Zod schemas with safeParse', () => {
    const schemas = [
      zCreateMessageParams,
      zMessage,
      zInputMessage,
      zContentBlock,
      zTool,
      zToolChoice,
      zUsage,
      zCreateChatCompletionResponse,
      zChatCompletionRequestMessage,
      zChatCompletionMessageToolCall,
      zChatCompletionTool,
      zCompletionUsage,
    ];
    for (const schema of schemas) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });
});
