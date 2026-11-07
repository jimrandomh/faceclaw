/** No on-device transcription model in the browser demo. */
export type AsrModelId = "moonshine" | "whisper-base-en";
export type AsrModelState = { status: "absent" | "downloading" | "ready"; bytesDownloaded: number; totalBytes: number };
export const ASR_MODELS: Record<AsrModelId, { label: string; dirName: string; files: never[]; totalBytes: number }> = {
  moonshine: { label: "Moonshine", dirName: "", files: [], totalBytes: 0 },
  "whisper-base-en": { label: "Whisper", dirName: "", files: [], totalBytes: 0 },
};
export function isAsrModelReady(_id: AsrModelId): boolean { return false; }
export function asrModelState(_id: AsrModelId): AsrModelState { return { status: "absent", bytesDownloaded: 0, totalBytes: 0 }; }
export function onAsrModelStateChanged(_id: AsrModelId, _listener: (state: AsrModelState) => void): () => void { return () => {}; }
export function startAsrModelDownload(_id: AsrModelId): void {}
export function cancelAsrModelDownload(_id: AsrModelId): void {}
export function deleteAsrModel(_id: AsrModelId): void {}
