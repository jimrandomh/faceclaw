import { AssistantSession, type AssistantBackendConfig, type AssistantSessionHistory } from "./session";
import { ASSISTANT_MODEL_VALUES, type AssistantModel } from "./models";

export type ReasoningLevel = "default" | "low" | "medium" | "high";
export type Conversation = {
  id: string;
  model: AssistantModel;
  reasoning: ReasoningLevel;
  session: AssistantSession | null;
  history?: AssistantSessionHistory;
};
type SavedConversation = Omit<Conversation, "session">;
type SavedConversations = { selectedId: string; conversations: SavedConversation[] };

/** Shared selection and history for every assistant entry point. No credentials are saved. */
export class AssistantConversations {
  private records: Conversation[] = [];
  private selectedId = "";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly resolve: (model: AssistantModel, reasoning: ReasoningLevel) => AssistantBackendConfig | null,
    private readonly defaultModel: () => AssistantModel,
    private readonly persist: (value: string) => void,
    saved = "",
  ) {
    try {
      const data: SavedConversations = JSON.parse(saved);
      if (Array.isArray(data.conversations)) {
        this.records = data.conversations.filter((record) =>
          typeof record.id === "string" && ASSISTANT_MODEL_VALUES.includes(record.model) &&
          ["default", "low", "medium", "high"].includes(record.reasoning) &&
          Array.isArray(record.history?.messages) && Array.isArray(record.history?.transcript),
        ).map((record) => ({ ...record, session: null }));
        this.selectedId = data.selectedId;
      }
    } catch { /* First launch or invalid saved state. */ }
    if (!this.records.length) this.records.push(this.makeConversation());
    if (!this.records.some((record) => record.id === this.selectedId)) this.selectedId = this.records[0]!.id;
  }

  current(): Conversation { return this.records.find((record) => record.id === this.selectedId)!; }
  list(): readonly Conversation[] { return this.records; }
  title(record = this.current()): string {
    const transcript = record.session?.transcript ?? record.history?.transcript ?? [];
    return transcript.find((entry) => entry.role === "user")?.text.replace(/\s+/g, " ").slice(0, 60) || "New session";
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(save = true): void {
    if (save) this.persist(JSON.stringify({ selectedId: this.selectedId, conversations: this.records.map(
      ({ session, ...record }) => ({ ...record, history: session?.history() ?? record.history ?? { messages: [], transcript: [] } }),
    ) }));
    for (const listener of this.listeners) listener();
  }
  private makeConversation(): Conversation {
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, model: this.defaultModel(), reasoning: "default", session: null };
  }
  create(): boolean {
    if (this.current().session?.isTurnActive()) return false;
    const record = this.makeConversation();
    this.records.push(record);
    this.selectedId = record.id;
    this.changed();
    return true;
  }
  select(id: string): boolean {
    if (this.current().session?.isTurnActive() || !this.records.some((record) => record.id === id)) return false;
    this.selectedId = id;
    this.changed();
    return true;
  }
  configure(model: AssistantModel, reasoning: ReasoningLevel): boolean {
    const record = this.current();
    if (record.session?.isTurnActive() || !this.resolve(model, reasoning)) return false;
    record.model = model;
    record.reasoning = reasoning;
    this.ensureSession();
    this.changed();
    return true;
  }
  available(model: AssistantModel, reasoning: ReasoningLevel): boolean { return this.resolve(model, reasoning) !== null; }
  ensureSession(): AssistantSession | null {
    const record = this.current();
    const config = this.resolve(record.model, record.reasoning);
    if (!config) return null;
    if (!record.session) {
      record.session = new AssistantSession(config, undefined, record.history);
      record.session.onChanged(() => this.changed(!record.session!.isTurnActive()));
    } else record.session.configure(config);
    return record.session;
  }
}
