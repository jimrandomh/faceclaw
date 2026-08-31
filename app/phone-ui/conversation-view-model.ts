import { Frame, ImageSource, Observable, Screen, Utils, action, confirm, fromObject } from "@nativescript/core";

import { rediarizeSession } from "../apps/microphones/rediarize";
import { summarize, type AnalyzedLine, type EmotionLabel } from "../apps/microphones/sentiment";
import { speakerRegistry } from "../apps/microphones/speakers";
import {
  conversationStore,
  emotionColor,
  formatDateTime,
  formatDuration,
  formatTime,
  type SegmentRow,
  type SessionRow,
} from "./conversation-format";

declare const android: any;

/**
 * One transcript line. Rows are Observables so playback highlighting can
 * update just the affected rows instead of rebuilding the whole Repeater.
 */
export type TranscriptRow = Observable;

const UNKNOWN_SPEAKER_COLOR = "#90A4AE";
const GRAPH_HEIGHT_DIP = 120;

export class ConversationViewModel extends Observable {
  private readonly sessionId: number;
  private session: SessionRow | null = null;
  private segments: SegmentRow[] = [];
  private rows: TranscriptRow[] = [];

  private player: any = null; // android.media.MediaPlayer
  private activeRowIndex = -1;
  private playing = false;
  private rediarizeRunning = false;

  private _pageTitle = "Conversation";
  private _headerDate = "";
  private _headerMeta = "";
  private _status = "";
  private _emptyMessage = "";
  private _graphSource: ImageSource | null = null;

  constructor(sessionId: number) {
    super();
    this.sessionId = sessionId;
  }

  // --- bound properties ------------------------------------------------------

  get pageTitle(): string {
    return this._pageTitle;
  }

  get headerDate(): string {
    return this._headerDate;
  }

  get headerMeta(): string {
    return this._headerMeta;
  }

  get status(): string {
    return this._status;
  }

  set status(value: string) {
    if (this._status !== value) {
      this._status = value;
      this.notifyPropertyChange("status", value);
      this.notifyPropertyChange("statusVisibility", this.statusVisibility);
    }
  }

  get statusVisibility(): "visible" | "collapse" {
    return this._status ? "visible" : "collapse";
  }

  get emptyMessage(): string {
    return this._emptyMessage;
  }

  get emptyVisibility(): "visible" | "collapse" {
    return this._emptyMessage ? "visible" : "collapse";
  }

  get graphSource(): ImageSource | null {
    return this._graphSource;
  }

  get graphVisibility(): "visible" | "collapse" {
    return this._graphSource ? "visible" : "collapse";
  }

  get transcriptRows(): TranscriptRow[] {
    return this.rows;
  }

  // --- lifecycle -------------------------------------------------------------

  reload(): void {
    if (!global.isAndroid) {
      this._emptyMessage = "Conversation review is only available on Android.";
      this.notifyPropertyChange("emptyMessage", this._emptyMessage);
      this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
      return;
    }
    this.stopPlaybackHighlight();
    try {
      const sessions = JSON.parse(String(conversationStore().querySessions("{}"))) as SessionRow[];
      this.session = sessions.find((row) => row.id === this.sessionId) ?? null;
      this.segments = JSON.parse(String(conversationStore().querySegments(this.sessionId))) as SegmentRow[];
    } catch (error) {
      console.error(`conversation load failed: ${String(error)}`);
      this.session = null;
      this.segments = [];
    }
    this.refreshHeader();
    this.rebuildRows();
    this.rebuildGraph();
  }

  /** Release the MediaPlayer when the page goes away. */
  dispose(): void {
    this.stopPlaybackHighlight();
    if (this.player) {
      try {
        this.player.release();
      } catch {
        // already released
      }
      this.player = null;
    }
  }

  // --- header / rows ---------------------------------------------------------

  private refreshHeader(): void {
    const session = this.session;
    this._pageTitle = session?.title || (session ? formatDateTime(session.startedAt) : "Conversation");
    this._headerDate = session ? formatDateTime(session.startedAt) : "";
    if (session) {
      const durationMs = session.endedAt > session.startedAt ? session.endedAt - session.startedAt : 0;
      const speakerNames = (session.speakers ?? []).map((speaker) => speaker.name).join(", ");
      const parts = [formatDuration(durationMs), `${session.segmentCount} lines`];
      if (speakerNames) parts.push(speakerNames);
      if (!session.audioPath) parts.push("no recording");
      this._headerMeta = parts.join(" · ");
    } else {
      this._headerMeta = "";
    }
    this._emptyMessage = !session
      ? "This conversation is no longer in the store."
      : this.segments.length === 0
        ? "No transcript lines were saved for this conversation."
        : "";
    this.notifyPropertyChange("pageTitle", this._pageTitle);
    this.notifyPropertyChange("headerDate", this._headerDate);
    this.notifyPropertyChange("headerMeta", this._headerMeta);
    this.notifyPropertyChange("emptyMessage", this._emptyMessage);
    this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
  }

