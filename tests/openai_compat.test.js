import { describe, test, expect } from "bun:test";
import { buildRequestBody, convertAnthropicResponse, convertAnthropicChunk, parseStreamChunk, createStreamState } from "../src/executor.js";

describe("OpenAI SDK Compatibility Gaps", () => {
  test("tool_choice is omitted for Anthropic when no tools/functions convert", () => {
    const body = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      tool_choice: { type: "function", function: { name: "missing_tool" } }
    });

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("tool_choice required and specific function still maps when tools exist", () => {
    const tools = [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { location: { type: "string" } } }
      }
    }];

    const required = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      tools,
      tool_choice: "required"
    });
    const specific = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      tools,
      tool_choice: { type: "function", function: { name: "get_weather" } }
    });

    expect(required.tools).toHaveLength(1);
    expect(required.tool_choice).toEqual({ type: "any" });
    expect(specific.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  test("duplicate sanitized modern tool_call_ids map tool results to emitted Anthropic IDs", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call.same",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"first"}' }
          },
          {
            id: "call/same",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"second"}' }
          }
        ]
      },
      { role: "tool", tool_call_id: "call.same", content: "first-result" },
      { role: "tool", tool_call_id: "call/same", content: "second-result" }
    ];

    const body = buildRequestBody("big-pickle", messages, false, true);
    const toolUses = body.messages[0].content.filter((part) => part.type === "tool_use");

    expect(toolUses.map((part) => part.id)).toEqual(["call_same", "call_same_1"]);
    expect(body.messages[1].content[0].tool_use_id).toBe("call_same");
    expect(body.messages[1].content[1].tool_use_id).toBe("call_same_1");
  });

  test("empty assistant message with no tool calls has safe Anthropic content", () => {
    const body = buildRequestBody("big-pickle", [{ role: "assistant", content: null }], false, true);

    expect(body.messages[0].role).toBe("assistant");
    expect(body.messages[0].content).toEqual([{ type: "text", text: " " }]);
  });

  test("parseStreamChunk emits route-like SSE final chunks for message_delta and message_stop", () => {
    const state = createStreamState();
    const delta = parseStreamChunk('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}', true, state);
    const stop = parseStreamChunk('data: {"type":"message_stop"}', true, state);
    const done = parseStreamChunk("data: [DONE]", true, state);

    expect(delta.done).toBe(false);
    expect(delta.data.choices[0].delta).toEqual({});
    expect(delta.data.choices[0].finish_reason).toBe("stop");
    expect(stop).toEqual({ done: true });
    expect(done).toEqual({ done: true });
  });

  test("filters unsupported OpenAI-only params from Anthropic request body", () => {
    const extraParams = {
      n: 2,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      logit_bias: { "50256": -100 },
      logprobs: true,
      top_logprobs: 5,
      response_format: { type: "json_object" },
      user: "user_123",
      parallel_tool_calls: false,
      seed: 42,
    };
    const body = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, extraParams);
    
    const unsupported = [
      "n", "presence_penalty", "frequency_penalty", "logit_bias", "logprobs", 
      "top_logprobs", "response_format", "user", "parallel_tool_calls", "seed"
    ];
    for (const param of unsupported) {
      expect(body[param]).toBeUndefined();
    }
  });

  test("maps max_completion_tokens to max_tokens", () => {
    const body = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      max_completion_tokens: 100
    });
    expect(body.max_tokens).toBe(100);
  });

  test("explicit max_tokens wins when both max_tokens and max_completion_tokens exist", () => {
    const body = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      max_tokens: 200,
      max_completion_tokens: 100
    });
    expect(body.max_tokens).toBe(200);
  });

  test("null or empty content does not produce Anthropic empty string messages", () => {
    const messages = [
      { role: "user", content: null },
      { role: "user", content: "" }
    ];
    const body = buildRequestBody("big-pickle", messages, false, true);
    for (const msg of body.messages) {
      expect(msg.content).not.toBe("");
      expect(msg.content).not.toBeNull();
    }
  });

  test("non-stream tool-only response returns message.content as null", () => {
    const anthropicResponse = {
      id: "msg_tool_only",
      model: "claude-3-opus-20240229",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { location: "Paris" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 10 }
    };
    const response = convertAnthropicResponse(anthropicResponse);
    expect(response.choices[0].message.content).toBeNull();
  });

  test("handles legacy functions and function_call top-level mapping", () => {
    const legacyFunctions = [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { location: { type: "string" } } }
      }
    ];

    // Scenario A: function_call as a string
    const bodyA = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      functions: legacyFunctions,
      function_call: "get_weather"
    });
    expect(bodyA.tools).toBeDefined();
    expect(bodyA.tools[0].name).toBe("get_weather");
    expect(bodyA.tool_choice).toEqual({ type: "tool", name: "get_weather" });

    // Scenario B: function_call as an object
    const bodyB = buildRequestBody("big-pickle", [{ role: "user", content: "Hello" }], false, true, {
      functions: legacyFunctions,
      function_call: { name: "get_weather" }
    });
    expect(bodyB.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  test("assistant message.function_call maps to tool_use block in Anthropic", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        function_call: {
          name: "get_weather",
          arguments: '{"location": "Paris"}'
        }
      }
    ];
    const body = buildRequestBody("big-pickle", messages, false, true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("assistant");
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[0].type).toBe("tool_use");
    expect(body.messages[0].content[0].name).toBe("get_weather");
    expect(body.messages[0].content[0].input).toEqual({ location: "Paris" });
  });

  test("message with role:function maps to tool_result block in Anthropic", () => {
    const messages = [
      {
        role: "function",
        name: "get_weather",
        content: '{"temp": 20}'
      }
    ];
    const body = buildRequestBody("big-pickle", messages, false, true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[0].type).toBe("tool_result");
    expect(body.messages[0].content[0].content).toBe('{"temp": 20}');
  });

  test("deterministic fallback IDs are stable enough for assertions", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        function_call: {
          name: "get_weather",
          arguments: '{"location": "Paris"}'
        }
      },
      {
        role: "function",
        name: "get_weather",
        content: '{"temp": 20}'
      }
    ];
    
    const body1 = buildRequestBody("big-pickle", messages, false, true);
    const body2 = buildRequestBody("big-pickle", messages, false, true);
    
    const id1_assistant = body1.messages[0].content[0].id;
    const id1_tool = body1.messages[1].content[0].tool_use_id;
    
    const id2_assistant = body2.messages[0].content[0].id;
    const id2_tool = body2.messages[1].content[0].tool_use_id;
    
    // The assistant tool_use ID must match the tool/function result tool_use_id
    expect(id1_assistant).toBe(id1_tool);
    
    // The generated IDs must be deterministic and identical across runs with the same input
    expect(id1_assistant).toBe(id2_assistant);
    expect(id1_tool).toBe(id2_tool);
  });

  test("non-stream Anthropic thinking blocks do not leak into OpenAI message content", () => {
    const anthropicResponse = {
      id: "msg_thinking",
      model: "claude-3-7-sonnet-20250219",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "raw chain of thought" },
        { type: "redacted_thinking", data: "encrypted-secret-thinking" },
        { type: "reasoning", reasoning: "hidden reasoning" },
        { type: "signature", signature: "hidden signature" },
        { type: "text", text: "<thinking>hidden tagged reasoning</thinking>Visible answer." },
        {
          type: "tool_use",
          id: "toolu_visible",
          name: "lookup",
          input: { query: "public" }
        }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 7, output_tokens: 11 }
    };

    const response = convertAnthropicResponse(anthropicResponse);
    const message = response.choices[0].message;

    expect(message.content).toBe("Visible answer.");
    expect(message.content).not.toContain("raw chain of thought");
    expect(message.content).not.toContain("encrypted-secret-thinking");
    expect(message.content).not.toContain("thinking");
    expect(message.tool_calls).toEqual([{
      id: "toolu_visible",
      type: "function",
      function: {
        name: "lookup",
        arguments: '{"query":"public"}'
      }
    }]);
  });

  test("streaming Anthropic thinking blocks do not emit OpenAI delta content", () => {
    const state = createStreamState();
    const events = [
      { type: "message_start", message: { id: "msg_stream_thinking", model: "claude-3-7-sonnet-20250219" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "initial hidden thought" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret streamed thought" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "Visible" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " answer" } },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_stream", name: "lookup", input: {} }
      },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"public"}' } }
    ];

    const chunks = events.map((event) => convertAnthropicChunk(event, state)).filter(Boolean);
    const serialized = JSON.stringify(chunks);
    const content = chunks
      .map((chunk) => chunk.data?.choices?.[0]?.delta?.content)
      .filter((part) => typeof part === "string")
      .join("");
    const toolCallChunks = chunks
      .map((chunk) => chunk.data?.choices?.[0]?.delta?.tool_calls?.[0])
      .filter(Boolean);

    expect(serialized).not.toContain("initial hidden thought");
    expect(serialized).not.toContain("secret streamed thought");
    expect(serialized).not.toContain("thinking_delta");
    expect(serialized).not.toContain("<think>");
    expect(content).toBe("Visible answer");
    expect(toolCallChunks).toEqual([
      {
        index: 0,
        id: "toolu_stream",
        type: "function",
        function: { name: "lookup", arguments: "" }
      },
      {
        index: 0,
        function: { arguments: '{"query":"public"}' }
      }
    ]);
  });

  test("streaming OpenAI-compatible think tags are suppressed across split chunks", () => {
    const state = createStreamState();
    const lines = [
      'data: {"id":"chatcmpl_think","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"<thi"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_think","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"nk>secret"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_think","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"</think>visible"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_think","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":null}]}'
    ];

    const chunks = lines.map((line) => parseStreamChunk(line, false, state)).filter(Boolean);
    const serialized = JSON.stringify(chunks);
    const content = chunks
      .map((chunk) => chunk.data?.choices?.[0]?.delta?.content)
      .filter((part) => typeof part === "string")
      .join("");
    const toolCalls = chunks
      .flatMap((chunk) => chunk.data?.choices?.[0]?.delta?.tool_calls || []);

    expect(content).toBe("visible");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("<think>");
    expect(serialized).not.toContain("</think>");
    expect(toolCalls).toEqual([{
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: "{}" }
    }]);
  });

  test("streaming Anthropic reasoning and signature deltas do not emit OpenAI delta content", () => {
    const state = createStreamState();
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "reasoning", reasoning: "hidden start" } },
      { type: "content_block_delta", index: 0, delta: { type: "reasoning_delta", reasoning: "hidden reasoning" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", reasoning_content: "hidden alias" } },
      { type: "content_block_start", index: 1, content_block: { type: "signature", signature: "hidden signature start" } },
      { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "hidden signature" } },
      { type: "content_block_start", index: 2, content_block: { type: "text", text: "Visible" } },
      { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: " answer" } }
    ];

    const chunks = events.map((event) => convertAnthropicChunk(event, state)).filter(Boolean);
    const serialized = JSON.stringify(chunks);
    const content = chunks
      .map((chunk) => chunk.data?.choices?.[0]?.delta?.content)
      .filter((part) => typeof part === "string")
      .join("");

    expect(content).toBe("Visible answer");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("signature");
  });

  test("streaming Anthropic text think tags are suppressed across split chunks", () => {
    const state = createStreamState();
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "<thin" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "king>hidden" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "</thinking>Visible" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " answer" } }
    ];

    const chunks = events.map((event) => convertAnthropicChunk(event, state)).filter(Boolean);
    const serialized = JSON.stringify(chunks);
    const content = chunks
      .map((chunk) => chunk.data?.choices?.[0]?.delta?.content)
      .filter((part) => typeof part === "string")
      .join("");

    expect(content).toBe("Visible answer");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("<thinking>");
    expect(serialized).not.toContain("</thinking>");
  });
});
