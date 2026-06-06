import { describe, test, expect } from "bun:test";
import { buildRequestBody, convertAnthropicChunk, convertAnthropicResponse, createStreamState } from "../src/executor.js";

describe("OpenAI Passthrough (Non-Anthropic models)", () => {
  test("preserves tools, tool_choice, temperature, and max_tokens in request body", () => {
    const messages = [{ role: "user", content: "What's the weather?" }];
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" }
            },
            required: ["location"]
          }
        }
      }
    ];

    const extraParams = {
      tools,
      tool_choice: "auto",
      temperature: 0.7,
      max_tokens: 100
    };

    // Standard OpenAI endpoint (isMessagesEndpoint = false)
    const body = buildRequestBody("deepseek-v4-flash-free", messages, false, false, extraParams);
    
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(100);
  });
});

describe("Anthropic Request Conversion (isMessagesEndpoint = true)", () => {
  test("maps OpenAI tools/tool_choice/tool messages/assistant tool_calls", () => {
    // Test that buildRequestBody maps OpenAI tool schema to Anthropic tool schema.
    const openaiTools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"]
          }
        }
      }
    ];

    const messages = [
      {
        role: "user",
        content: "What's the weather in Paris?"
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location": "Paris"}'
            }
          }
        ]
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: '{"temp": 15}'
      }
    ];

    const extraParams = {
      tools: openaiTools,
      tool_choice: { type: "function", function: { name: "get_weather" } }
    };

    const body = buildRequestBody("big-pickle", messages, false, true, extraParams);

    // 1. Anthropic tools schema mapping: input_schema instead of parameters
    expect(body.tools).toBeDefined();
    expect(body.tools[0].name).toBe("get_weather");
    expect(body.tools[0].input_schema).toEqual(openaiTools[0].function.parameters);
    expect(body.tools[0].description).toBe("Get current weather");

    // 2. Anthropic tool_choice mapping:
    // OpenAI: { type: "function", function: { name: "get_weather" } }
    // Anthropic: { type: "tool", name: "get_weather" }
    expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });

    // 3. Anthropic message roles / contents mapping:
    // OpenAI: assistant message with tool_calls -> Anthropic: assistant message with tool_use block in content
    // OpenAI: tool message with tool_call_id and content -> Anthropic: user message with tool_result block in content
    expect(body.messages).toHaveLength(3);
    
    // Assistant message mapping
    expect(body.messages[1].role).toBe("assistant");
    expect(Array.isArray(body.messages[1].content)).toBe(true);
    expect(body.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: "call_123",
      name: "get_weather",
      input: { location: "Paris" }
    });

    // Tool result mapping (should map to "user" role with type: "tool_result")
    expect(body.messages[2].role).toBe("user");
    expect(Array.isArray(body.messages[2].content)).toBe(true);
    expect(body.messages[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_123",
      content: '{"temp": 15}'
    });
  });

  test("omits Anthropic tools and tool_choice when OpenAI tool_choice is none", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: { type: "object", properties: {} }
        }
      }
    ];

    const body = buildRequestBody(
      "big-pickle",
      [{ role: "user", content: "Do not call tools." }],
      false,
      true,
      { tools, tool_choice: "none" }
    );

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});

describe("Anthropic Response Conversion (Non-Streaming)", () => {
  test("maps tool_use to choices[0].message.tool_calls", () => {
    // Mock Anthropic response body containing tool_use
    const anthropicResponse = {
      id: "msg_01X",
      model: "claude-3-opus-20240229",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Let me check that for you."
        },
        {
          type: "tool_use",
          id: "toolu_xyz",
          name: "get_weather",
          input: { location: "Paris" }
        }
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        output_tokens: 15
      }
    };

    const openaiResponse = convertAnthropicResponse(anthropicResponse);

    expect(openaiResponse.choices[0].message.content).toBe("Let me check that for you.");
    expect(openaiResponse.choices[0].finish_reason).toBe("tool_calls");
    expect(openaiResponse.choices[0].message.tool_calls).toBeDefined();
    expect(openaiResponse.choices[0].message.tool_calls).toHaveLength(1);
    expect(openaiResponse.choices[0].message.tool_calls[0]).toEqual({
      id: "toolu_xyz",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"location":"Paris"}'
      }
    });
  });
  test("maps Anthropic stop reasons to OpenAI finish reasons", () => {
    const base = {
      id: "msg_stop",
      model: "claude-3-opus-20240229",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 1, output_tokens: 1 }
    };

    expect(convertAnthropicResponse({ ...base, stop_reason: "tool_use" }).choices[0].finish_reason).toBe("tool_calls");
    expect(convertAnthropicResponse({ ...base, stop_reason: "end_turn" }).choices[0].finish_reason).toBe("stop");
    expect(convertAnthropicResponse({ ...base, stop_reason: "stop_sequence" }).choices[0].finish_reason).toBe("stop");
    expect(convertAnthropicResponse({ ...base, stop_reason: "max_tokens" }).choices[0].finish_reason).toBe("length");
    expect(convertAnthropicResponse({ ...base, stop_reason: "unknown_reason" }).choices[0].finish_reason).toBe("stop");
  });
});

describe("Anthropic Response Conversion (Streaming)", () => {
  test("maps content_block_start tool_use and input_json_delta to OpenAI delta.tool_calls", () => {
    // Mock streaming events for tool use
    
    // Event 1: content_block_start with type: tool_use
    const eventStart = {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_xyz",
        name: "get_weather",
        input: {}
      }
    };

    const streamState = createStreamState();
    const chunkStart = convertAnthropicChunk(eventStart, streamState);
    
    expect(chunkStart).toBeDefined();
    expect(chunkStart.done).toBe(false);
    expect(chunkStart.data.choices[0].delta.tool_calls).toBeDefined();
    expect(chunkStart.data.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: "toolu_xyz",
      type: "function",
      function: {
        name: "get_weather",
        arguments: ""
      }
    });

    // Event 2: content_block_delta with input_json_delta
    const eventDelta = {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: '{"loc'
      }
    };

    const chunkDelta = convertAnthropicChunk(eventDelta, streamState);

    expect(chunkDelta).toBeDefined();
    expect(chunkDelta.done).toBe(false);
    expect(chunkDelta.data.choices[0].delta.tool_calls).toBeDefined();
    expect(chunkDelta.data.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      function: {
        arguments: '{"loc'
      }
    });
  });

  test("uses shared stream state so first tool_call index starts at 0 regardless of Anthropic block index", () => {
    const streamState = createStreamState();

    const first = convertAnthropicChunk({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_first", name: "first_tool", input: {} }
    }, streamState);
    const second = convertAnthropicChunk({
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_second", name: "second_tool", input: {} }
    }, streamState);
    const firstDelta = convertAnthropicChunk({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{}" }
    }, streamState);

    expect(first.data.choices[0].delta.tool_calls[0].index).toBe(0);
    expect(second.data.choices[0].delta.tool_calls[0].index).toBe(1);
    expect(firstDelta.data.choices[0].delta.tool_calls[0].index).toBe(0);
  });
});
