import { Utils } from "@nativescript/core";
import { buildToolCallGrammar } from "../assistant/gbnf";
import type {
  LlmContentBlock,
  LlmStreamHandle,
  LlmStreamOptions,
} from "../assistant/llm-protocol";
import { buildQwenPrompt } from "../assistant/qwen-prompt";

declare const com: any;
declare const java: any;

/**
 * On-phone LLM backend: model download management plus a streaming client
 * with the same LlmStreamOptions surface as the Anthropic/OpenAI clients, so
 * the direct assistant loop can treat "local" as just another provider.
 * Inference is llama.cpp on the CPU (FaceclawLlamaRunner over JNI).
 */

export const LOCAL_MODEL = {
  id: "qwen3-4b-instruct-2507",
  label: "Qwen3 4B",
  fileName: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
  url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf?download=true",
  sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
  sizeBytes: 2497281120,
};

// Bounded so KV cache stays ~0.5GB (Qwen3-4B KV is ~144KB/token at f16);
// the assistant trims history well before this in practice.
const N_CTX = 4096;
const N_THREADS = 4;
const DEFAULT_MAX_TOKENS = 512;
// Qwen3-4B-Instruct-2507 model-card sampling posture.
const TEMPERATURE = 0.7;
const TOP_P = 0.8;
const TOP_K = 20;
/** Free the ~3GB of model + KV this long after the last generation. */
const IDLE_UNLOAD_MS = 2 * 60 * 1000;

export type LocalModelState = {
  status: "absent" | "downloading" | "ready";
  bytesDownloaded: number;
  totalBytes: number;
};

let runner: any = null;
let downloader: any = null;
let downloadedBytes = 0;
let unloadTimer: ReturnType<typeof setTimeout> | null = null;
let toolUseCounter = 0;
const stateListeners = new Set<(state: LocalModelState) => void>();

function modelPath(): string {
  const context = Utils.android.getApplicationContext();
  const dir = context.getExternalFilesDir("llm") ?? context.getFilesDir();
  return `${dir.getAbsolutePath()}/${LOCAL_MODEL.fileName}`;
}

export function isLocalModelReady(): boolean {
  if (!global.isAndroid) return false;
  try {
    const file = new java.io.File(modelPath());
    return file.exists() && file.length() > 0;
  } catch {
    return false;
  }
}

export function localModelState(): LocalModelState {
  if (downloader) {
    return { status: "downloading", bytesDownloaded: downloadedBytes, totalBytes: LOCAL_MODEL.sizeBytes };
  }
  return {
    status: isLocalModelReady() ? "ready" : "absent",
    bytesDownloaded: 0,
    totalBytes: LOCAL_MODEL.sizeBytes,
  };
}

export function onLocalModelStateChanged(listener: (state: LocalModelState) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function notifyStateChanged(): void {
  const state = localModelState();
  for (const listener of stateListeners) listener(state);
}

export function startLocalModelDownload(): void {
  if (!global.isAndroid || downloader || isLocalModelReady()) return;
  const listener = new com.faceclaw.app.FaceclawModelDownloaderListener({
    onProgress: (bytes: number, _total: number) => {
      downloadedBytes = Number(bytes);
      notifyStateChanged();
    },
    onDone: () => {
      downloader = null;
      notifyStateChanged();
    },
    onError: (message: string) => {
      console.error(`Local model download failed: ${message}`);
      downloader = null;
      notifyStateChanged();
    },
  });
  downloader = new com.faceclaw.app.FaceclawModelDownloader(
    LOCAL_MODEL.url,
    modelPath(),
    LOCAL_MODEL.sha256,
    LOCAL_MODEL.sizeBytes,
    listener,
  );
  downloadedBytes = 0;
  downloader.start();
  notifyStateChanged();
}

/** Stops the download; already-fetched bytes are kept and resumed next time. */
export function cancelLocalModelDownload(): void {
  if (!downloader) return;
  downloader.cancel();
  downloader = null;
  notifyStateChanged();
}

export function deleteLocalModel(): void {
  if (!global.isAndroid) return;
  cancelLocalModelDownload();
  unloadLocalModel();
  try {
    new java.io.File(modelPath()).delete();
    new java.io.File(`${modelPath()}.part`).delete();
  } catch (error) {
    console.error(`Local model delete failed: ${String(error)}`);
  }
  notifyStateChanged();
}

export function unloadLocalModel(): void {
  if (unloadTimer) {
    clearTimeout(unloadTimer);
    unloadTimer = null;
  }
  runner?.unload();
}

function scheduleIdleUnload(): void {
  if (unloadTimer) clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    unloadTimer = null;
    runner?.unload();
  }, IDLE_UNLOAD_MS);
}

