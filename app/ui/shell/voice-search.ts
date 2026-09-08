import { type GrayImage } from "../../graphics/image";
import { voiceControlBridge } from "../../native/voice-control";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, gestureHints, type InputEvent } from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { paintInputDialog } from "./input-dialog";

/** Generic, explicit voice query. No message destination, draft, send or refinement path. */
export class VoiceSearchLayer implements Layer {
  private phase: "capturing" | "finalizing" | "review" = "capturing";
  private text = "";
  private partial = "";
  private status = "Say a name";
  private capturing = false;
  private receivedFinal = false;
  private removed = false;
  private delivered = false;
  private generation = 0;
  private selected = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: Array<() => void> = [];
  constructor(private readonly options: { actions: LayerActions; label: string; onSearch: (query: string) => void; dismiss: () => void; onClosed: () => void }) {}

  startCapture(): void {
    if (this.removed || this.capturing || this.phase !== "capturing") return;
    this.clearListeners();
    const epoch = this.generation;
    const current = () => !this.removed && epoch === this.generation;
    this.capturing = true; this.receivedFinal = false; this.text = ""; this.partial = "";
    this.status = "Say a name";
    this.unsubscribe.push(voiceControlBridge.onTranscript(event => {
      if (!current() || this.receivedFinal) return;
      if (event.isFinal) {
        this.receivedFinal = true;
        this.text = event.text.trim(); this.partial = "";
        if (this.phase === "finalizing") this.finish();
      } else this.partial = event.text.trim();
      this.options.actions.requestRender();
    }));
    let subscribing = true;
    this.unsubscribe.push(voiceControlBridge.onStatus(state => {
      if (subscribing || !current()) return;
      if (/^Ignored|^T3_STT_UNAVAILABLE|not downloaded|needs an active|Could not start|Voice control failed/i.test(state.status)) this.fail("Voice unavailable. Try again.");
    }));
    subscribing = false;
    try { void Promise.resolve(this.options.actions.startVoiceCapture(false)).catch(() => { if (current()) this.fail("Could not start voice search."); }); }
    catch { if (current()) this.fail("Could not start voice search."); }
    this.options.actions.requestRender();
  }
  private clearListeners(): void {
    this.generation++;
    this.unsubscribe.splice(0).forEach(off => off());
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private stop(reportFailure: boolean): void {
    const epoch = this.generation;
    const failed = () => { if (reportFailure && !this.removed && epoch === this.generation) this.fail("Could not finish voice search."); };
    try { void Promise.resolve(this.options.actions.stopVoiceCapture()).catch(failed); } catch { failed(); }
  }
  endCapture(): void {
    if (!this.capturing || this.removed) return;
    this.capturing = false; this.phase = "finalizing"; this.status = "Finishing search query…";
    this.timer = setTimeout(() => this.fail("No final transcript. Try again."), 95000);
    this.stop(true);
    if (this.receivedFinal && this.phase === "finalizing") this.finish();
    this.options.actions.requestRender();
  }
  private finish(): void {
    this.clearListeners(); this.partial = ""; this.phase = "review"; this.selected = 0;
    if (this.text.length > 256) { this.text = ""; this.status = "Name too long. Try again."; }
    else this.status = this.text ? "Search, try again, or cancel?" : "No name heard. Try again.";
    this.selected = this.text ? 0 : 1;
    this.options.actions.requestRender();
  }
  private fail(status: string): void {
    if (this.removed) return;
    const wasCapturing = this.capturing;
    this.capturing = false; this.clearListeners(); this.text = ""; this.partial = "";
    this.phase = "review"; this.selected = 1; this.status = status;
    if (wasCapturing) this.stop(false);
    this.options.actions.requestRender();
  }
  private rows(): Array<{ label: string; dim: boolean; onSelect: () => void }> {
    return [
      { label: "Search", dim: !this.text, onSelect: () => {
        if (this.removed || this.delivered || this.phase !== "review" || !this.text) return;
        this.delivered = true;
        try { this.options.onSearch(this.text); } finally { this.options.dismiss(); }
      } },
      { label: "Try again", dim: false, onSelect: () => { if (!this.removed) { this.phase = "capturing"; this.startCapture(); } } },
      { label: "Cancel", dim: false, onSelect: () => this.options.dismiss() },
    ];
  }
  paint(_context: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    paintInputDialog(image, { title: this.options.label || "Voice search", status: this.status,
      text: this.text || this.partial || "Say a name", rows: this.phase === "review" ? this.rows() : [], selectedRow: this.selected,
      hint: this.phase === "review" ? undefined : gestureHints([[GESTURE_CLICK, "done"], [GESTURE_DOUBLE_CLICK, "cancel"]]) });
    return image;
  }
  handleInput(event: InputEvent, _context: LayerContext): void {
    if (this.removed) return;
    if (event.type === "double-click") { this.options.dismiss(); return; }
    if (this.phase === "capturing" && event.type === "click") { this.endCapture(); return; }
    if (this.phase !== "review") return;
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.selected = (this.selected + (event.type === "scroll-up" ? 2 : 1)) % 3;
      this.options.actions.requestRender();
    } else if (event.type === "click") this.rows()[this.selected].onSelect();
  }
  onRemoved(): void {
    if (this.removed) return;
    this.removed = true;
    const wasCapturing = this.capturing;
    this.capturing = false; this.clearListeners(); this.text = ""; this.partial = "";
    if (wasCapturing) this.stop(false);
    this.options.onClosed();
  }
}
