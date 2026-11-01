/**
 * Provider-neutral shapes used by the direct assistant loop. Each native LLM
 * client translates these messages and tools to its provider's wire format.
 */

export type LlmContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: any;
      /** Exact provider output item to replay during stateless continuation. */
      provider_item?: { provider: "openai"; item: any };
    }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  /** Opaque state required to continue a provider's stateless conversation. */
  | { type: "provider_item"; provider: "openai" | "openai-compatible"; item: any };

export type LlmMessage = {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  input_schema: object;
};

export type LlmStreamResult = {
  /** Concatenated text of all text blocks. */
  text: string;
  /** The assembled assistant content blocks (text + any tool calls). */
  content: LlmContentBlock[];
  /** Provider-normalized stop reason: end_turn, tool_use, refusal, etc. */
  stopReason: string | null;
};

export type LlmStreamOptions = {
  apiKey: string;
  model: string;
  system?: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens?: number;
  /** Thinking/latency tradeoff; voice flows want "low". */
  effort?: "low" | "medium" | "high";
  onTextDelta?: (delta: string, textSoFar: string) => void;
  onDone: (result: LlmStreamResult) => void;
  onError: (message: string) => void;
};

export type LlmStreamHandle = {
  cancel(): void;
};