  private rebuildRows(): void {
    const speakerById = new Map<number, { name: string; color: string }>();
    for (const speaker of this.session?.speakers ?? []) {
      speakerById.set(speaker.id, speaker);
    }
    // Session speakers only cover voices heard in this session; a reassignment
    // to a brand-new speaker still needs a name, so fall back to the registry.
    for (const profile of speakerRegistry.all()) {
      if (!speakerById.has(profile.id)) {
        speakerById.set(profile.id, { name: profile.name, color: profile.color });
      }
    }
    this.rows = this.segments.map((segment, index) => {
      const speaker = segment.speakerId !== null ? speakerById.get(segment.speakerId) : undefined;
      const emotion = (segment.emotion || "neutral") as string;
      const row = fromObject({
        speakerPrefix: `${speaker?.name ?? "Unknown"}: `,
        speakerColor: speaker?.color || UNKNOWN_SPEAKER_COLOR,
        text: segment.text ?? "",
        translation: segment.translation ?? "",
        translationVisibility: segment.translation ? "visible" : "collapse",
        emotionLabel: emotion,
        emotionColor: emotionColor(emotion),
        emotionVisibility: emotion !== "neutral" ? "visible" : "collapse",
        timeLabel: formatTime(segment.startedAt),
        playIndicator: "",
        rowClass: "transcript-row",
        onRowTap: () => this.onRowTapped(index),
        onRowLongPress: () => {
          void this.onRowLongPressed(index);
        },
      });
      return row;
    });
    this.notifyPropertyChange("transcriptRows", this.rows);
  }

  // --- sentiment graph -------------------------------------------------------

  /**
   * Renders the per-line sentiment trend into a Bitmap: a horizontal zero
   * line, a polyline of scores over the conversation, and a dot per trend
   * point colored by the dominant emotion of that stretch.
   */
  private rebuildGraph(): void {
    this._graphSource = null;
    if (global.isAndroid && this.segments.length > 1) {
      try {
        this._graphSource = this.drawGraph();
      } catch (error) {
        console.error(`sentiment graph failed: ${String(error)}`);
      }
    }
    this.notifyPropertyChange("graphSource", this._graphSource);
    this.notifyPropertyChange("graphVisibility", this.graphVisibility);
  }

  private drawGraph(): ImageSource | null {
    const lines: AnalyzedLine[] = this.segments.map((segment) => ({
      score: segment.sentiment ?? 0,
      emotion: (segment.emotion || "neutral") as EmotionLabel,
      emotionConfidence: 1,
    }));
    const trend = summarize(lines).trend;
    if (trend.length < 2) return null;

    const scale = Screen.mainScreen.scale;
    const width = Math.max(320, Math.round(Screen.mainScreen.widthDIPs * scale));
    const height = Math.round(GRAPH_HEIGHT_DIP * scale);
    const padding = Math.round(10 * scale);
    const bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888);
    const canvas = new android.graphics.Canvas(bitmap);
    canvas.drawColor(android.graphics.Color.parseColor("#26909090"));

    const xAt = (i: number): number => padding + (i / (trend.length - 1)) * (width - 2 * padding);
    const yAt = (score: number): number => {
      const clamped = Math.max(-1, Math.min(1, score));
      return height / 2 - clamped * (height / 2 - padding);
    };

    const paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

    // Zero line.
    paint.setStyle(android.graphics.Paint.Style.STROKE);
    paint.setStrokeWidth(1 * scale);
    paint.setColor(android.graphics.Color.parseColor("#80909090"));
    canvas.drawLine(padding, height / 2, width - padding, height / 2, paint);

    // Score polyline.
    const path = new android.graphics.Path();
    path.moveTo(xAt(0), yAt(trend[0].score));
    for (let i = 1; i < trend.length; i++) {
      path.lineTo(xAt(i), yAt(trend[i].score));
    }
    paint.setStrokeWidth(2 * scale);
    paint.setColor(android.graphics.Color.parseColor("#78909C"));
    canvas.drawPath(path, paint);

    // Emotion dots.
    paint.setStyle(android.graphics.Paint.Style.FILL);
    for (let i = 0; i < trend.length; i++) {
      paint.setColor(android.graphics.Color.parseColor(emotionColor(trend[i].emotion)));
      canvas.drawCircle(xAt(i), yAt(trend[i].score), 3.5 * scale, paint);
    }

