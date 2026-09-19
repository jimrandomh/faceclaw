import { Utils } from "@nativescript/core";

declare const com: any;
declare const java: any;

/**
 * Download management for the on-device transcription models (sherpa-onnx
 * offline recognizers). Models are fetched on demand into filesDir rather
 * than bundled in the APK; FaceclawVoiceController reads the files from the
 * directory each model's `dirName` names.
 *
 * Two models, same shape:
 *  - "moonshine": the original on-device option (three files). The model is
 *    no longer bundled in the APK; it is fetched into the same filesDir
 *    location that earlier releases copied the bundled files to, so
 *    upgraded installs that already used on-device transcription need no
 *    download.
 *  - "whisper-base-en": sherpa-onnx's offline Whisper backend, base.en,
 *    int8-quantized. Picked over tiny.en for materially better accuracy
 *    (Whisper's own tiny/base WER gap is real and well documented) on the
 *    reasoning that FaceclawVoiceController.java no longer re-decodes a
 *    Whisper segment on every live-partial tick — see its ASR_WHISPER_*
 *    comment — so base.en's extra compute is a one-time cost per utterance,
 *    not a cost paid ~1.4x/second while the user is speaking. tiny.en is an
 *    easy swap (this file's numbers only) if base.en proves too slow on a
 *    real phone; nobody has measured that yet. Files are csukuangfj's own
 *    (the sherpa-onnx maintainer's) HF mirror of the upstream sherpa-onnx
 *    release asset, matching the mirror-not-the-GH-tarball approach already
 *    used for Moonshine below. Every hash here was computed locally from a
 *    freshly downloaded copy of the file, not copied from a doc page.
 *
 * Mirrors the on-phone assistant model flow in llama.ts, except each model
 * here is multiple files rather than one; they download sequentially through
 * FaceclawModelDownloader (resume + pinned sha256 per file).
 */

export type AsrModelId = "moonshine" | "whisper-base-en";

type AsrModelFile = {
  name: string;
  sha256: string;
  sizeBytes: number;
};

type AsrModelDef = {
  label: string;
  dirName: string;
  baseUrl: string;
  files: AsrModelFile[];
  totalBytes: number;
};

export const ASR_MODELS: Record<AsrModelId, AsrModelDef> = {
  moonshine: {
    label: "Moonshine (English)",
    dirName: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
    // Hugging Face mirror of the sherpa-onnx release asset of the same name.
    // The GitHub release only offers a tar.bz2, which the phone can't unpack;
    // this mirror serves the same files (sha256-verified) individually.
    baseUrl:
      "https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/resolve/main/",
    files: [
      {
        name: "decoder_model_merged.ort",
        sha256: "d9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d",
        sizeBytes: 109424400,
      },
      {
        name: "encoder_model.ort",
        sha256: "7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf",
        sizeBytes: 31326816,
      },
      {
        name: "tokens.txt",
        sha256: "2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049",
        sizeBytes: 549350,
      },
    ],
    totalBytes: 141300566,
  },
  "whisper-base-en": {
    label: "Whisper (English, base)",
    dirName: "sherpa-onnx-whisper-base-en-int8",
    // csukuangfj/sherpa-onnx-whisper-base.en on Hugging Face: the sherpa-onnx
    // maintainer's own mirror of the project's whisper export, individual
    // files (no tar.bz2-unpack problem to begin with, but kept as the same
    // per-file-with-pinned-hash shape as Moonshine above for consistency).
    baseUrl: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base.en/resolve/main/",
    files: [
      {
        name: "base.en-encoder.int8.onnx",
        sha256: "ef6b936f4c9b1d90a3b68634b60c4ed8576b26172b33c2535ec0e933c9edb823",
        sizeBytes: 29120534,
      },
      {
        name: "base.en-decoder.int8.onnx",
        sha256: "f7162ad6db2dbef16cfaeaa7f945b9d7dd9c1b8d472f6aca82f2273d185e4d41",
        sizeBytes: 130669978,
      },
      {
        name: "base.en-tokens.txt",
        sha256: "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
        sizeBytes: 835554,
      },
    ],
    totalBytes: 160626066,
  },
};

export type AsrModelState = {
  status: "absent" | "downloading" | "ready";
  bytesDownloaded: number;
  totalBytes: number;
};

type ModelRuntime = {
  downloader: any;
  // Bytes of files already fully downloaded in this run, plus progress within
  // the file currently downloading; drives the aggregate percentage.
  completedBytes: number;
  currentFileBytes: number;
  stateListeners: Set<(state: AsrModelState) => void>;
};

