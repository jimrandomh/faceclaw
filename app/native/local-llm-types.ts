/** Shared shapes for the on-phone LLM (local-llm.ts on Android, local-llm.ios.ts on iOS). */

export type LocalModelState = {
  /**
   * Android downloads its model: absent → downloading → ready. iOS uses the
   * system's Apple Intelligence model: ready, or unavailable (see detail).
   */
  status: "absent" | "downloading" | "ready" | "unavailable";
  bytesDownloaded: number;
  totalBytes: number;
  /** Why the model can't be used, when status is "unavailable" (short, for a settings row). */
  detail?: string;
};
