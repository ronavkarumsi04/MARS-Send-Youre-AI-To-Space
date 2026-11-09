import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  ModelConfig,
  ProviderConfig,
  StreamEvent,
} from "@mars/contracts";
import type { AdapterOptions, ProviderAdapter } from "./adapter-types";
import { ProviderError } from "./errors";
import {
  asObject,
  assertOk,
  hasErrorEnvelope,
  type JsonObject,
  parseSseJson,
  parseToolArguments,
  providerEnvelopeError,
  readJson,
  readSseFrames,
  requireToolCall,
  sendProviderRequest,
  streamBody,
  streamFailure,
  tokenCount,
  unexpectedResponseShape,
  usageFrom,
} from "./http";

function contentText(
  content: string | { type: "text"; text: string }[],
): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text).join("");
}

function anthropicMessages(messages: ChatMessage[]): JsonObject[] {
  const result: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: contentText(message.content),
          },
        ],
      });
      continue;
    }
    if (message.role === "user") {
      result.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => ({
                type: "text",
                text: part.text,
              })),
      });
      continue;
    }
    const blocks: JsonObject[] = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      blocks.push(
        ...message.content.map((part) => ({ type: "text", text: part.text })),
      );
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      });
    }
    result.push({ role: "assistant", content: blocks });
  }
  return result;
}

function anthropicRequestBody(
  request: ChatRequest,
  model: ModelConfig,
  stream: boolean,
): JsonObject {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n");
  return {
    model: model.model,
    max_tokens: request.maxTokens ?? 1024,
    messages: anthropicMessages(request.messages),
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

export function createAnthropicAdapter(
  provider: ProviderConfig,
  options: AdapterOptions = {},
): ProviderAdapter {
  const fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  function send(body: JsonObject, accept: string) {
    const headers = new Headers(provider.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", accept);
    headers.set("anthropic-version", "2023-06-01");
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (apiKey) headers.set("x-api-key", apiKey);
    return sendProviderRequest({
      providerId: provider.id,
      fetch: fetcher,
      url: `${baseUrl}/v1/messages`,
      headers,
      body,
      timeoutMs,
    });
  }

  async function complete(
    request: ChatRequest,
    model: ModelConfig,
  ): Promise<ChatResponse> {
    const { response, signal, cleanup } = await send(
      anthropicRequestBody(request, model, false),
      "application/json",
    );
    try {
      assertOk(provider.id, response);
      const payload = await readJson(provider.id, response, signal);
      if (hasErrorEnvelope(payload)) {
        throw providerEnvelopeError(provider.id, asObject(payload.error));
      }
      const contentBlocks = payload.content;
      const stopReason = payload.stop_reason;
      if (
        payload.type !== "message" ||
        !Array.isArray(contentBlocks) ||
        !Object.hasOwn(payload, "stop_reason") ||
        (typeof stopReason !== "string" && stopReason !== null)
      ) {
        throw unexpectedResponseShape(provider.id);
      }
      const isTextBlock = (block: JsonObject) =>
        block.type === "text" && typeof block.text === "string";
      if (
        contentBlocks.length > 0 &&
        !contentBlocks.some((rawBlock) => {
          const block = asObject(rawBlock);
          return isTextBlock(block) || block.type === "tool_use";
        })
      ) {
        throw unexpectedResponseShape(provider.id);
      }
      const content: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const rawBlock of contentBlocks) {
        const block = asObject(rawBlock);
        if (isTextBlock(block)) {
          content.push(block.text as string);
        } else if (block.type === "tool_use") {
          toolCalls.push(
            requireToolCall(
              { id: block.id, name: block.name, arguments: block.input },
              provider.id,
            ),
          );
        }
      }
      const usage = usageFrom(payload.usage, "input_tokens", "output_tokens");
      return {
        content: content.join(""),
        toolCalls,
        finishReason: typeof stopReason === "string" ? stopReason : null,
        ...(usage ? { usage } : {}),
        model: typeof payload.model === "string" ? payload.model : model.model,
        providerId: provider.id,
      };
    } finally {
      cleanup();
    }
  }

  async function* stream(
    request: ChatRequest,
    model: ModelConfig,
  ): AsyncGenerator<StreamEvent> {
    const { response, cleanup } = await send(
      anthropicRequestBody(request, model, true),
      "text/event-stream",
    );
    try {
      assertOk(provider.id, response);
      const body = streamBody(provider.id, response);

      let content = "";
      let finishReason: string | null = null;
      let responseModel = model.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let emittedContent = false;
      let messageStopped = false;
      const partialTools = new Map<
        number,
        { id: unknown; name: unknown; input: unknown; partialJson: string }
      >();

      try {
        for await (const frame of readSseFrames(body)) {
          const payload = parseSseJson(provider.id, frame.data);
          const eventType =
            frame.event ||
            (typeof payload.type === "string" ? payload.type : "");
          if (eventType === "error" || hasErrorEnvelope(payload)) {
            throw providerEnvelopeError(
              provider.id,
              asObject(payload.error ?? payload),
            );
          }

          if (eventType === "message_start") {
            const message = asObject(payload.message);
            if (typeof message.model === "string")
              responseModel = message.model;
            inputTokens =
              tokenCount(asObject(message.usage).input_tokens) ?? inputTokens;
          } else if (eventType === "content_block_start") {
            const index = typeof payload.index === "number" ? payload.index : 0;
            const block = asObject(payload.content_block);
            if (block.type === "text" && typeof block.text === "string") {
              content += block.text;
              emittedContent = true;
              yield { type: "text-delta", text: block.text };
            } else if (block.type === "tool_use") {
              partialTools.set(index, {
                id: block.id,
                name: block.name,
                input: block.input,
                partialJson: "",
              });
            }
          } else if (eventType === "content_block_delta") {
            const index = typeof payload.index === "number" ? payload.index : 0;
            const delta = asObject(payload.delta);
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              content += delta.text;
              emittedContent = true;
              yield { type: "text-delta", text: delta.text };
            } else if (
              delta.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const tool = partialTools.get(index);
              if (tool) tool.partialJson += delta.partial_json;
            }
          } else if (eventType === "message_delta") {
            const delta = asObject(payload.delta);
            if (typeof delta.stop_reason === "string")
              finishReason = delta.stop_reason;
            outputTokens =
              tokenCount(asObject(payload.usage).output_tokens) ?? outputTokens;
          } else if (eventType === "message_stop") {
            messageStopped = true;
            break;
          }
        }
      } catch (cause) {
        throw streamFailure(provider.id, cause, emittedContent);
      }

      if (!messageStopped) {
        throw new ProviderError(
          provider.id,
          "Provider stream ended prematurely before message_stop.",
          { retryable: !emittedContent },
        );
      }

      const toolCalls: ChatToolCall[] = [];
      for (const [, tool] of [...partialTools.entries()].sort(
        ([left], [right]) => left - right,
      )) {
        const toolCall = requireToolCall(
          {
            id: tool.id,
            name: tool.name,
            arguments: tool.partialJson
              ? parseToolArguments(tool.partialJson, provider.id)
              : tool.input,
          },
          provider.id,
        );
        toolCalls.push(toolCall);
        yield { type: "tool-call", toolCall };
      }
      yield {
        type: "done",
        response: {
          content,
          toolCalls,
          finishReason,
          ...(inputTokens !== undefined && outputTokens !== undefined
            ? { usage: { inputTokens, outputTokens } }
            : {}),
          model: responseModel,
          providerId: provider.id,
        },
      };
    } finally {
      cleanup();
    }
  }

  return { complete, stream };
}