function freshRuntime(): ModelRuntime {
  return { downloader: null, completedBytes: 0, currentFileBytes: 0, stateListeners: new Set() };
}

const runtimes: Record<AsrModelId, ModelRuntime> = {
  moonshine: freshRuntime(),
  "whisper-base-en": freshRuntime(),
};

function modelDirPath(id: AsrModelId): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/${ASR_MODELS[id].dirName}`;
}

function filePath(id: AsrModelId, file: AsrModelFile): string {
  return `${modelDirPath(id)}/${file.name}`;
}

function isFilePresent(id: AsrModelId, file: AsrModelFile): boolean {
  try {
    const javaFile = new java.io.File(filePath(id, file));
    return javaFile.exists() && javaFile.length() > 0;
  } catch {
    return false;
  }
}

export function isAsrModelReady(id: AsrModelId): boolean {
  if (!global.isAndroid) return false;
  return ASR_MODELS[id].files.every((file) => isFilePresent(id, file));
}

export function asrModelState(id: AsrModelId): AsrModelState {
  const runtime = runtimes[id];
  const totalBytes = ASR_MODELS[id].totalBytes;
  if (runtime.downloader) {
    return {
      status: "downloading",
      bytesDownloaded: runtime.completedBytes + runtime.currentFileBytes,
      totalBytes,
    };
  }
  return {
    status: isAsrModelReady(id) ? "ready" : "absent",
    bytesDownloaded: 0,
    totalBytes,
  };
}

export function onAsrModelStateChanged(id: AsrModelId, listener: (state: AsrModelState) => void): () => void {
  const runtime = runtimes[id];
  runtime.stateListeners.add(listener);
  return () => runtime.stateListeners.delete(listener);
}

function notifyStateChanged(id: AsrModelId): void {
  const state = asrModelState(id);
  runtimes[id].stateListeners.forEach((listener) => listener(state));
}

export function startAsrModelDownload(id: AsrModelId): void {
  const runtime = runtimes[id];
  if (!global.isAndroid || runtime.downloader || isAsrModelReady(id)) return;
  runtime.completedBytes = ASR_MODELS[id].files
    .filter((file) => isFilePresent(id, file))
    .reduce((sum, f) => sum + f.sizeBytes, 0);
  downloadNextFile(id);
  notifyStateChanged(id);
}

function downloadNextFile(id: AsrModelId): void {
  const runtime = runtimes[id];
  const def = ASR_MODELS[id];
  const nextFile = def.files.find((file) => !isFilePresent(id, file));
  if (!nextFile) {
    runtime.downloader = null;
    notifyStateChanged(id);
    return;
  }
  runtime.currentFileBytes = 0;
  const listener = new com.faceclaw.app.FaceclawModelDownloaderListener({
    onProgress: (bytes: number, _total: number) => {
      runtime.currentFileBytes = Number(bytes);
      notifyStateChanged(id);
    },
    onDone: () => {
      runtime.completedBytes += nextFile.sizeBytes;
      runtime.currentFileBytes = 0;
      downloadNextFile(id);
    },
    onError: (message: string) => {
      console.error(`Voice model download failed (${id}/${nextFile.name}): ${message}`);
      runtime.downloader = null;
      notifyStateChanged(id);
    },
  });
  runtime.downloader = new com.faceclaw.app.FaceclawModelDownloader(
    `${def.baseUrl}${nextFile.name}`,
    filePath(id, nextFile),
    nextFile.sha256,
    nextFile.sizeBytes,
    listener,
  );
  runtime.downloader.start();
}

/** Stops the download; already-fetched bytes are kept and resumed next time. */
export function cancelAsrModelDownload(id: AsrModelId): void {
  const runtime = runtimes[id];
  if (!runtime.downloader) return;
  runtime.downloader.cancel();
  runtime.downloader = null;
  notifyStateChanged(id);
}

export function deleteAsrModel(id: AsrModelId): void {
  if (!global.isAndroid) return;
  cancelAsrModelDownload(id);
  try {
    for (const file of ASR_MODELS[id].files) {
      new java.io.File(filePath(id, file)).delete();
      new java.io.File(`${filePath(id, file)}.part`).delete();
    }
    new java.io.File(modelDirPath(id)).delete();
  } catch (error) {
    console.error(`Voice model delete failed (${id}): ${String(error)}`);
  }
  notifyStateChanged(id);
}
