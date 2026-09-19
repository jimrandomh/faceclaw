import type { LlmContentBlock, LlmMessage, LlmToolDefinition } from "./llm-protocol";

/**
 * Render our provider-neutral message history into a Qwen3 (ChatML) prompt
 * string, matching the model's chat template closely enough that its
 * tool-calling priors apply: Hermes-style <tools> declarations in the system
 * block, <tool_call> JSON blocks in assistant turns, and tool results wrapped
 * in <tool_response> inside a user turn. The caller appends nothing — the
 * returned string ends with the assistant generation header.
 */

const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>";

export function buildQwenPrompt(
  system: string | undefined,
  messages: LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
): string {
  const parts: string[] = [];
  parts.push(`${IM_START}system\n${systemBlock(system, tools)}${IM_END}\n`);
  for (const message of messages) {
    if (message.role === "assistant") {
      parts.push(`${IM_START}assistant\n${assistantBlock(message.content)}${IM_END}\n`);
    } else {
      parts.push(`${IM_START}user\n${userBlock(message.content)}${IM_END}\n`);
    }
  }
  parts.push(`${IM_START}assistant\n`);
  return parts.join("");
}

function systemBlock(system: string | undefined, tools: LlmToolDefinition[] | undefined): string {
  const base = system?.trim() ?? "You are a helpful assistant.";
  if (!tools?.length) return base;
  const declarations = tools
    .map((tool) =>
      JSON.stringify({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      }),
    )
    .join("\n");
  return (
    `${base}\n\n# Tools\n\n` +
    `You may call one or more functions to assist with the user query.\n\n` +
    `You are provided with function signatures within <tools></tools> XML tags:\n` +
    `<tools>\n${declarations}\n</tools>\n\n` +
    `For each function call, return a json object with function name and arguments ` +
    `within <tool_call></tool_call> XML tags:\n` +
    `<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>`
  );
}

function assistantBlock(content: string | LlmContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim()) parts.push(block.text.trim());
    } else if (block.type === "tool_use") {
      parts.push(`<tool_call>\n${JSON.stringify({ name: block.name, arguments: block.input ?? {} })}\n</tool_call>`);
    }
    // provider_item blocks are OpenAI-specific continuation state; skip.
  }
  return parts.join("\n");
}

function userBlock(content: string | LlmContentBlock[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim()) parts.push(block.text.trim());
    } else if (block.type === "tool_result") {
      const body = block.is_error ? `Error: ${block.content}` : block.content || "(no output)";
      parts.push(`<tool_response>\n${body}\n</tool_response>`);
    }
  }
  return parts.join("\n");
}