function ensureRunner(): any {
  if (!runner) {
    runner = new com.faceclaw.app.FaceclawLlamaRunner();
  }
  return runner;
}

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

/**
 * Stream a completion from the on-phone model. Tool calls arrive inline as
 * <tool_call> JSON blocks; they are hidden from the text stream and surfaced
 * as tool_use content blocks in the final result, mirroring the cloud
 * providers' contract (stopReason "tool_use" when the model called a tool).
 */
export function streamLocalQwen(options: LlmStreamOptions): LlmStreamHandle {
  let settled = false;
  let raw = "";
  let emitted = "";

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    scheduleIdleUnload();
    options.onError(message);
  };

  if (!global.isAndroid) {
    setTimeout(() => fail("The on-phone model is only available on Android"), 0);
    return { cancel: () => {} };
  }
  if (!isLocalModelReady()) {
    setTimeout(() => fail("The on-phone model isn't downloaded yet (see Settings)"), 0);
    return { cancel: () => {} };
  }
  if (unloadTimer) {
    clearTimeout(unloadTimer);
    unloadTimer = null;
  }

  const prompt = buildQwenPrompt(options.system, options.messages, options.tools);
  const grammar = options.tools?.length ? buildToolCallGrammar(options.tools) : null;

  const listener = new com.faceclaw.app.FaceclawLlamaListener({
    onToken: (piece: string) => {
      if (settled) return;
      raw += String(piece);
      const visible = visibleText(raw);
      if (visible.length > emitted.length) {
        const delta = visible.slice(emitted.length);
        emitted = visible;
        options.onTextDelta?.(delta, emitted);
      }
    },
    onDone: (nativeStopReason: string) => {
      if (settled) return;
      settled = true;
      scheduleIdleUnload();
      const { text, content, toolCount } = assembleContent(raw);
      const stopReason =
        toolCount > 0 ? "tool_use" : String(nativeStopReason) === "length" ? "max_tokens" : "end_turn";
      options.onDone({ text, content, stopReason });
    },
    onError: (message: string) => fail(String(message)),
  });

  try {
    ensureRunner().generate(
      modelPath(),
      N_CTX,
      N_THREADS,
      prompt,
      grammar ?? "",
      options.maxTokens ?? DEFAULT_MAX_TOKENS,
      TEMPERATURE,
      TOP_P,
      TOP_K,
      listener,
    );
  } catch (error) {
    setTimeout(() => fail(`On-phone model failed: ${String((error as Error)?.message ?? error)}`), 0);
    return { cancel: () => {} };
  }

  return {
    cancel: () => {
      settled = true;
      scheduleIdleUnload();
      try {
        runner?.cancel();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * The streamable portion of the raw output: text outside completed
 * <tool_call> blocks, holding back any trailing partial marker so a tool
 * call never leaks into the visible stream. Monotonic under appends.
 */
function visibleText(raw: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = raw.indexOf(TOOL_CALL_OPEN, i);
    if (start === -1) {
      const tail = raw.slice(i);
      out += tail.slice(0, tail.length - partialSuffixLength(tail, TOOL_CALL_OPEN));
      return out;
    }
    out += raw.slice(i, start);
    const end = raw.indexOf(TOOL_CALL_CLOSE, start);
    if (end === -1) return out; // inside an unfinished tool call
    i = end + TOOL_CALL_CLOSE.length;
  }
}

/** Length of the longest proper prefix of marker that text ends with. */
function partialSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (text.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

/** Split the finished raw output into text + tool_use content blocks. */
function assembleContent(raw: string): { text: string; content: LlmContentBlock[]; toolCount: number } {
  const content: LlmContentBlock[] = [];
  let text = "";
  let toolCount = 0;
  let i = 0;
  for (;;) {
    const start = raw.indexOf(TOOL_CALL_OPEN, i);
    if (start === -1) {
      text += raw.slice(i);
      break;
    }
    text += raw.slice(i, start);
    const end = raw.indexOf(TOOL_CALL_CLOSE, start);
    if (end === -1) break; // truncated call (length stop); drop it
    const body = raw.slice(start + TOOL_CALL_OPEN.length, end).trim();
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.name === "string") {
        toolCount++;
        content.push({
          type: "tool_use",
          id: `local_${Date.now()}_${++toolUseCounter}`,
          name: parsed.name,
          input: parsed.arguments ?? {},
        });
      }
    } catch {
      console.error(`Local model emitted unparseable tool call: ${body.slice(0, 200)}`);
    }
    i = end + TOOL_CALL_CLOSE.length;
  }
  text = text.trim();
  if (text) content.unshift({ type: "text", text });
  return { text, content, toolCount };
}
