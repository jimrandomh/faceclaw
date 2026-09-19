import { EventData, Frame, Observable, SearchBar } from "@nativescript/core";

import { sentimentBucket } from "../apps/microphones/sentiment";
import { speakerRegistry } from "../apps/microphones/speakers";
import {
  conversationStore,
  formatDateTime,
  formatDuration,
  NO_CONVERSATIONS_MESSAGE,
  SENTIMENT_BUCKET_COLORS,
  type SessionRow,
} from "./conversation-format";
import { parseConversationQuery } from "./conversation-search";

/** One session row in the Repeater; tap handler rides on the item itself (see pairing-view-model). */
export type SessionRowItem = {
  title: string;
  meta: string;
  sentimentColor: string;
  speakerChips: Array<{ name: string; chipBackground: string }>;
  chipsVisibility: "visible" | "collapse";
  onRowTap: () => void;
};

export type SpeakerChipItem = {
  name: string;
  chipBackground: string;
  chipClass: string;
  onChipTap: () => void;
};

export class ConversationsViewModel extends Observable {
  private _searchText = "";
  private _sessionRows: SessionRowItem[] = [];
  private _speakerChips: SpeakerChipItem[] = [];
  private _emptyMessage = "";
  private selectedSpeakerId: number | null = null;

  constructor(options?: { speakerId?: number }) {
    super();
    this.selectedSpeakerId = options?.speakerId ?? null;
  }

  get searchText(): string {
    return this._searchText;
  }

  set searchText(value: string) {
    if (this._searchText !== value) {
      this._searchText = value;
      this.notifyPropertyChange("searchText", value);
    }
  }

  get sessionRows(): SessionRowItem[] {
    return this._sessionRows;
  }

  get speakerChips(): SpeakerChipItem[] {
    return this._speakerChips;
  }

  get emptyMessage(): string {
    return this._emptyMessage;
  }

  get emptyVisibility(): "visible" | "collapse" {
    return this._emptyMessage ? "visible" : "collapse";
  }

  get filterChipsVisibility(): "visible" | "collapse" {
    return this._speakerChips.length > 0 ? "visible" : "collapse";
  }

  /** Called on every navigatingTo so edits made on other pages show up on the way back. */
  reload(): void {
    this.refreshSpeakerChips();
    this.refreshSessions();
  }

  onSpeakersTap(): void {
    Frame.topmost()?.navigate("phone-ui/speakers-page");
  }

  onAskTap(): void {
    Frame.topmost()?.navigate("phone-ui/ask-page");
  }

  onSearchSubmit(args: EventData): void {
    const bar = args.object as SearchBar;
    this._searchText = bar.text ?? "";
    this.refreshSessions();
  }

  onSearchClear(): void {
    if (!this._searchText) return;
    this._searchText = "";
    this.notifyPropertyChange("searchText", "");
    this.refreshSessions();
  }

  private refreshSpeakerChips(): void {
    const profiles = global.isAndroid ? speakerRegistry.all() : [];
    this._speakerChips = profiles.map((profile) => ({
      name: profile.name,
      chipBackground: profile.color || "#90A4AE",
      chipClass: profile.id === this.selectedSpeakerId ? "speaker-chip speaker-chip-selected" : "speaker-chip",
      onChipTap: () => {
        this.selectedSpeakerId = this.selectedSpeakerId === profile.id ? null : profile.id;
        this.refreshSpeakerChips();
        this.refreshSessions();
      },
    }));
    this.notifyPropertyChange("speakerChips", this._speakerChips);
    this.notifyPropertyChange("filterChipsVisibility", this.filterChipsVisibility);
  }

  private refreshSessions(): void {
    if (!global.isAndroid) {
      this.setSessions([], "Conversation review is only available on Android.");
      return;
    }
    const parsed = parseConversationQuery(this._searchText);
    const filter: Record<string, unknown> = {};
    if (parsed.sinceMs !== null) filter.sinceMs = parsed.sinceMs;
    if (parsed.untilMs !== null) filter.untilMs = parsed.untilMs;
    if (parsed.emotion !== null) filter.emotion = parsed.emotion;
    if (parsed.text) filter.query = parsed.text;
    if (this.selectedSpeakerId !== null) filter.speakerId = this.selectedSpeakerId;
    const filtered = Object.keys(filter).length > 0;

    let rows: SessionRow[] = [];
    try {
      rows = JSON.parse(String(conversationStore().querySessions(JSON.stringify(filter)))) as SessionRow[];
    } catch (error) {
      console.error(`conversations query failed: ${String(error)}`);
      this.setSessions([], "Could not read saved conversations.");
      return;
    }
    this.setSessions(
      rows.map((row) => this.toRowItem(row)),
      rows.length > 0 ? "" : filtered ? "No conversations match this search." : NO_CONVERSATIONS_MESSAGE,
    );
  }

  private setSessions(rows: SessionRowItem[], emptyMessage: string): void {
    this._sessionRows = rows;
    this._emptyMessage = emptyMessage;
    this.notifyPropertyChange("sessionRows", rows);
    this.notifyPropertyChange("emptyMessage", emptyMessage);
    this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
  }

  private toRowItem(row: SessionRow): SessionRowItem {
    const durationMs = row.endedAt > row.startedAt ? row.endedAt - row.startedAt : 0;
    const metaParts = [formatDateTime(row.startedAt), formatDuration(durationMs), `${row.segmentCount} lines`];
    const chips = (row.speakers ?? []).map((speaker) => ({
      name: speaker.name,
      chipBackground: speaker.color || "#90A4AE",
    }));
    return {
      title: row.title || formatDateTime(row.startedAt),
      meta: metaParts.filter((part) => part.length > 0).join(" · "),
      sentimentColor: SENTIMENT_BUCKET_COLORS[sentimentBucket(row.avgSentiment ?? 0)],
      speakerChips: chips,
      chipsVisibility: chips.length > 0 ? "visible" : "collapse",
      onRowTap: () => {
        Frame.topmost()?.navigate({
          moduleName: "phone-ui/conversation-page",
          context: { sessionId: row.id },
        });
      },
    };
  }
}
