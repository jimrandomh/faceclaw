import { Observable } from "@nativescript/core";

import {
  askConversations,
  conversationQaAvailable,
} from "../apps/microphones/conversation-qa";
import type { LlmStreamHandle } from "../assistant/llm-protocol";

/**
 * "Ask about conversations": free-form questions over the saved transcripts,
 * speakers, tags, and metadata, answered entirely on-device by the local
 * assistant model. The answer streams in as it generates.
 */
export class AskViewModel extends Observable {
  private stream: LlmStreamHandle | null = null;
  private busy = false;

  constructor() {
    super();
    this.set("question", "");
    this.set("answer", "");
    this.set("contextNote", "");
    this.set("askLabel", "Ask");
    this.set("askEnabled", true);
    this.set("answerVisibility", "collapsed");
    this.set("noteVisibility", "collapsed");
    if (!conversationQaAvailable()) {
      this.set(
        "statusText",
        "The on-phone model isn't downloaded yet. Enable it on the glasses under Settings > Assistant, then come back — questions are answered entirely on-device.",
      );
      this.set("statusVisibility", "visible");
    } else {
      this.set("statusText", "");
      this.set("statusVisibility", "collapsed");
    }
  }

  onAskTap = (): void => {
    const question = String(this.get("question") ?? "").trim();
    if (!question || this.busy) return;
    this.cancel();
    this.busy = true;
    this.set("askLabel", "Thinking...");
    this.set("askEnabled", false);
    this.set("answer", "");
    this.set("answerVisibility", "collapsed");
    this.set("noteVisibility", "collapsed");
    this.set("statusText", "Reading your conversations...");
    this.set("statusVisibility", "visible");
    this.stream = askConversations(question, {
      onDelta: (textSoFar) => {
        this.set("answer", textSoFar);
        this.set("answerVisibility", "visible");
        this.set("statusVisibility", "collapsed");
      },
      onDone: (answer, contextNote) => {
        this.finish();
        this.set("answer", answer || "(no answer)");
        this.set("answerVisibility", "visible");
        this.set("contextNote", contextNote);
        this.set("noteVisibility", "visible");
      },
      onError: (message) => {
        this.finish();
        this.set("statusText", message);
        this.set("statusVisibility", "visible");
      },
    });
  };

  cancel(): void {
    this.stream?.cancel();
    this.stream = null;
    if (this.busy) this.finish();
  }

  private finish(): void {
    this.busy = false;
    this.stream = null;
    this.set("askLabel", "Ask");
    this.set("askEnabled", true);
  }
}
