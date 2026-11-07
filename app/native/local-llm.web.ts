/** No on-device model in the browser demo: Settings shows it as unavailable. */
import type { LlmStreamHandle, LlmStreamOptions } from "../assistant/llm-protocol";
import type { LocalModelState } from "./local-llm-types";
export type { LocalModelState } from "./local-llm-types";

const UNAVAILABLE = "Not available in the browser demo";

export const LOCAL_MODEL = { id: "none", label: "On-device model", fileName: "", url: "", sha256: "", sizeBytes: 0 };
export function isLocalModelSupported(): boolean { return false; }
export function isLocalModelReady(): boolean { return false; }
export function localModelState(): LocalModelState { return { status: "unavailable", bytesDownloaded: 0, totalBytes: 0, detail: UNAVAILABLE }; }
export function localModelUnavailableMessage(): string { return UNAVAILABLE; }
export function onLocalModelStateChanged(_listener: (state: LocalModelState) => void): () => void { return () => {}; }
export function startLocalModelDownload(): void {}
export function cancelLocalModelDownload(): void {}
export function deleteLocalModel(): void {}
export function unloadLocalModel(): void {}
export function streamLocalModel(options: LlmStreamOptions): LlmStreamHandle {
  setTimeout(() => options.onError(UNAVAILABLE), 0);
  return { cancel: () => {} };
}
