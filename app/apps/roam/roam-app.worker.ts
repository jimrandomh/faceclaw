/**
 * Roam app worker. Shows a Roam Research page (today's daily note by default)
 * as a selectable outline: ring scroll moves the selection, click toggles a
 * todo or follows a [[page]] link, double-click walks back through visited
 * pages then yields focus. Edits (check/uncheck, add todo, edit block) go
 * through the Roam backend API and are also exposed as assistant tools.
 * The graph name and API token are configured here too, from the long-press
 * menu, via the phone app's text editor.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { onSettingsStoreChanged } from "../../native/settings-store";
import type { MenuItem } from "../../ui/menu";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolResult, ToolSpec } from "../../assistant/tool-registry";
import { GESTURE_CLICK, type InputEvent } from "../../ui/gestures";
import {
  roamApiTokenSetting,
  roamGraphNameSetting,
  type ConfigSettingString,
} from "../../ui/dashboard-settings";
import { DocumentView } from "../../ui/document/document-view";
import { docNodePageLink, type DocNode } from "../../ui/document/document-model";
import {
  createBlock,
  createPage,
  dailyPageTitle,
  dailyPageUid,
  fetchPageByUid,
  findPageUidByTitle,
  isRoamConfigured,
  updateBlockString,
  type RoamPage,
} from "./roam-api";
import {
  findBlockMatching,
  findTodoParentUid,
  flattenBlocks,
  isTodoBlock,
  pageToDocument,
  pageToToolText,
  plainBlockText,
  setTodoMarker,
} from "./roam-doc";

declare const global: any;
declare const com: any;

const HEADER_HEIGHT = 30;
const BOTTOM_MARGIN = 6;
const DOC_MARGIN = 6;
/** Reload the shown page when it is foregrounded and older than this. */
const STALE_AFTER_MS = 60_000;

const smallFont = getDefaultSmallFont();

type RoamWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  focused: boolean;
  menu: WindowMenu | null;
  view: DocumentView;
  lastSubmittedFingerprint: string;
};

type PageRef = { uid: string | null; title: string };

const ROAM_TOOLS: ToolSpec[] = [
  {
    name: "read_page",
    description:
      "Read the Roam page currently shown on the glasses (today's daily note by default), as an indented outline. Todo items are marked [ ] (open) or [x] (done).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "add_todo",
    description: "Add a new TODO item to today's Roam daily page (under its Todo section when one exists).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The todo item's text." } },
      required: ["text"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "set_todo_done",
    description:
      "Check off (or uncheck) a todo item on the Roam page currently shown, found by matching its text. Returns the item's new state.",
    inputSchema: {
      type: "object",
      properties: {
        match: { type: "string", description: "Text of the todo to change (partial matches allowed)." },
        done: { type: "boolean", description: "True to mark done (default), false to reopen." },
      },
      required: ["match"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
  {
    name: "edit_block",
    description:
      "Rewrite the text of a block on the Roam page currently shown, found by matching its current text. A todo block keeps its todo status.",
    inputSchema: {
      type: "object",
      properties: {
        match: { type: "string", description: "Current text of the block to edit (partial matches allowed)." },
        new_text: { type: "string", description: "Replacement text for the block." },
      },
      required: ["match", "new_text"],
      additionalProperties: false,
    },
    availability: "open",
    timeoutMs: 14_000,
  },
];

let window: RoamWindow | null = null;
let screenOn = true;

let currentPage: RoamPage | null = null;
let currentRef: PageRef | null = null;
/** The current page exists only locally (an empty daily note not yet in Roam). */
let pageMissing = false;
let backStack: PageRef[] = [];
let loading = false;
let errorMessage = "";
let lastFetchMs = 0;
let loadSerial = 0;
/** Setting being edited on the "type on the phone" screen, when open. */
let editingSetting: ConfigSettingString | null = null;

// Live keystrokes from the phone editor (and edits from other isolates, e.g.
// a settings import): repaint the edit screen / the not-configured hint.
onSettingsStoreChanged((key) => {
  if (key.startsWith("integrations.roam.")) render();
});

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost). Top-level
// evaluation is synchronous, so the handler below is installed before any
// queued message can be delivered.
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window":
      window = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        view: new DocumentView(
          message.viewport.width - DOC_MARGIN * 2,
          message.viewport.height - HEADER_HEIGHT - BOTTOM_MARGIN,
        ),
        lastSubmittedFingerprint: "",
      };
      post({ type: "set-tools", windowId: message.windowId, tools: ROAM_TOOLS });
      void loadPage(todayRef(), { resetStack: true });
      break;
    case "close-window":
      if (editingSetting) {
        // Window closed mid-edit: shut the phone editor down.
        editingSetting = null;
        post({ type: "end-text-setting-edit" });
      }
      window = null;
      break;
    case "input":
      if (!window || window.windowId !== message.windowId) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown roam window");
        break;
      }
      window.focused = message.focused;
      inferForeground(message.focused);
      // Marks the main-thread -> worker hop, which is otherwise an
      // unexplained gap inside the shell's handle-input span.
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    case "text-input":
      if (editingSetting) {
        // Voice input as an alternative to the phone keyboard.
        editingSetting.set(message.text.trim());
        render();
      } else if (message.text.trim()) {
        // Voice input / typed text becomes a new todo on the shown page.
        void addTodoFromText(message.text.trim());
      }
      break;
    case "render":
      if (!window) break;
      window.focused = message.focused;
      inferForeground(message.focused);
      render();
      break;
    case "foreground":
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (window.foreground) {
        maybeRefreshStalePage();
        render();
      }
      break;
    case "screen":
      screenOn = message.on;
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleRoamTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) =>
          post({
            type: "tool-result",
            callId,
            result: { ok: false, error: String((error as Error)?.message ?? error) },
          }),
        );
      break;
    }
  }
};

