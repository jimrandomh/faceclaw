import { extensionPlatform, type ProviderRequest } from "./extension-platform";
import { encodeBase64, type CloudSttClient, type CloudSttOptions } from "../../native/cloud-stt";
import type { AssistantTurnCallbacks, AssistantTurnHandle } from "../../assistant/types";
import type { RefineDictationOptions, AnthropicStreamHandle } from "../../native/anthropic";

export function externalAssistantAvailable(): boolean { return !!extensionPlatform()?.feature("assistant"); }
/** A lost request after dispatch is uncertain. Only explicit pre-dispatch rejection may select fallback. */
export function sendExtensionAssistant(text: string, callbacks: AssistantTurnCallbacks, fallback: () => AssistantTurnHandle): AssistantTurnHandle {
  let cancelled = false, backup: AssistantTurnHandle | null = null, latest = "";
  const apply = (data: any) => {
    if (cancelled || !data || typeof data !== "object") return;
    if (typeof data.text === "string" && data.text.length <= 32000 && data.text !== latest) { callbacks.onTextDelta(data.text.startsWith(latest) ? data.text.slice(latest.length) : data.text, data.text); latest = data.text; }
    if (typeof data.activity === "string") callbacks.onToolActivity(data.activity.slice(0, 200));
  };
  const request = extensionPlatform()?.provider("assistant", { text }, apply);
  if (!request) return fallback();
  request.promise.then(data => {
    if (cancelled) return;
    if (data?.error) {
      if (data.dispatched === false) { backup = fallback(); return; }
      callbacks.onError("Assistant request failed; outcome may be unknown"); return;
    }
    apply(data); callbacks.onTurnDone({ stopReason: typeof data?.stopReason === "string" ? data.stopReason.slice(0, 100) : "end_turn" });
  }).catch(() => { if (!cancelled) callbacks.onError("Assistant unavailable; this request was not retried"); });
  return { cancel() { cancelled = true; request.cancel(); backup?.cancel(); } };
}

export function refineThroughExtension(options: RefineDictationOptions): AnthropicStreamHandle | null {
  const request = extensionPlatform()?.provider("refinement", { original: options.original, followup: options.followup });
  if (!request) return null;
  let cancelled = false;
  request.promise.then(data => {
    if (cancelled) return;
    if (typeof data?.text !== "string" || !data.text.trim() || data.text.length > 8000 || data.error) options.onError("Refinement unavailable; original draft retained");
    else options.onDone(data.text);
  }).catch(() => { if (!cancelled) options.onError("Refinement unavailable; original draft retained"); });
  return { cancel() { cancelled = true; request.cancel(); } };
}

export type OwnTranscription = { component: string; captureId: string };
export class ExtensionSttClient implements CloudSttClient {
  private request: ProviderRequest | null = null;
  private stopped = false;
  private finishing = false;
  private bytes = 0;
  private pending = new Uint8Array(0);
  constructor(private readonly options: CloudSttOptions, private readonly fallback: () => void, private readonly own?: OwnTranscription) {}
  start(): void {
    if (this.stopped) return;
    this.request = extensionPlatform()?.provider("transcription", { operation: "start", sampleRate: 16000, format: "pcm_s16le", maxBytes: 9600000, ...(this.own ? { ownCapture: true, captureId: this.own.captureId } : {}) }, data => {
      if (!this.stopped && typeof data?.text === "string" && data.text.length <= 8000) this.options.onTranscript({ text: data.text, isFinal: false });
    }, this.own?.component) ?? null;
    if (!this.request) { this.fail(); return; }
    this.request.promise.then(data => {
      if (this.stopped) return;
      if (!this.finishing || typeof data?.text !== "string" || data.text.length > 8000 || data.error) { this.fail(); return; }
      this.options.onTranscript({ text: data.text, isFinal: true }); this.stop();
    }).catch(() => { if (!this.stopped) this.fail(); });
    this.options.onReady?.();
  }
  acceptPcm(pcm: Uint8Array): void {
    if (this.stopped || this.finishing) return;
    this.bytes += pcm.length;
    if (this.bytes > 9600000) { this.fail(); return; }
    const combined = new Uint8Array(this.pending.length + pcm.length); combined.set(this.pending); combined.set(pcm, this.pending.length); this.pending.fill(0);
    let offset = 0;
    while (offset + 4096 <= combined.length) { if (!this.audio(combined.subarray(offset, offset + 4096))) { combined.fill(0); return; } offset += 4096; }
    this.pending = combined.slice(offset); combined.fill(0);
  }
  private audio(pcm: Uint8Array): boolean {
    if (!this.request?.event({ event: "audio", pcmBase64: encodeBase64(pcm) })) { this.fail(); return false; } return true;
  }
  finish(): void {
    if (this.stopped || this.finishing) return;
    this.finishing = true;
    if (this.pending.length && !this.audio(this.pending)) return;
    this.pending.fill(0); this.pending = new Uint8Array(0);
    if (!this.request?.event({ event: "finish" })) this.fail();
  }
  stop(): void { if (this.stopped) return; this.stopped = true; this.pending.fill(0); this.pending = new Uint8Array(0); this.request?.cancel(); this.request = null; }
  private fail(): void { if (this.stopped) return; this.stop(); this.options.onStatus("Extension transcription unavailable; using on-device backup."); this.fallback(); }
}
export function extensionTranscriptionAvailable(): boolean { return !!extensionPlatform()?.feature("transcription"); }

/** Folder state belongs to the selected launcher, including assistant operations. */
export function routeLauncherFolderTool(name: string, args: unknown, appIds: string[], maxFolderLength: number): Promise<import("../../assistant/tool-registry").ToolResult> | undefined {
  const platform = extensionPlatform(); if (!platform?.feature("ui.launcher")) return undefined;
  const error = (message: string) => Promise.resolve({ ok: false, error: message });
  if (!["apps.list_folders", "apps.move_to_folder", "apps.remove_from_folder", "apps.disband_folder"].includes(name) || !args || typeof args !== "object" || Array.isArray(args)) return error("Invalid launcher folder operation");
  const data = args as Record<string, unknown>, arguments_: Record<string, string> = {};
  if (name === "apps.move_to_folder" || name === "apps.remove_from_folder") {
    if (typeof data.app_id !== "string" || !appIds.includes(data.app_id.trim())) return error("Unknown app");
    arguments_.app_id = data.app_id.trim();
  }
  if (name === "apps.move_to_folder" || name === "apps.disband_folder") {
    if (typeof data.folder !== "string" || !data.folder.trim() || data.folder.trim().length > maxFolderLength) return error("Invalid folder name");
    arguments_.folder = data.folder.trim();
  }
  const request = platform.provider("ui.launcher", { operation: "folder-tool", name, arguments: arguments_ });
  if (!request) return error("Launcher unavailable; folder operation was not dispatched");
  return request.promise.then(result => {
    if (!result || typeof result.ok !== "boolean" || (result.content !== undefined && (typeof result.content !== "string" || result.content.length > 20000)) || (result.error !== undefined && (typeof result.error !== "string" || result.error.length > 2000))) return { ok: false, error: "Invalid launcher result; outcome may be unknown" };
    return { ok: result.ok, ...(result.content === undefined ? {} : { content: result.content }), ...(result.error === undefined ? {} : { error: result.error }) };
  }, () => ({ ok: false, error: "Launcher folder operation outcome may be unknown; do not retry automatically" }));
}