    return new ImageSource(bitmap);
  }

  // --- playback --------------------------------------------------------------

  private onRowTapped(index: number): void {
    if (!global.isAndroid) return;
    const session = this.session;
    const segment = this.segments[index];
    if (!session?.audioPath || !segment) return;
    // Lines predating the recording (or a mid-session codec restart) may miss
    // an offset; fall back to the wall-clock delta from the session start.
    const offsetMs =
      segment.audioOffsetMs !== null && segment.audioOffsetMs !== undefined
        ? segment.audioOffsetMs
        : Math.max(0, segment.startedAt - session.startedAt);

    if (index === this.activeRowIndex && this.player) {
      if (this.playing) {
        try {
          this.player.pause();
        } catch {
          // fall through to state update; a dead player just loses the toggle
        }
        this.playing = false;
      } else {
        try {
          this.player.start();
          this.playing = true;
        } catch {
          this.playing = false;
        }
      }
      this.updateRowPlayback();
      return;
    }

    if (!this.ensurePlayer(session.audioPath)) return;
    try {
      this.player.seekTo(offsetMs);
      this.player.start();
      this.playing = true;
      this.activeRowIndex = index;
    } catch (error) {
      this.status = `Playback failed: ${String(error)}`;
      this.playing = false;
      this.activeRowIndex = -1;
    }
    this.updateRowPlayback();
  }

  private ensurePlayer(audioPath: string): boolean {
    if (this.player) return true;
    try {
      const player = new android.media.MediaPlayer();
      player.setDataSource(audioPath);
      player.prepare();
      player.setOnCompletionListener(
        new android.media.MediaPlayer.OnCompletionListener({
          onCompletion: () => {
            Utils.executeOnMainThread(() => {
              this.playing = false;
              this.updateRowPlayback();
            });
          },
        }),
      );
      this.player = player;
      return true;
    } catch (error) {
      this.status = `Could not open the recording: ${String(error)}`;
      return false;
    }
  }

  private stopPlaybackHighlight(): void {
    if (this.player && this.playing) {
      try {
        this.player.pause();
      } catch {
        // ignore; the player may already be gone
      }
    }
    this.playing = false;
    this.activeRowIndex = -1;
  }

  private updateRowPlayback(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const isActive = i === this.activeRowIndex;
      const rowClass = isActive ? "transcript-row transcript-row-playing" : "transcript-row";
      const indicator = isActive ? (this.playing ? "⏸" : "▶") : "";
      if (row.get("rowClass") !== rowClass) row.set("rowClass", rowClass);
      if (row.get("playIndicator") !== indicator) row.set("playIndicator", indicator);
    }
  }

  // --- actions ---------------------------------------------------------------

  onRediarizeTap(): void {
    if (!global.isAndroid || this.rediarizeRunning) return;
    this.rediarizeRunning = true;
    this.status = "Re-diarizing… 0%";
    rediarizeSession(this.sessionId, {}, {
      onProgress: (fraction) => {
        Utils.executeOnMainThread(() => {
          this.status = `Re-diarizing… ${Math.round(fraction * 100)}%`;
        });
      },
      onDone: (result) => {
        Utils.executeOnMainThread(() => {
          this.rediarizeRunning = false;
          this.status =
            `Re-diarization done: ${result.clusters} voices, ` +
            `${result.reassignedSegments} lines reassigned, ${result.newSpeakers} new speakers.`;
          this.reload();
        });
      },
      onError: (message) => {
        Utils.executeOnMainThread(() => {
          this.rediarizeRunning = false;
          this.status = message;
        });
      },
    });
  }

  async onSplitSpeakerTap(): Promise<void> {
    if (!global.isAndroid) return;
    const speakers = this.session?.speakers ?? [];
    if (speakers.length === 0) {
      this.status = "This conversation has no speakers to split.";
      return;
    }
    const picked = await action({
      title: "Split speaker",
      message: "Move one speaker's lines in this conversation to a new profile.",
      cancelButtonText: "Cancel",
      actions: speakers.map((speaker) => speaker.name),
    });
    const chosen = speakers.find((speaker) => speaker.name === picked);
    if (!chosen) return;
    const confirmed = await confirm({
      title: "Split speaker",
      message: `Move ${chosen.name}'s lines in this conversation to a new speaker?`,
      okButtonText: "Split",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) return;
    speakerRegistry.splitFromSession(this.sessionId, chosen.id);
    this.status = "";
    this.reload();
  }

  async onDeleteTap(): Promise<void> {
    if (!global.isAndroid) return;
    const confirmed = await confirm({
      title: "Delete conversation",
      message: "Delete this conversation, its transcript, and its recording link? This cannot be undone.",
      okButtonText: "Delete",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) return;
    this.dispose();
    try {
      conversationStore().deleteSession(this.sessionId);
    } catch (error) {
      this.status = `Delete failed: ${String(error)}`;
      return;
    }
    Frame.topmost()?.goBack();
  }

  private async onRowLongPressed(index: number): Promise<void> {
    if (!global.isAndroid) return;
    const segment = this.segments[index];
    if (!segment) return;
    const profiles = speakerRegistry.all();
    if (profiles.length === 0) return;
    const picked = await action({
      title: "Reassign speaker",
      message: "Whose line is this?",
      cancelButtonText: "Cancel",
      actions: profiles.map((profile) => profile.name),
    });
    const chosen = profiles.find((profile) => profile.name === picked);
    if (!chosen || chosen.id === segment.speakerId) return;
    try {
      conversationStore().reassignSegmentSpeaker(segment.id, chosen.id);
    } catch (error) {
      this.status = `Reassign failed: ${String(error)}`;
      return;
    }
    speakerRegistry.reload();
    this.reload();
  }
}
