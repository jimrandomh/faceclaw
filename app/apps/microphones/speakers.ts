import { Utils } from "@nativescript/core";

import { encodeBase64 } from "../../native/cloud-stt";
import { toUint8Array } from "../../util/array-util";
import { micModelPath } from "./mic-models";
import { wearerCommandsOnlySetting } from "./mic-settings";

declare const com: any;
declare const android: any;

/**
 * Speaker voice-print registry over FaceclawConversationStore. Matching is
 * cosine similarity on L2-normalized embeddings: >= 0.80 auto-assign ("known"), 0.50-0.80 "uncertain" (assigned
 * but flagged for review), below that a new speaker is enrolled. Centroids
 * update as a capped running mean so one long session cannot drown an
 * enrolled voice.
 */

export const SPEAKER_KNOWN_THRESHOLD = 0.8;
export const SPEAKER_UNCERTAIN_THRESHOLD = 0.5;
/** Cap on the running-mean weight of an existing centroid. */
export const CENTROID_UPDATE_CAP = 24;

const SPEAKER_COLORS = [
  "#4FC3F7",
  "#FFB74D",
  "#81C784",
  "#E57373",
  "#BA68C8",
  "#FFD54F",
  "#4DB6AC",
  "#F06292",
  "#A1887F",
  "#90A4AE",
];

export type SpeakerProfile = {
  id: number;
  name: string;
  color: string;
  isWearer: boolean;
  embedding: Float32Array | null;
  embeddingCount: number;
  lastHeardAt: number;
  tag: string;
  segmentCount: number;
  /** LLM recap of this speaker's most recent conversation ("" until one is generated). */
  lastRecap: string;
  /** Open action items from that conversation. */
  actionItems: string[];
  /** Accumulated inferred facts about this person. */
  facts: string[];
  insightsUpdatedAt: number;
  insightsSessionId: number;
};

export type SpeakerMatch = {
  profile: SpeakerProfile;
  similarity: number;
  classification: "known" | "uncertain" | "new";
  /**
   * The profile's last_heard_at BEFORE this utterance updated it — i.e. when
   * this person's voice was previously heard. 0 for a newly enrolled speaker.
   */
  previousLastHeardAt: number;
};

