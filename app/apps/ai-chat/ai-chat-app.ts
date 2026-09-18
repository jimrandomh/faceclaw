import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { ASSISTANT_MODEL_VALUES, assistantModelLabel, resolveAssistantModel } from "../../assistant/models";
import type { AssistantTranscriptEntry } from "../../assistant/session";
import type { AssistantConversations, ReasoningLevel } from "../../assistant/conversations";
import { anthropicApiKeySetting, assistantBackendSetting, openAiApiKeySetting } from "../../ui/dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_LONG_PRESS, gestureHints, type InputEvent } from "../../ui/gestures";
import type { Layer, LayerContext } from "../../ui/layers";
import type { MenuItem } from "../../ui/menu";
import { WindowMenuLayer } from "../../ui/window-menu";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { VoiceDraft } from "./voice-draft";

class AiChatLayer implements Layer {
  readonly acceptsDirectional = true;
  private firstLine: number | null = null; // null follows the streaming tail
  private maxFirstLine = 0;
  private selectedId = "";
  private requestRender = () => {};
  private readonly wrappedEntries = new WeakMap<AssistantTranscriptEntry, {
    font: UiFont; width: number; text: string; lines: string[];
  }>();
  readonly draft: VoiceDraft;

  constructor(private readonly conversations: AssistantConversations, options: InProcessAppOptions) {
    this.draft = new VoiceDraft(options.actions, () => shell.prepareChatVoiceCapture(),
      () => this.requestRender(), (text) => this.send(text));
  }
  start(render: () => void): () => void {
    this.requestRender = render;
    return this.conversations.onChanged(() => render());
  }
  send(text: string): void {
    this.firstLine = null;
    shell.sendToAssistant(text, false);
  }
  paint(ctx: LayerContext): GrayImage {
    const size = ctx.stack.getBaseSize();
    const image = new GrayImage(size.width, size.height);
    const font = getDefaultSmallFont();
    const step = font.lineHeight + 3;
    const left = 12;
    const width = size.width - 28;
    const record = this.conversations.current();
    if (this.selectedId !== record.id) { this.selectedId = record.id; this.firstLine = null; }
    const transcript = record.session?.transcript ?? record.history?.transcript ?? [];
    const title = this.conversations.title();
    image.drawText(font, left, 6, truncateText(font, title, width), 180);
    const label = assistantBackendSetting.get() === "external" ? "External agent" :
      `${assistantModelLabel(record.model)} · ${record.reasoning === "default" ? "default reasoning" : record.reasoning}`;
    const footer = wrapText(font, `${label}   ${gestureHints([
      [GESTURE_CLICK, "menu"], [GESTURE_DOUBLE_CLICK, "back"], [GESTURE_LONG_PRESS, "hold to talk"],
    ])}`, width);
    const footerY = size.height - step * footer.length;
    const footerTop = footerY - step * 3 - 12;
    const historyTop = step + 16;
    const visible = Math.max(1, Math.floor((footerTop - historyTop - 8) / step));
    const lines: { text: string; color: number }[] = [];
    for (const entry of transcript) {
      if (!entry.text) continue;
      let wrapped = this.wrappedEntries.get(entry);
      if (!wrapped || wrapped.font !== font || wrapped.width !== width || wrapped.text !== entry.text) {
        wrapped = { font, width, text: entry.text,
          lines: wrapText(font, `${entry.role === "user" ? "You" : "AI"}: ${entry.text}`, width - 8) };
        this.wrappedEntries.set(entry, wrapped);
      }
      for (const text of wrapped.lines) {
        lines.push({ text, color: entry.role === "user" ? 175 : 245 });
      }
      lines.push({ text: "", color: 0 });
    }
    if (!lines.length) lines.push({ text: "Hold to talk to your assistant.", color: 175 },
      { text: "Voice and chat share this conversation.", color: 150 });
    this.maxFirstLine = Math.max(0, lines.length - visible);
    const first = this.firstLine === null ? this.maxFirstLine : Math.min(this.firstLine, this.maxFirstLine);
    for (let row = 0; row < visible; row++) {
      const line = lines[first + row];
      if (line) image.drawText(font, left, historyTop + row * step, line.text, line.color);
    }
    if (this.maxFirstLine > 0) {
      const track = visible * step;
      const thumb = Math.max(8, Math.floor(track * visible / lines.length));
      image.fillRect(size.width - 5, historyTop + Math.floor((track - thumb) * first / this.maxFirstLine), 2, thumb, 110);
    }
    image.fillRect(left, footerTop, width, 1, 65);
    const state = this.draft.active ? this.draft.status : record.session?.status || this.draft.status;
    if (state) image.drawText(font, left, footerTop + 5, truncateText(font, state, width), 160);
    const pending = wrapText(font, this.draft.text || (this.draft.active ? "Listening..." : "Hold to speak; release to send"), width);
    pending.slice(-2).forEach((text, i) => image.drawText(font, left, footerTop + step * (i + 1) + 5, text, 220));
    footer.forEach((text, i) => image.drawText(font, left + width - font.measureText(text), footerY + i * step, text, 120));
    return image;
  }
  handleInput(event: InputEvent): void {
    switch (event.type) {
      case "scroll-up": case "swipe-up":
        this.firstLine = Math.max(0, (this.firstLine ?? this.maxFirstLine) - 3); return;
      case "scroll-down": case "swipe-down": {
        const next = (this.firstLine ?? this.maxFirstLine) + 3;
        this.firstLine = next >= this.maxFirstLine ? null : next; return;
      }
      case "long-press":
        if (!this.conversations.current().session?.isTurnActive()) {
          if (!shell.isAssistantAvailable()) { shell.showAlert("Set an API key or download the on-phone model in Settings."); return; }
          void this.draft.start();
        }
        return;
      case "long-press-release": this.draft.release(); return;
      case "double-click": this.draft.cancel(); shell.yieldFocusToSidebar(); return;
    }
  }
  menuItems(): MenuItem[] {
    const record = this.conversations.current();
    const busy = () => this.draft.active || Boolean(record.session?.isTurnActive());
    const external = assistantBackendSetting.get() === "external";
    const submenu = (ctx: LayerContext, title: string, items: MenuItem[]) => ctx.stack.push(new WindowMenuLayer(title, items, true));
    return [
      ...(external ? [{ label: "Sessions and model managed by bridge", disabled: true, onSelect: () => {} }] : []),
      { label: "New session", disabled: () => external || busy(), onSelect: (ctx) => {
        if (this.conversations.create()) ctx.stack.clearToBase();
      } },
      { label: "Switch session", disabled: () => external || busy(), onSelect: (ctx) => submenu(ctx, "Sessions",
        [...this.conversations.list()].reverse().map((item) => ({
          label: `${item.id === record.id ? "✓ " : ""}${this.conversations.title(item)}`,
          onSelect: (ctx) => { if (this.conversations.select(item.id)) ctx.stack.clearToBase(); },
        }))) },
      { label: `Model: ${assistantModelLabel(record.model)}`, disabled: () => external || busy(), onSelect: (ctx) => submenu(ctx, "Model",
        ASSISTANT_MODEL_VALUES.map((model) => ({
          label: `${model === record.model ? "✓ " : ""}${assistantModelLabel(model)}`,
          disabled: () => !this.conversations.available(model, record.reasoning),
          onSelect: (ctx) => { if (this.conversations.configure(model, record.reasoning)) ctx.stack.clearToBase(); },
        }))) },
      { label: `Reasoning: ${record.reasoning}`, disabled: () => {
        const llm = resolveAssistantModel(record.model, { anthropic: anthropicApiKeySetting.get(), openai: openAiApiKeySetting.get() });
        return external || busy() || !llm?.effort;
      }, onSelect: (ctx) => submenu(ctx, "Reasoning", (["default", "low", "medium", "high"] as ReasoningLevel[]).map((reasoning) => ({
        label: `${reasoning === record.reasoning ? "✓ " : ""}${reasoning === "default" ? "Model default" : reasoning}`,
        onSelect: (ctx) => { if (this.conversations.configure(record.model, reasoning)) ctx.stack.clearToBase(); },
      }))) },
      ...(record.session?.isTurnActive() ? [{ label: "Cancel response", onSelect: (ctx: LayerContext) => {
        record.session?.cancel(); ctx.stack.clearToBase();
      } }] : []),
    ];
  }
}

export function createAiChatWindow(options: InProcessAppOptions): InProcessWindow {
  const layer = new AiChatLayer(shell.getAssistantConversations(), options);
  let unsubscribe = () => {};
  const app = createInProcessWindow({
    ...options,
    appId: "ai-chat", windowId: "ai-chat", title: "AI Chat", iconLetter: "AI", icon: "message-circle", closeable: true,
    baseLayer: layer, holdToTalk: true,
    isVoiceCapturing: () => layer.draft.active,
    onSystemMenuOpened: () => layer.draft.cancel(),
    onAppMenuOpened: () => layer.draft.cancel(),
    setScreenOn: (on) => { if (!on) layer.draft.cancel(); },
    setSurfaceVisible: (visible) => { if (!visible) layer.draft.cancel(); options.setSurfaceVisible(visible); },
    menuItems: () => layer.menuItems(),
    receiveTextInput: (text) => { if (!layer.draft.active) layer.send(text); },
    onClosed: () => { unsubscribe(); layer.draft.cancel(); options.onClosed(); },
  });
  unsubscribe = layer.start(app.requestRender);
  return app;
}