/**
 * Input and render messages only target the foreground window, so a focused
 * message proves foreground; backstops a "foreground" message lost while the
 * freshly spawned worker was still evaluating its bundle.
 */
function inferForeground(focused: boolean): void {
  if (!focused || !window || window.foreground) return;
  window.foreground = true;
  maybeRefreshStalePage();
}

// ---------------------------------------------------------------------------
// Page loading

function todayRef(): PageRef {
  const now = new Date();
  return { uid: dailyPageUid(now), title: dailyPageTitle(now) };
}

async function loadPage(ref: PageRef, options: { resetStack?: boolean; pushCurrent?: boolean } = {}): Promise<void> {
  if (!isRoamConfigured()) {
    errorMessage = "";
    render();
    return;
  }
  const serial = ++loadSerial;
  if (options.resetStack) backStack = [];
  if (options.pushCurrent && currentRef) backStack.push(currentRef);
  currentRef = ref;
  loading = true;
  errorMessage = "";
  render();
  try {
    let uid = ref.uid;
    if (!uid) {
      uid = await findPageUidByTitle(ref.title);
      if (serial !== loadSerial) return;
      if (!uid) throw new Error(`No page named "${ref.title}" in the graph.`);
      ref.uid = uid;
    }
    const page = await fetchPageByUid(uid);
    if (serial !== loadSerial) return;
    if (page) {
      currentPage = page;
      pageMissing = false;
    } else if (uid === dailyPageUid(new Date())) {
      // Today's daily note isn't created until something is written to it.
      currentPage = { uid, title: ref.title, children: [] };
      pageMissing = true;
    } else {
      throw new Error(`Page "${ref.title}" no longer exists.`);
    }
    lastFetchMs = Date.now();
    window?.view.setDocument(pageToDocument(currentPage));
  } catch (error) {
    if (serial !== loadSerial) return;
    errorMessage = String((error as Error)?.message ?? error);
  } finally {
    if (serial === loadSerial) {
      loading = false;
      render();
    }
  }
}

async function reloadCurrentPage(): Promise<void> {
  if (currentRef) await loadPage({ ...currentRef }, {});
}

function maybeRefreshStalePage(): void {
  if (loading || !currentRef || !isRoamConfigured()) return;
  if (Date.now() - lastFetchMs < STALE_AFTER_MS) return;
  void reloadCurrentPage();
}

// ---------------------------------------------------------------------------
// Input