function store(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

/** Parse a stored JSON string array leniently; anything malformed reads as empty. */
function parseStringArray(json: unknown): string[] {
  try {
    const parsed = JSON.parse(String(json || "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function decodeEmbedding(base64: string): Float32Array | null {
  if (!base64) return null;
  try {
    const bytes = toUint8Array(android.util.Base64.decode(base64, android.util.Base64.NO_WRAP));
    if (bytes.length < 4 || bytes.length % 4 !== 0) return null;
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  } catch {
    return null;
  }
}

export function encodeEmbedding(embedding: Float32Array): string {
  return encodeBase64(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  // Embeddings are L2-normalized at the source, so the dot product is the
  // cosine; renormalizing here would only amplify float noise.
  return dot;
}

export class SpeakerRegistry {
  private profiles: SpeakerProfile[] = [];
  private loaded = false;
  private readonly changeListeners = new Set<() => void>();

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChanged(): void {
    this.changeListeners.forEach((listener) => listener());
  }

  reload(): void {
    try {
      const rows = JSON.parse(String(store().querySpeakers())) as Array<Record<string, unknown>>;
      this.profiles = rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name ?? ""),
        color: String(row.color ?? SPEAKER_COLORS[0]),
        isWearer: Boolean(row.isWearer),
        embedding: decodeEmbedding(String(row.embeddingBase64 ?? "")),
        embeddingCount: Number(row.embeddingCount ?? 0),
        lastHeardAt: Number(row.lastHeardAt ?? 0),
        tag: String(row.tag ?? ""),
        segmentCount: Number(row.segmentCount ?? 0),
        lastRecap: String(row.lastRecap ?? ""),
        actionItems: parseStringArray(row.actionItemsJson),
        facts: parseStringArray(row.factsJson),
        insightsUpdatedAt: Number(row.insightsUpdatedAt ?? 0),
        insightsSessionId: Number(row.insightsSessionId ?? 0),
      }));
      this.loaded = true;
    } catch (error) {
      console.error(`speaker reload failed: ${String(error)}`);
      this.profiles = [];
    }
  }

  all(): SpeakerProfile[] {
    if (!this.loaded) this.reload();
    return this.profiles;
  }

  byId(id: number): SpeakerProfile | null {
    return this.all().find((profile) => profile.id === id) ?? null;
  }

  wearer(): SpeakerProfile | null {
    return this.all().find((profile) => profile.isWearer) ?? null;
  }

  /** Best cosine match against every enrolled profile, or null when none have prints. */
  bestMatch(embedding: Float32Array): { profile: SpeakerProfile; similarity: number } | null {
    let best: { profile: SpeakerProfile; similarity: number } | null = null;
    for (const profile of this.all()) {
      if (!profile.embedding || profile.embedding.length !== embedding.length) continue;
      const similarity = cosineSimilarity(embedding, profile.embedding);
      if (!best || similarity > best.similarity) {
        best = { profile, similarity };
      }
    }
    return best;
  }

  /**
   * Match an utterance's voice-print to a profile, enrolling a new
   * "Speaker N" when nothing crosses the uncertain threshold. Known and
   * uncertain matches also fold the print into the centroid.
   */
  assign(embedding: Float32Array): SpeakerMatch {
    const best = this.bestMatch(embedding);
    if (best && best.similarity >= SPEAKER_UNCERTAIN_THRESHOLD) {
      const previousLastHeardAt = best.profile.lastHeardAt;
      store().updateSpeakerEmbedding(best.profile.id, encodeEmbedding(embedding), CENTROID_UPDATE_CAP);
      this.reload();
      const profile = this.byId(best.profile.id) ?? best.profile;
      return {
        profile,
        similarity: best.similarity,
        classification: best.similarity >= SPEAKER_KNOWN_THRESHOLD ? "known" : "uncertain",
        previousLastHeardAt,
      };
    }
    const name = this.nextAutoName();
    const color = SPEAKER_COLORS[this.all().length % SPEAKER_COLORS.length]!;
    const id = Number(store().createSpeaker(name, color, false, encodeEmbedding(embedding)));
    this.reload();
    this.notifyChanged();
    const profile = this.byId(id)!;
    return { profile, similarity: best?.similarity ?? 0, classification: "new", previousLastHeardAt: 0 };
  }

  private nextAutoName(): string {
    const taken = new Set(this.all().map((profile) => profile.name));
    for (let index = 1; ; index++) {
      const candidate = `Speaker ${index}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Enroll (or refresh) the wearer's own voice from a training utterance. */
  enrollWearer(embedding: Float32Array): SpeakerProfile {
    const existing = this.wearer();
    if (existing) {
      store().updateSpeakerEmbedding(existing.id, encodeEmbedding(embedding), CENTROID_UPDATE_CAP);
      this.reload();
      this.notifyChanged();
      return this.byId(existing.id)!;
    }
    const id = Number(store().createSpeaker("Me", "#64B5F6", true, encodeEmbedding(embedding)));
    this.reload();
    this.notifyChanged();
    return this.byId(id)!;
  }

  /** Is this utterance the wearer's own voice? Used to gate command recognition. */
  isWearerVoice(embedding: Float32Array): boolean {
    const wearer = this.wearer();
    if (!wearer?.embedding || wearer.embedding.length !== embedding.length) return false;
    return cosineSimilarity(embedding, wearer.embedding) >= SPEAKER_KNOWN_THRESHOLD;
  }

  rename(id: number, name: string): void {
    store().renameSpeaker(id, name);
    this.reload();
    this.notifyChanged();
  }

  setColor(id: number, color: string): void {
    store().setSpeakerColor(id, color);
    this.reload();
    this.notifyChanged();
  }

  setTag(id: number, tag: string): void {
    store().setSpeakerTag(id, tag);
    this.reload();
    this.notifyChanged();
  }

  /** Store LLM-derived insights: recap + action items of `sessionId`, merged fact list. */
  setInsights(id: number, recap: string, actionItems: string[], facts: string[], sessionId: number): void {
    store().setSpeakerInsights(id, recap, JSON.stringify(actionItems), JSON.stringify(facts), sessionId);
    this.reload();
    this.notifyChanged();
  }

  setWearer(id: number, isWearer: boolean): void {
    store().setSpeakerWearer(id, isWearer);
    this.reload();
    this.notifyChanged();
  }

  merge(fromId: number, intoId: number): void {
    store().mergeSpeakers(fromId, intoId);
    this.reload();
    this.notifyChanged();
  }

  /**
   * Split support: give one session's segments of a speaker their own new
   * profile (e.g. when two people were fused into one). Returns the new id.
   */
  splitFromSession(sessionId: number, speakerId: number): number {
    const source = this.byId(speakerId);
    const name = this.nextAutoName();
    const color = SPEAKER_COLORS[this.all().length % SPEAKER_COLORS.length]!;
    const newId = Number(store().createSpeaker(name, color, false, ""));
    store().reassignSessionSpeaker(sessionId, speakerId, newId);
    if (source) {
      this.reload();
    }
    this.notifyChanged();
    return newId;
  }

  remove(id: number): void {
    store().deleteSpeaker(id);
    this.reload();
    this.notifyChanged();
  }
}

export const speakerRegistry = new SpeakerRegistry();

/**
 * The speaker-verification config for "my voice only" command gating, or
 * null when the setting is off, no wearer voice is enrolled, or the speaker
 * model isn't downloaded. Consumed by the voice-capture path so assistant /
 * dictation commands from other speakers are discarded.
 */
export function wearerVerificationOptions(): {
  speakerModelPath: string;
  wearerEmbedding: Float32Array;
  threshold: number;
} | null {
  if (!wearerCommandsOnlySetting.get()) return null;
  const wearer = speakerRegistry.wearer();
  if (!wearer?.embedding) return null;
  const speakerModelPath = micModelPath("speaker-embedding");
  if (!speakerModelPath) return null;
  return { speakerModelPath, wearerEmbedding: wearer.embedding, threshold: SPEAKER_KNOWN_THRESHOLD };
}
