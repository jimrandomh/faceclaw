import { Utils } from "@nativescript/core";

import type { EmotionLabel, SentimentBucket } from "../apps/microphones/sentiment";

declare const com: any;

/**
 * Shared plumbing for the conversation review pages: access to the Java
 * conversation store, the row shapes it returns, and the small formatting/
 * color helpers every page needs. Callers must guard store access with
 * `global.isAndroid`.
 */

export type SessionSpeakerRef = { id: number; name: string; color: string };

export type SessionRow = {
  id: number;
  startedAt: number;
  endedAt: number;
  title: string;
  audioPath: string;
  audioCodec: string;
  avgSentiment: number;
  segmentCount: number;
  speakers: SessionSpeakerRef[];
};

export type SegmentRow = {
  id: number;
  speakerId: number | null;
  startedAt: number;
  endedAt: number;
  audioOffsetMs: number | null;
  text: string;
  lang: string;
  translation: string;
  translationLang: string;
  sentiment: number;
  emotion: string;
  angle: number | null;
};

export function conversationStore(): any {
  const context = Utils.android.getApplicationContext();
  return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
}

export const NO_CONVERSATIONS_MESSAGE =
  "No conversations yet — enable Captions + Save captions in the Microphones app on the glasses.";

/** "Mar 4, 2026, 2:15 PM" in the phone's locale. */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Time-of-day only, e.g. "2:15 PM" — used for per-line timestamps. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** mm:ss (hours spill into minutes: 90 min -> "90:00"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export const SENTIMENT_BUCKET_COLORS: Record<SentimentBucket, string> = {
  veryPositive: "#2E7D32",
  positive: "#66BB6A",
  neutral: "#9E9E9E",
  negative: "#EF6C00",
  veryNegative: "#C62828",
};

export const EMOTION_COLORS: Record<EmotionLabel, string> = {
  happy: "#81C784",
  excited: "#AED581",
  calm: "#4DB6AC",
  relieved: "#66BB6A",
  confident: "#4FC3F7",
  surprised: "#BA68C8",
  confused: "#FFB74D",
  bored: "#90A4AE",
  anxious: "#FFA726",
  embarrassed: "#F06292",
  frustrated: "#FF8A65",
  sad: "#7986CB",
  angry: "#E57373",
  disgusted: "#A1887F",
  neutral: "#BDBDBD",
};

export function emotionColor(emotion: string): string {
  return EMOTION_COLORS[emotion as EmotionLabel] ?? EMOTION_COLORS.neutral;
}
