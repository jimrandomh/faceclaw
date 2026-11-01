/**
 * The on-phone LLM: one entry point for every feature that can run on the
 * phone without an API key (the direct assistant's "local" provider,
 * Translate, Calculator's rewrite fallback, the Microphones helpers). Each
 * platform supplies a streaming client with the cloud clients' LlmStreamOptions
 * contract, plus model status for Settings.
 *
 *  - Android (this file): Qwen3-4B on llama.cpp, downloaded on demand (llama.ts).
 *  - iOS (local-llm.ios.ts): Apple's Foundation Models system model; nothing
 *    to download, available on Apple Intelligence devices running iOS 26+.
 */
export {
  LOCAL_MODEL,
  isLocalModelReady,
  localModelState,
  onLocalModelStateChanged,
  startLocalModelDownload,
  cancelLocalModelDownload,
  deleteLocalModel,
  unloadLocalModel,
  streamLocalQwen as streamLocalModel,
} from "./llama";
export type { LocalModelState } from "./local-llm-types";

/** Whether this phone can offer an on-phone model at all (Android: always, by download). */
export function isLocalModelSupported(): boolean {
  return true;
}