function windowMenu(win: RoamWindow): WindowMenu {
  if (!win.menu) {
    win.menu = new WindowMenu({
      size: { width: win.viewportWidth, height: win.viewportHeight },
      paintBase: () => paintContent(win),
      isFocused: () => win.focused,
    });
  }
  return win.menu;
}

function menuItems(win: RoamWindow): MenuItem[] {
  const items: MenuItem[] = [];
  const today = todayRef();
  if (currentRef?.uid !== today.uid) {
    items.push({
      label: "Today's page",
      onSelect: (ctx) => {
        ctx.stack.pop();
        void loadPage(today, { resetStack: true });
      },
    });
  }
  items.push({
    label: "Refresh",
    onSelect: (ctx) => {
      ctx.stack.pop();
      void reloadCurrentPage();
    },
  });
  if (backStack.length > 0) {
    items.push({
      label: "Back",
      onSelect: (ctx) => {
        ctx.stack.pop();
        goBack();
      },
    });
  }
  items.push({
    label: "Set graph name",
    onSelect: (ctx) => {
      ctx.stack.pop();
      beginSettingEdit(roamGraphNameSetting);
    },
  });
  items.push({
    label: "Set API token",
    onSelect: (ctx) => {
      ctx.stack.pop();
      beginSettingEdit(roamApiTokenSetting);
    },
  });
  return [...items, ...defaultWindowMenuItems(win.windowId, post)];
}

/**
 * Enter the setting-edit screen and ask the shell to open the phone app's
 * text editor on the setting. The editor writes the setting live; click (or
 * double-click) here finishes the edit.
 */
function beginSettingEdit(setting: ConfigSettingString): void {
  editingSetting = setting;
  post({ type: "start-text-setting-edit", settingId: setting.id });
  render();
}

/** Leave the edit screen; if Roam just became usable, load the page. */
function endSettingEdit(): void {
  editingSetting = null;
  post({ type: "end-text-setting-edit" });
  if (isRoamConfigured() && (!currentPage || errorMessage)) {
    void loadPage(currentRef ?? todayRef(), { resetStack: !currentRef });
  }
}

function handleInput(win: RoamWindow, event: InputEvent, frameId: number): void {
  if (win.menu?.isOpen()) {
    win.menu
      .handleInput(event)
      .catch((error) => console.error(`roam menu input failed: ${error}`))
      .then(() => renderAndSubmit(win, frameId));
    return;
  }
  if (editingSetting) {
    if (event.type === "click" || event.type === "double-click") {
      endSettingEdit();
      renderAndSubmit(win, frameId);
    } else {
      frameTimings.finishFrame(frameId, "discarded: roam edit-screen ignored input");
    }
    return;
  }
  if (event.type === "long-press") {
    windowMenu(win).open(menuItems(win));
    renderAndSubmit(win, frameId);
    return;
  }
  if (event.type === "double-click") {
    if (backStack.length > 0) {
      frameTimings.finishFrame(frameId, "discarded: roam back navigation");
      goBack();
    } else {
      frameTimings.finishFrame(frameId, "discarded: roam yielded focus");
      post({ type: "yield-focus", windowId: win.windowId });
    }
    return;
  }
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    win.view.moveSelection(event.type === "scroll-down" ? 1 : -1);
    renderAndSubmit(win, frameId);
    return;
  }
  if (event.type === "click") {
    if (errorMessage) {
      frameTimings.finishFrame(frameId, "discarded: roam retry");
      void reloadCurrentPage();
      return;
    }
    const node = win.view.selectedNode();
    if (node?.kind === "todo") {
      frameTimings.finishFrame(frameId, "discarded: roam todo toggle renders async");
      void toggleTodo(node);
      return;
    }
    const link = node ? docNodePageLink(node) : null;
    if (link) {
      frameTimings.finishFrame(frameId, "discarded: roam link follow renders async");
      void loadPage({ uid: null, title: link }, { pushCurrent: true });
      return;
    }
    frameTimings.finishFrame(frameId, "discarded: roam ignored click");
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: roam ignored input");
}

function goBack(): void {
  const previous = backStack.pop();
  if (previous) void loadPage(previous, {});
}

// ---------------------------------------------------------------------------
// Edits

