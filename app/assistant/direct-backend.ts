import { streamAnthropicMessage } from "../native/anthropic";
import { streamLocalQwen } from "../native/llama";
import { streamOpenAiResponse } from "../native/openai";
import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
  LlmToolDefinition,
} from "./llm-protocol";
import type { AssistantProvider } from "./models";
import type { ToolRegistry } from "./tool-registry";
import type { AssistantTurnCallbacks, AssistantTurnHandle } from "./types";

/**
 * The on-phone agent loop: stream a reply, and while the model asks for tools,
 * execute them through the registry and feed the results back until it stops.
 * History lives in the AssistantSession; this backend appends the assistant
 * and tool-result messages to the array it is handed.
 */

/** Safety caps so a tool-thrashing model can't loop or run forever. */
const MAX_ITERATIONS = 8;
/** The on-phone model is slower per step and unreliable on long tool chains. */
const MAX_ITERATIONS_LOCAL = 4;
const MAX_TURN_MS = 2 * 60 * 1000;

export type DirectTurnOptions = {
  provider: AssistantProvider;
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high";
  system: string;
  /** Owned by the session; this loop appends assistant + tool_result messages. */
  messages: LlmMessage[];
  /**
   * Build the tool list for the next request. Called once per loop iteration so
   * the set reflects apps opening/closing and foreground changes mid-turn; it
   * also refreshes the session's api-name map that resolveToolName reads.
   */
  buildTools: () => LlmToolDefinition[];
  registry: ToolRegistry;
  /** Map an API tool name (as the model calls it) back to its registry name. */
  resolveToolName: (apiName: string) => string;
  callbacks: AssistantTurnCallbacks;
};

export class DirectAssistantBackend {
  runTurn(options: DirectTurnOptions): AssistantTurnHandle {
    const startMs = Date.now();
    let cancelled = false;
    let streamHandle: LlmStreamHandle | null = null;
    let priorText = "";

    const finishError = (message: string) => {
      if (cancelled) return;
      cancelled = true;
      options.callbacks.onError(message);
    };

    const maxIterations = options.provider === "local" ? MAX_ITERATIONS_LOCAL : MAX_ITERATIONS;
    const runIteration = (iteration: number): void => {
      if (cancelled) return;
      if (iteration >= maxIterations) {
        finishError("Assistant stopped: too many tool steps");
        return;
      }
      if (Date.now() - startMs > MAX_TURN_MS) {
        finishError("Assistant stopped: turn took too long");
        return;
      }

      const streamOptions: LlmStreamOptions = {
        apiKey: options.apiKey,
        model: options.model,
        system: options.system,
        effort: options.effort,
        messages: options.messages,
        tools: options.buildTools(),
        onTextDelta: (delta, textSoFar) => {
          if (cancelled) return;
          options.callbacks.onTextDelta(delta, priorText + textSoFar);
        },
        onDone: (result) => {
          streamHandle = null;
          if (cancelled) return;
          if (result.stopReason === "refusal") {
            finishError("The assistant declined this request");
            return;
          }
          const fullText = priorText + result.text;
          options.callbacks.onTextDelta("", fullText);
          priorText = fullText ? `${fullText}\n\n` : "";
          // Record what the model produced this iteration.
          const assistantContent: LlmContentBlock[] = result.content.length
            ? result.content
            : [{ type: "text", text: result.text }];
          options.messages.push({ role: "assistant", content: assistantContent });

          const toolUses = assistantContent.filter(
            (block): block is Extract<LlmContentBlock, { type: "tool_use" }> =>
              block.type === "tool_use",
          );
          if (result.stopReason !== "tool_use" || toolUses.length === 0) {
            options.callbacks.onTurnDone({ stopReason: result.stopReason });
            return;
          }
          void this.runToolCalls(toolUses, options)
            .then((toolResults) => {
              // Always record the results, even if cancelled mid-flight: an
              // assistant tool_use with no matching tool_result would make the
              // next turn's request invalid. Only the loop continuation is gated.
              options.messages.push({ role: "user", content: toolResults });
              if (cancelled) return;
              runIteration(iteration + 1);
            })
            .catch((error) => {
              finishError(`Tool execution failed: ${String((error as Error)?.message ?? error)}`);
            });
        },
        onError: (message) => {
          streamHandle = null;
          finishError(message);
        },
      };
      streamHandle =
        options.provider === "openai"
          ? streamOpenAiResponse(streamOptions)
          : options.provider === "local"
            ? streamLocalQwen(streamOptions)
            : streamAnthropicMessage(streamOptions);
    };

    runIteration(0);

    return {
      cancel: () => {
        cancelled = true;
        streamHandle?.cancel();
        streamHandle = null;
      },
    };
  }

  private async runToolCalls(
    toolUses: Array<Extract<LlmContentBlock, { type: "tool_use" }>>,
    options: DirectTurnOptions,
  ): Promise<LlmContentBlock[]> {
    const results: LlmContentBlock[] = [];
    for (const toolUse of toolUses) {
      const canonicalName = options.resolveToolName(toolUse.name);
      options.callbacks.onToolActivity(canonicalName);
      const result = await options.registry.callTool(canonicalName, toolUse.input);
      const content = result.ok ? result.content ?? "" : result.error ?? "Tool error";
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content,
        is_error: !result.ok,
      });
    }
    return results;
  }
}
