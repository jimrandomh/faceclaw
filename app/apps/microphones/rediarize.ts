import { Utils } from "@nativescript/core";

import { toUint8Array } from "../../util/array-util";
import { micModelPath } from "./mic-models";
import { SPEAKER_KNOWN_THRESHOLD, encodeEmbedding, speakerRegistry } from "./speakers";

declare const com: any;
declare const android: any;

/**
 * Re-diarize a saved conversation: run offline speaker diarization (pyannote
 * segmentation + speaker embeddings + clustering) over the session's
 * recording, then reconcile the resulting speaker turns against the stored
 * transcript segments — matching each cluster back to an enrolled speaker by
 * voice-print, or minting a new speaker when no one matches.
 */

export type RediarizeResult = {
  turns: number;
  clusters: number;
  reassignedSegments: number;
  newSpeakers: number;
};

export type RediarizeCallbacks = {
  onProgress: (fraction: number) => void;
  onDone: (result: RediarizeResult) => void;
  onError: (message: string) => void;
};

type Turn = { startMs: number; endMs: number; cluster: number };

function store(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

export function rediarizeSession(
  sessionId: number,
  options: { numSpeakers?: number; threshold?: number },
  callbacks: RediarizeCallbacks,
): void {
  const audioPath = String(store().getSessionAudioPath(sessionId));
  if (!audioPath) {
    callbacks.onError("This conversation has no saved recording to re-analyze.");
    return;
  }
  const segmentationModel = micModelPath("diarization-segmentation");
  const embeddingModel = micModelPath("speaker-embedding");
  if (!segmentationModel || !embeddingModel) {
    callbacks.onError("Download the re-diarization and speaker voice models first (Microphones > Voice & speakers).");
    return;
  }
  const listener = new com.faceclaw.app.FaceclawDiarizer.Listener({
    onProgress: (progress: number) => callbacks.onProgress(Number(progress)),
    onDone: (turnsJson: string) => {
      try {
        const turns = JSON.parse(String(turnsJson)) as Turn[];
        callbacks.onDone(applyTurns(sessionId, turns));
      } catch (error) {
        callbacks.onError(`Applying diarization failed: ${String(error)}`);
      }
    },
    onError: (message: string) => callbacks.onError(String(message)),
  });
  const diarizer = new com.faceclaw.app.FaceclawDiarizer(
    segmentationModel,
    embeddingModel,
    audioPath,
    options.numSpeakers ?? -1,
    options.threshold ?? 0.5,
    listener,
  );
  diarizer.start();
}

type StoredSegment = {
  id: number;
  speakerId: number | null;
  startedAt: number;
  endedAt: number;
  audioOffsetMs: number | null;
};

function applyTurns(sessionId: number, turns: Turn[]): RediarizeResult {
  const segments = (JSON.parse(String(store().querySegments(sessionId))) as Array<Record<string, unknown>>).map(
    (row): StoredSegment => ({
      id: Number(row.id),
      speakerId: row.speakerId === null ? null : Number(row.speakerId),
      startedAt: Number(row.startedAt),
      endedAt: Number(row.endedAt),
      audioOffsetMs: row.audioOffsetMs === null ? null : Number(row.audioOffsetMs),
    }),
  );
  const embeddings = new Map<number, Float32Array>();
  for (const row of JSON.parse(String(store().querySegmentEmbeddings(sessionId))) as Array<
    Record<string, unknown>
  >) {
    const decoded = decodeBase64Floats(String(row.embeddingBase64 ?? ""));
    if (decoded) embeddings.set(Number(row.id), decoded);
  }

  // Assign each transcript segment to the diarization cluster it overlaps most.
  const segmentClusters = new Map<number, number>();
  for (const segment of segments) {
    if (segment.audioOffsetMs === null) continue;
    const startMs = segment.audioOffsetMs;
    const endMs = startMs + (segment.endedAt - segment.startedAt);
    let bestCluster = -1;
    let bestOverlap = 0;
    for (const turn of turns) {
      const overlap = Math.min(endMs, turn.endMs) - Math.max(startMs, turn.startMs);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCluster = turn.cluster;
      }
    }
    if (bestCluster >= 0) segmentClusters.set(segment.id, bestCluster);
  }

  // Centroid per cluster from the stored per-segment voice-prints.
  const clusterEmbeddings = new Map<number, Float32Array[]>();
  for (const [segmentId, cluster] of segmentClusters) {
    const embedding = embeddings.get(segmentId);
    if (!embedding) continue;
    const list = clusterEmbeddings.get(cluster) ?? [];
    list.push(embedding);
    clusterEmbeddings.set(cluster, list);
  }

  speakerRegistry.reload();
  const clusterSpeaker = new Map<number, number>();
  let newSpeakers = 0;
  for (const [cluster, prints] of clusterEmbeddings) {
    const centroid = meanEmbedding(prints);
    if (!centroid) continue;
    const best = speakerRegistry.bestMatch(centroid);
    if (best && best.similarity >= SPEAKER_KNOWN_THRESHOLD) {
      clusterSpeaker.set(cluster, best.profile.id);
    } else {
      const id = Number(store().createSpeaker(nextAutoName(), "#90A4AE", false, encodeEmbedding(centroid)));
      speakerRegistry.reload();
      clusterSpeaker.set(cluster, id);
      newSpeakers += 1;
    }
  }

  let reassigned = 0;
  for (const segment of segments) {
    const cluster = segmentClusters.get(segment.id);
    if (cluster === undefined) continue;
    const speakerId = clusterSpeaker.get(cluster);
    if (speakerId === undefined || speakerId === segment.speakerId) continue;
    store().reassignSegmentSpeaker(segment.id, speakerId);
    reassigned += 1;
  }
  speakerRegistry.reload();
  return {
    turns: turns.length,
    clusters: clusterEmbeddings.size,
    reassignedSegments: reassigned,
    newSpeakers,
  };
}

function nextAutoName(): string {
  const taken = new Set(speakerRegistry.all().map((profile) => profile.name));
  for (let index = 1; ; index++) {
    const candidate = `Speaker ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function meanEmbedding(prints: Float32Array[]): Float32Array | null {
  if (prints.length === 0) return null;
  const mean = new Float32Array(prints[0]!.length);
  for (const print of prints) {
    if (print.length !== mean.length) continue;
    for (let i = 0; i < mean.length; i++) mean[i] += print[i]!;
  }
  let norm = 0;
  for (let i = 0; i < mean.length; i++) norm += mean[i]! * mean[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < mean.length; i++) mean[i] /= norm;
  }
  return mean;
}

function decodeBase64Floats(base64: string): Float32Array | null {
  if (!base64) return null;
  try {
    const bytes = toUint8Array(android.util.Base64.decode(base64, android.util.Base64.NO_WRAP));
    if (bytes.length < 4 || bytes.length % 4 !== 0) return null;
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  } catch {
    return null;
  }
}