async function toggleTodo(node: DocNode): Promise<void> {
  if (!currentPage) return;
  const flat = flattenBlocks(currentPage);
  const entry = flat.find(({ block }) => block.uid === node.id);
  if (!entry) return;
  const block = entry.block;
  const previousText = block.string;
  const nowDone = !node.checked;
  block.string = setTodoMarker(previousText, nowDone);
  window?.view.setDocument(pageToDocument(currentPage));
  render();
  try {
    await updateBlockString(block.uid, block.string);
  } catch (error) {
    block.string = previousText;
    errorMessage = `Sync failed: ${(error as Error)?.message ?? error}`;
    window?.view.setDocument(pageToDocument(currentPage));
    if (window) post({ type: "set-attention", windowId: window.windowId, attention: true });
    render();
  }
}

/** Create today's daily page if it only exists locally. */
async function ensureCurrentPageExists(): Promise<void> {
  if (!currentPage || !pageMissing) return;
  await createPage(currentPage.title, currentPage.uid);
  pageMissing = false;
}

async function addTodoToPage(page: RoamPage, text: string): Promise<void> {
  await createBlock(findTodoParentUid(page), "last", `{{[[TODO]]}} ${text}`);
}

async function addTodoFromText(text: string): Promise<void> {
  try {
    if (!currentPage) throw new Error("No page is loaded.");
    await ensureCurrentPageExists();
    await addTodoToPage(currentPage, text);
    await reloadCurrentPage();
  } catch (error) {
    errorMessage = `Add failed: ${(error as Error)?.message ?? error}`;
    render();
  }
}

// ---------------------------------------------------------------------------
// Tools

async function handleRoamTool(name: string, args: any): Promise<ToolResult> {
  if (!isRoamConfigured()) {
    return { ok: false, error: "Roam is not configured; set the graph name and API token from the Roam app's long-press menu." };
  }
  switch (name) {
    case "read_page": {
      if (currentRef) await reloadCurrentPage();
      else await loadPage(todayRef(), { resetStack: true });
      if (errorMessage) return { ok: false, error: errorMessage };
      if (!currentPage) return { ok: false, error: "No page is loaded." };
      return { ok: true, content: pageToToolText(currentPage) };
    }
    case "add_todo": {
      const text = String(args?.text ?? "").trim();
      if (!text) return { ok: false, error: "add_todo requires text." };
      const today = todayRef();
      let page = currentPage && currentPage.uid === today.uid ? currentPage : await fetchPageByUid(today.uid!);
      if (!page) {
        await createPage(today.title, today.uid!);
        page = { uid: today.uid!, title: today.title, children: [] };
      } else if (page === currentPage) {
        await ensureCurrentPageExists();
      }
      await addTodoToPage(page, text);
      if (currentRef?.uid === today.uid) await reloadCurrentPage();
      return { ok: true, content: `Added todo: ${text}` };
    }
    case "set_todo_done": {
      const match = String(args?.match ?? "").trim();
      if (!match) return { ok: false, error: "set_todo_done requires match text." };
      if (!currentPage) return { ok: false, error: "No page is loaded." };
      const done = args?.done !== false;
      const block = findBlockMatching(currentPage, match, (candidate) => isTodoBlock(candidate.string));
      if (!block) return { ok: false, error: `No todo matching "${match}" on ${currentPage.title}.` };
      await updateBlockString(block.uid, setTodoMarker(block.string, done));
      await reloadCurrentPage();
      return {
        ok: true,
        content: `Marked "${plainBlockText(block.string).trim()}" as ${done ? "done" : "not done"}.`,
      };
    }
    case "edit_block": {
      const match = String(args?.match ?? "").trim();
      const newText = String(args?.new_text ?? "").trim();
      if (!match || !newText) return { ok: false, error: "edit_block requires match and new_text." };
      if (!currentPage) return { ok: false, error: "No page is loaded." };
      const block = findBlockMatching(currentPage, match);
      if (!block) return { ok: false, error: `No block matching "${match}" on ${currentPage.title}.` };
      const marker = /^\s*\{\{(?:\[\[)?DONE/.test(block.string) ? true : isTodoBlock(block.string) ? false : null;
      const replacement = marker === null || isTodoBlock(newText) ? newText : setTodoMarker(newText, marker);
      await updateBlockString(block.uid, replacement);
      await reloadCurrentPage();
      return { ok: true, content: `Rewrote block to: ${plainBlockText(replacement).trim()}` };
    }
    default:
      return { ok: false, error: `Unknown roam tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Painting

function paint(win: RoamWindow): Plane[] {
  if (win.menu?.isOpen()) return win.menu.paint();
  if (editingSetting) return singlePlane(paintSettingEdit(win, editingSetting));
  return singlePlane(paintContent(win));
}

/** The "type on the phone" screen shown while a Roam setting is being edited. */
function paintSettingEdit(win: RoamWindow, setting: ConfigSettingString): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const step = smallFont.lineHeight + 2;
  image.drawText(smallFont, DOC_MARGIN + 2, 6, setting.glassesEditTitle, 225);
  image.drawLine(DOC_MARGIN, HEADER_HEIGHT - 4, win.viewportWidth - DOC_MARGIN, HEADER_HEIGHT - 4, 40);
  const messageY = HEADER_HEIGHT + 16;
  const lines = wrapText(smallFont, "Type the value in the phone app, or use voice input.", win.viewportWidth - DOC_MARGIN * 2 - 24);
  for (let index = 0; index < lines.length; index++) {
    image.drawText(smallFont, DOC_MARGIN + 12, messageY + index * step, lines[index]!, 190);
  }
  // The live value, unmasked so the user can check what they typed.
  const value = setting.get();
  const valueY = messageY + (lines.length + 1) * step;
  image.drawText(
    smallFont,
    DOC_MARGIN + 12,
    valueY,
    truncateText(smallFont, value || "(empty)", win.viewportWidth - DOC_MARGIN * 2 - 24),
    value ? 225 : 130,
  );
  image.drawText(smallFont, DOC_MARGIN + 12, win.viewportHeight - smallFont.lineHeight - 12, `${GESTURE_CLICK} done`, 110);
  return image;
}

function paintContent(win: RoamWindow): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  const title = currentRef?.title ?? "Roam";
  const status = loading ? "Loading..." : pageMissing ? "(new page)" : "";
  const statusWidth = status ? smallFont.measureText(status) + 12 : 0;
  image.drawText(
    smallFont,
    DOC_MARGIN + 2,
    6,
    truncateText(smallFont, title, win.viewportWidth - DOC_MARGIN * 2 - statusWidth - 4),
    225,
  );
  if (status) {
    image.drawText(smallFont, win.viewportWidth - DOC_MARGIN - smallFont.measureText(status), 6, status, 130);
  }
  image.drawLine(DOC_MARGIN, HEADER_HEIGHT - 4, win.viewportWidth - DOC_MARGIN, HEADER_HEIGHT - 4, 40);

  if (!isRoamConfigured()) {
    drawBodyMessage(image, win, "Set the Roam graph name and API token: long-press for the menu, then pick Set graph name and Set API token.");
  } else if (errorMessage) {
    drawBodyMessage(image, win, `${errorMessage}\n\n${GESTURE_CLICK} retry`);
  } else if (currentPage && currentPage.children.length === 0 && !loading) {
    drawBodyMessage(image, win, "Nothing here yet. Use voice input to add a todo.");
  } else {
    win.view.paint(image, DOC_MARGIN, HEADER_HEIGHT, win.focused);
  }
  return image;
}

function drawBodyMessage(image: GrayImage, win: RoamWindow, message: string): void {
  const lines = wrapText(smallFont, message, win.viewportWidth - DOC_MARGIN * 2 - 24);
  let y = HEADER_HEIGHT + 16;
  for (const line of lines) {
    image.drawText(smallFont, DOC_MARGIN + 12, y, line, 190);
    y += smallFont.lineHeight + 2;
  }
}

function render(): void {
  if (window && window.foreground && screenOn) renderAndSubmit(window, 0);
}

function renderAndSubmit(win: RoamWindow, inputFrameId: number): void {
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${win.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(win)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === win.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: roam content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      win.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    win.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: roam render failed");
    console.error(`roam worker render failed: ${error}`);
  }
}
