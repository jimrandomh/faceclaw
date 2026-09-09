import { shell } from "../../ui/shell/shell";
import { toolRegistry, type ToolResult } from "../../assistant/tool-registry";
import { readActiveNotifications, onAndroidNotificationPosted, onAndroidNotificationsChanged, onAndroidNotificationRemoved, dismissNotification, invokeNotificationActionAtVersion, replyToNotification, type AndroidNotification } from "../../native/notification-icons";
import { getExternalNotificationReply, invokeExternalNotification } from "../../native/external-notifications";
import { readNotificationApps } from "../../native/notification-apps";
import { shouldShowNotificationOnGlasses } from "../../native/notification-sources";
import { initializeSharedHostStyle } from "../../native/shared-style";
import { boundedToken, record, ExtensionToolCalls, NotificationLeases } from "./extension-policy";

declare const java: any;
export type ExtensionFeature = { feature: string; component: string; configuration: Record<string, unknown>; live: boolean; available: boolean; generation: number };
export type ExtensionHooks = {
  apps?: () => { appId: string; title: string; icon?: string; uninstallable?: boolean }[];
  launchApp?: (appId: string) => void;
  uninstallApp?: (appId: string) => Promise<void> | void;
  hostState?: () => { weather?: unknown };
  showSurface?: (feature: string, component: string, target?: string) => boolean;
  closeSurface?: (feature: string, restoreSleep?: boolean) => void;
  notificationReplyReturn?: () => (() => void);
  onFrame?: (component: string, feature: string, generation: number, width: number, height: number, pixels: Uint8Array) => void;
};
type Pending = { component: string; feature: string; generation: number; own?: boolean; resolve: (data: any) => void; reject: (error: Error) => void; progress?: (data: any) => void };
export type ProviderRequest = { requestId: string; promise: Promise<any>; cancel: () => void; event: (data: unknown) => boolean };
let active: ExtensionPlatform | null = null;
export function extensionPlatform(): ExtensionPlatform | null { return active; }
const newId = (): string => String(java.util.UUID.randomUUID().toString());

/** APK code stays in its UID. This adapter alone resolves sensitive host actions. */
export class ExtensionPlatform {
  private generation = 0;
  private features: ExtensionFeature[] = [];
  private readonly reviews = new Map<string, { cancel: () => void; current: () => boolean }>();
  private readonly pending = new Map<string, Pending>();
  private readonly uiNotifications = new NotificationLeases<AndroidNotification>(newId);
  private readonly ownNotifications = new Map<string, { leases: NotificationLeases<AndroidNotification>; snapshot: string }>();
  private readonly toolNotifications = new NotificationLeases<AndroidNotification>(newId);
  private readonly calls = new ExtensionToolCalls();
  private notificationRevision = 0;
  private notificationAppsAt = 0;
  private notificationApps: { packageName: string; name: string }[] = [];
  private lastNotificationSnapshot = "";
  private lastState = "";
  private menu: { component: string; generation: number; windowId: string; items: Map<string, { label: string; enabled?: boolean; onSelect: () => void }>; onClosed?: () => void } | null = null;
  private readonly conversationIds = new Map<string, string>();
  private lastGesture = new Map<string, number>();
  constructor(private readonly native: any, private readonly hooks: ExtensionHooks, private readonly isLocked: () => boolean, private readonly isProtected: () => boolean = () => false) {
    active = this; initializeSharedHostStyle(); this.refresh();
    onAndroidNotificationPosted(key => this.notificationsChanged(key));
    onAndroidNotificationRemoved(() => this.notificationsChanged());
    onAndroidNotificationsChanged(() => this.notificationsChanged());
    toolRegistry.onToolsChanged(() => this.publishTools());
    setInterval(() => { this.publishState(); this.notificationsChanged(); }, 1000);
  }
  feature(feature: string): ExtensionFeature | undefined { return this.features.find(item => item.feature === feature && item.component && item.available); }
  controls(component: string, feature: string, generation?: number): boolean {
    const winner = this.feature(feature);
    return !!winner && winner.component === component && (generation === undefined || winner.generation === generation);
  }
  handlesNotifications(): boolean { return !!this.feature("ui.notifications") && !this.isLocked(); }
  private refresh(): void {
    let snapshot: any;
    try { snapshot = JSON.parse(String(this.native.extensionsJson())); } catch { snapshot = {}; }
    const generation = Number(snapshot.generation) || 0;
    const next: ExtensionFeature[] = Array.isArray(snapshot.features) ? snapshot.features : [];
    const changed = new Set(this.features.filter(previous => {
      const current = next.find(item => item.feature === previous.feature);
      return !current || current.generation !== previous.generation || current.component !== previous.component || current.available !== previous.available;
    }).map(item => item.feature));
    for (const [id, request] of this.pending) {
      const current = next.find(item => item.feature === request.feature);
      if (!current || current.generation !== request.generation || (request.own
        ? !this.native.isExtensionGranted(request.component, request.feature)
        : !current.available || current.component !== request.component)) {
        this.pending.delete(id); request.reject(new Error("Extension unavailable; outcome may be unknown"));
      }
    }
    if (changed.has("ui.notifications")) {
      for (const review of this.reviews.values()) review.cancel(); this.reviews.clear();
      this.uiNotifications.clear(); this.lastNotificationSnapshot = "";
    }
    if (changed.has("device-tools")) this.toolNotifications.clear();
    if (changed.has("ui.app-menu")) this.closeMenu();
    for (const feature of changed) {
      this.lastGesture.delete(feature);
      if (["ui.launcher", "ui.app-menu", "ui.notifications"].includes(feature)) this.hooks.closeSurface?.(feature);
    }
    if (generation !== this.generation) {
      this.generation = generation;
      // Own-window notification snapshots still use the snapshot revision, not a winning feature epoch.
      this.ownNotifications.clear(); this.lastState = "";
    }
    this.features = next;
    this.publishState(); this.publishTools(); this.notificationsChanged();
  }
  onNativeEvent(component: string, type: string, data: any): boolean {
    if (type === "extensions-changed") { this.refresh(); return true; }
    if (type !== "extension-event") return false;
    if (!record(data) || typeof data.feature !== "string" || typeof data.generation !== "number") return true;
    if (["result", "progress", "timeout"].includes(String(data.type)) && typeof data.requestId === "string") {
      const pending = this.pending.get(data.requestId);
      if (!pending || pending.component !== component || pending.feature !== data.feature || pending.generation !== data.generation) return true;
      if (data.type === "progress") { if (record(data.data)) pending.progress?.(data.data); return true; }
      this.pending.delete(data.requestId);
      if (data.type === "timeout") pending.reject(new Error("Extension timed out; outcome may be unknown"));
      else pending.resolve(data.data);
      return true;
    }
    if (data.type === "action" && this.controls(component, data.feature, data.generation) && record(data.data)) void this.action(component, data.feature, data.generation, String(data.action), data.data);
    return true;
  }
  provider(feature: string, data: Record<string, unknown>, progress?: (data: any) => void, ownComponent?: string): ProviderRequest | null {
    const selected = this.feature(feature), component = ownComponent ?? selected?.component;
    if (!component || (ownComponent ? feature !== "transcription" || !this.native.isExtensionGranted(component, feature) : !selected)) return null;
    const generation = this.features.find(item => item.feature === feature)?.generation ?? this.generation, requestId = newId();
    let resolve!: (data: any) => void, reject!: (error: Error) => void;
    const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
    const pending = { component, feature, generation, own: !!ownComponent, resolve, reject, progress }; this.pending.set(requestId, pending);
    const send = (type: string, value: unknown) => Boolean(ownComponent
      ? this.native.sendAppProvider(component, feature, type, JSON.stringify(value))
      : this.native.sendExtension(component, feature, type, JSON.stringify(value)));
    if (!send("request", { ...data, requestId })) { this.pending.delete(requestId); return null; }
    return { requestId, promise, event: value => this.pending.get(requestId) === pending && send("event", { ...(record(value) ? value : {}), requestId }), cancel: () => {
      if (this.pending.get(requestId) !== pending) return;
      this.pending.delete(requestId); send("cancel", { requestId }); reject(new Error("Extension request cancelled"));
    } };
  }
  private event(component: string, feature: string, data: unknown): boolean {
    return Boolean(this.native.sendExtension(component, feature, "event", JSON.stringify(data)));
  }
  openSurface(feature: string, width: number, height: number): boolean {
    const selected = this.feature(feature);
    if (!selected || this.isLocked() || !this.native.openExtensionSurface(selected.component, feature, width, height)) return false;
    // A newly opened provider surface must receive a catalog even if host state is unchanged.
    this.publishState(true);
    return true;
  }
  setSurfaceVisibility(feature: string, visible: boolean, screenOn: boolean): void {
    const selected = this.feature(feature); if (selected) this.native.setExtensionSurfaceVisibility(selected.component, feature, visible, screenOn && !this.isLocked());
  }
  closeSurface(feature: string): void {
    if (feature === "ui.app-menu") this.closeMenu();
    const selected = this.feature(feature); if (selected) this.native.closeExtensionSurface(selected.component, feature); this.lastGesture.delete(feature);
  }
  /** A foreground app can host its notification reader in its own window.
   * Only host-delivered input counts; IPC requests cannot manufacture a gesture.
   */
  windowInput(component: string, input: unknown): void {
    if (!this.controls(component, "ui.notifications") || this.isLocked() || !shell.isScreenOn() ||
        shell.foregroundWindow()?.windowId !== `apk:${component}` || !record(input)) return;
    if (["click", "double-click", "pointer-click", "long-press", "short-then-long-press", "back", "swipe-left"].includes(String(input.type))) this.lastGesture.set("ui.notifications", Date.now());
  }
  surfaceInput(feature: string, input: unknown): void {
    const selected = this.feature(feature); if (!selected || this.isLocked() || !shell.isScreenOn() || !record(input)) return;
    if (["click", "double-click", "scroll-up", "scroll-down", "back", "long-press", "short-then-long-press"].includes(String(input.type))) this.lastGesture.set(feature, Date.now());
    this.native.sendExtension(selected.component, feature, "input", JSON.stringify({ event: "input", input }));
  }
  surfacePointer(feature: string, x: number, y: number, width: number, height: number): boolean {
    const selected = this.feature(feature);
    if (!selected || this.isLocked() || !shell.isScreenOn() || ![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 640 || height > 480 || x < 0 || y < 0 || x >= width || y >= height) return false;
    if (!this.native.sendExtensionPointer(selected.component, feature, x, y, width, height)) return false;
    this.lastGesture.set(feature, Date.now()); return true;
  }
  onFrame(component: string, feature: string, generation: number, width: number, height: number, pixels: Uint8Array): void {
    if (!this.controls(component, feature) || this.isLocked() || !shell.isScreenOn()) return;
    this.hooks.onFrame?.(component, feature, generation, width, height, pixels);
  }
  lockChanged(): void {
    if (this.isLocked()) {
      for (const review of this.reviews.values()) review.cancel(); this.reviews.clear();
      for (const feature of ["ui.launcher", "ui.app-menu", "ui.notifications"]) { this.setSurfaceVisibility(feature, false, false); this.hooks.closeSurface?.(feature); }
      this.lastGesture.clear(); this.uiNotifications.clear(); this.ownNotifications.clear();
    }
    this.lastState = ""; this.publishState();
  }
  private publishState(force = false): void {
    if (this.isLocked()) return;
    const state = { event: "host-state", battery: shell.getBatteryLevels(), ...(this.hooks.hostState?.() ?? {}), windows: shell.getWindows().map(window => ({ windowId: window.windowId, appId: window.appId, title: window.title, closeable: window.closeable === true })), focusedWindowId: shell.foregroundWindow()?.windowId ?? "", screenOn: shell.isScreenOn(), apps: this.hooks.apps?.() ?? [] };
    const serialized = JSON.stringify(state); if ((!force && serialized === this.lastState) || serialized.length > 30000) return;
    let delivered = true, recipients = 0;
    for (const feature of ["ui.launcher", "ui.app-menu", "ui.notifications"]) { const selected = this.feature(feature); if (selected) { recipients++; delivered = this.event(selected.component, feature, state) && delivered; } }
    if (recipients && delivered) this.lastState = serialized;
  }
  private notificationAppCatalog(): { packageName: string; name: string }[] {
    if (Date.now() - this.notificationAppsAt > 30000) {
      this.notificationAppsAt = Date.now(); this.notificationApps = readNotificationApps().slice(0, 4096).map(app => ({ packageName: app.packageName.slice(0, 255), name: app.name.slice(0, 100) }));
      // Full catalogs travel in bounded fragments, never an alphabetic prefix.
    }
    return this.notificationApps;
  }
  ownHostState(component?: string): unknown {
    const canRead = component && !this.isLocked() && (this.controls(component, "ui.notifications") || this.native.isExtensionGranted(component, "notification-content"));
    return { battery: shell.getBatteryLevels(), ...(this.hooks.hostState?.() ?? {}), screenOn: shell.isScreenOn(), ...(canRead && JSON.stringify(this.notificationAppCatalog()).length <= 20000 ? { notificationApps: this.notificationAppCatalog() } : {}) };
  }
  openNotificationInbox(): boolean {
    const selected = this.feature("ui.notifications"); if (!selected || this.isLocked()) return false;
    this.notificationsChanged(); if (this.hooks.showSurface?.("ui.notifications", selected.component, "inbox") !== true) return false; this.event(selected.component, "ui.notifications", { event: "notification-inbox" }); return true;
  }
  private closeMenu(): void { const menu = this.menu; this.menu = null; menu?.onClosed?.(); }
  openMenu(windowId: string, title: string, items: { label: string; enabled?: boolean; onSelect: () => void }[], onClosed?: () => void): boolean {
    const selected = this.feature("ui.app-menu");
    if (!selected || this.isLocked() || !shell.isScreenOn() || shell.foregroundWindow()?.windowId !== windowId || items.length > 64) return false;
    const entries = new Map<string, { label: string; enabled?: boolean; onSelect: () => void }>();
    for (const item of items) entries.set(newId(), item);
    this.closeMenu(); this.hooks.closeSurface?.("ui.app-menu");
    if (this.hooks.showSurface?.("ui.app-menu", selected.component, "menu") !== true) return false;
    this.menu = { component: selected.component, generation: selected.generation, windowId, items: entries, onClosed };
    this.event(selected.component, "ui.app-menu", { event: "menu", windowId, title: title.slice(0, 100), items: [...entries].map(([token, item]) => ({ token, label: item.label.slice(0, 200), enabled: item.enabled !== false })) });
    return true;
  }
  private snapshot(source: AndroidNotification, key: string): AndroidNotification {
    // Explicit copy excludes credentials and single-use foreign reply tokens. Conversation IDs are host-owned aliases.
    const external = source as AndroidNotification & { component?: string; target?: string };
    const groupKey = external.component && external.target ? JSON.stringify([external.component, external.target]) : "";
    let conversation: Record<string, unknown> = {};
    if (source.key.startsWith("apk:") && groupKey) {
      if (!this.conversationIds.has(groupKey)) { if (this.conversationIds.size >= 256) this.conversationIds.clear(); this.conversationIds.set(groupKey, newId()); }
      conversation = { component: source.packageName, target: this.conversationIds.get(groupKey) };
    }
    return { ...conversation, key, packageName: source.packageName, appName: source.appName, title: source.title, text: source.text, bigText: source.bigText, subText: source.subText, infoText: source.infoText, summaryText: source.summaryText, category: source.category, groupKey: source.groupKey, isGroupSummary: source.isGroupSummary, isForegroundService: source.isForegroundService, isOngoing: source.isOngoing, userId: source.userId, conversationId: source.conversationId, messages: source.messages, lines: source.lines, postTime: source.postTime, when: source.when, actions: source.actions.map(action => ({ index: action.index, title: action.title, enabled: action.enabled, acceptsText: action.acceptsText })) };
  }
  private notificationsChanged(arrival = ""): void {
    for (const [key, review] of this.reviews) if (!review.current()) { review.cancel(); this.reviews.delete(key); }
    const selected = this.feature("ui.notifications"); if (!selected || this.isLocked()) return;
    const sources = readActiveNotifications(50, true), leased = this.uiNotifications.update(selected.component, selected.generation, sources);
    let notifications = leased.map(({ id, source }) => this.snapshot(source, id));
    while (notifications.length && JSON.stringify(notifications).length + JSON.stringify(this.notificationAppCatalog()).length > 2000000) notifications.pop();
    const serialized = JSON.stringify({ notifications, notificationApps: this.notificationAppCatalog() });
    if (serialized !== this.lastNotificationSnapshot) {
      this.lastNotificationSnapshot = serialized;
      const snapshot = JSON.stringify({ notifications, notificationApps: this.notificationAppCatalog(), revision: ++this.notificationRevision }), snapshotId = newId(), size = 16000, total = Math.ceil(snapshot.length / size);
      for (let index = 0; index < total; index++) this.event(selected.component, "ui.notifications", { event: "notification-snapshot-fragment", snapshotId, index, total, json: snapshot.slice(index * size, (index + 1) * size) });
    }
    const item = arrival && leased.find(entry => entry.source.key === arrival);
    if (item && shouldShowNotificationOnGlasses(item.source.packageName) && !this.isProtected()) {
      const wokeScreen = !shell.isScreenOn();
      if (this.hooks.showSurface?.("ui.notifications", selected.component, item.id) !== true) return;
      this.event(selected.component, "ui.notifications", { event: "notification-arrived", key: item.id, postTime: item.source.postTime, wokeScreen });
    }
  }
  clearOwnNotifications(component: string): void { this.ownNotifications.delete(component); }
  publishOwnNotifications(component: string): void {
    if (this.isLocked() || !shell.isScreenOn() || !this.native.isExtensionGranted(component, "notification-content")) { this.clearOwnNotifications(component); return; }
    let state = this.ownNotifications.get(component);
    if (!state) { if (this.ownNotifications.size >= 8) return; state = { leases: new NotificationLeases<AndroidNotification>(newId), snapshot: "" }; this.ownNotifications.set(component, state); }
    const notifications = state.leases.update(component, this.generation, readActiveNotifications(50, true)).map(({ id, source }) => ({ ...this.snapshot(source, id), actions: [] }));
    while (notifications.length && JSON.stringify(notifications).length + JSON.stringify(this.notificationAppCatalog()).length > 2000000) notifications.pop();
    const serialized = JSON.stringify({ notifications, notificationApps: this.notificationAppCatalog() }); if (serialized === state.snapshot) return; state.snapshot = serialized;
    const snapshot = JSON.stringify({ notifications, notificationApps: this.notificationAppCatalog(), generation: this.generation, revision: ++this.notificationRevision }), snapshotId = newId(), size = 16000, total = Math.ceil(snapshot.length / size);
    for (let index = 0; index < total; index++) this.native.send(component, "own-notification-snapshot-fragment", JSON.stringify({ snapshotId, generation: this.generation, index, total, json: snapshot.slice(index * size, (index + 1) * size) }));
  }
  actOnOwnNotification(component: string, data: Record<string, unknown>): { ok: boolean; outcomes?: { key: string; postTime: number; ok: boolean }[] } {
    if (this.isLocked() || !shell.isScreenOn() || !this.native.isExtensionGranted(component, "notification-content") || !["open", "dismiss", "dismiss-group"].includes(String(data.action))) return { ok: false };
    if (data.action === "dismiss-group") return this.dismissNotificationGroup(component, this.generation, this.ownNotifications.get(component)?.leases, data.items);
    const source = this.ownNotifications.get(component)?.leases.resolve(component, this.generation, data.key, data.postTime, readActiveNotifications(50, true));
    if (!source) return { ok: false };
    if (data.action === "dismiss") return { ok: dismissNotification(source.key, source.postTime) };
    if (source.key.startsWith("apk:")) return { ok: invokeExternalNotification(source.key, 0, source.postTime) };
    shell.openNotificationModal(source.key, false); return { ok: true };
  }
  private dismissNotificationGroup(component: string, generation: number, leases: NotificationLeases<AndroidNotification> | undefined, items: unknown): { ok: boolean; outcomes?: { key: string; postTime: number; ok: boolean }[] } {
    if (!leases || !Array.isArray(items) || items.length < 1 || items.length > 50) return { ok: false };
    const current = readActiveNotifications(50, true), seen = new Set<string>(), resolved: { item: { key: string; postTime: number }; source: AndroidNotification }[] = [];
    for (const item of items) {
      if (!record(item) || typeof item.key !== "string" || typeof item.postTime !== "number" || seen.has(item.key)) return { ok: false };
      seen.add(item.key); const source = leases.resolve(component, generation, item.key, item.postTime, current);
      if (!source) return { ok: false };
      resolved.push({ item: { key: item.key, postTime: item.postTime }, source });
    }
    const outcomes = resolved.map(({ item, source }) => { let ok = false; try { ok = dismissNotification(source.key, source.postTime); } catch { /* Never retry a possibly dispatched dismiss. */ } return { ...item, ok }; });
    return { ok: outcomes.every(item => item.ok), outcomes };
  }
  private publishTools(): void {
    const selected = this.feature("device-tools"); if (!selected) return;
    const custom = ["list", "reply", "action", "dismiss"].map(kind => ({ name: `host.notifications.${kind}`, description: `${kind} current Android notifications under this app's device-tool grant. Never retry an uncertain action.`, inputSchema: { type: "object", properties: { key: { type: "string" }, postTime: { type: "integer" }, actionIndex: { type: "integer" }, text: { type: "string" } }, additionalProperties: false } }));
    const tools = [...toolRegistry.listTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), ...custom];
    this.event(selected.component, "device-tools", { event: "tool-catalog", tools });
  }
  private async action(component: string, feature: string, generation: number, action: string, data: Record<string, unknown>): Promise<void> {
    const callId = boundedToken(data.callId) ? data.callId : "";
    const result = (ok: boolean, error?: string, status?: string) => { if (this.controls(component, feature, generation)) this.event(component, feature, { event: "action-result", callId, ok, ...(error ? { error } : {}), ...(status ? { status } : {}) }); };
    if (!callId || this.isLocked()) { result(false, "Action unavailable"); return; }
    if (feature === "device-tools" && action === "tool-call") {
      if (!this.calls.admit(component, data)) { result(false, "Stale or duplicate tool call"); return; }
      const output = await this.tool(component, generation, data.name, data.arguments);
      if (this.controls(component, feature, generation)) this.event(component, feature, { event: "tool-result", callId, result: output }); return;
    }
    if (feature === "ui.notifications" && action === "notification-cancel-review") {
      const reviewKey = `${component}\n${callId}`, review = this.reviews.get(reviewKey);
      if (review) { this.reviews.delete(reviewKey); review.cancel(); } result(true); return;
    }
    if (action === "close-surface") { this.hooks.closeSurface?.(feature); result(true); return; }
    // UI presentation is not blanket authority to perform background actions.
    const gesture = this.lastGesture.get(feature) ?? 0;
    if (Date.now() - gesture > 5000 || !shell.isScreenOn()) { result(false, "A fresh feature gesture is required"); return; }
    this.lastGesture.delete(feature);
    if (action === "sleep") { shell.sleepAtAppRoot(); result(true); return; }
    if (action === "menu-select" && feature === "ui.app-menu") {
      const menu = this.menu, token = data.token;
      if (!menu || menu.component !== component || menu.generation !== generation || shell.foregroundWindow()?.windowId !== menu.windowId || typeof token !== "string") { result(false, "Menu is stale"); return; }
      const item = menu.items.get(token);
      if (!item || item.enabled === false) { result(false, "Menu item unavailable"); return; }
      this.menu = null; this.hooks.closeSurface?.(feature);
      try { item.onSelect(); result(true); } finally { menu.onClosed?.(); } return;
    }
    if (feature === "ui.notifications") {
      if (action === "notification-dismiss-group") {
        const batch = this.dismissNotificationGroup(component, generation, this.uiNotifications, data.items);
        this.event(component, feature, { event: "action-result", callId, ...batch }); this.notificationsChanged(); return;
      }
      const source = this.uiNotifications.resolve(component, generation, data.key ?? data.id, data.postTime ?? data.version, readActiveNotifications(50, true));
      if (!source) { result(false, "Notification is stale"); return; }
      if (action === "notification-dismiss") { result(dismissNotification(source.key, source.postTime)); this.notificationsChanged(); return; }
      if (action === "notification-open") {
        if (source.key.startsWith("apk:")) result(invokeExternalNotification(source.key, 0, source.postTime));
        else { this.hooks.closeSurface?.(feature, false); shell.openNotificationModal(source.key, false); result(true); }
        return;
      }
      const index = data.actionIndex;
      if (typeof index !== "number" || !Number.isSafeInteger(index)) { result(false, "Invalid notification action"); return; }
      const selected = source.actions.find(item => item.index === index && item.enabled);
      if (!selected) { result(false, "Notification action unavailable"); return; }
      if (action === "notification-action" && !selected.acceptsText) { result(source.key.startsWith("apk:") ? invokeExternalNotification(source.key, index, source.postTime) : invokeNotificationActionAtVersion(source.key, index, source.postTime)); return; }
      if (action === "notification-review-reply" && selected.acceptsText) {
        const external = source.key.startsWith("apk:") ? getExternalNotificationReply(source.key, source.postTime) : undefined;
        const current = () => this.controls(component, feature, generation) && !this.isLocked() && shell.isScreenOn() && readActiveNotifications(50, true).some(item => item.key === source.key && item.postTime === source.postTime) && (!source.key.startsWith("apk:") || !!external?.isCurrent());
        if (!current()) { result(false, "Reply unavailable"); return; }
        let sent = false, unavailable = false;
        const reviewKey = `${component}\n${callId}`;
        if (this.reviews.size) { result(false, "Another review is active"); return; }
        const restoreVisit = this.hooks.notificationReplyReturn?.();
        let completed = false;
        const complete = (status: string) => {
          if (completed) return; completed = true;
          result(status === "sent" || status === "draft-saved", undefined, status);
          if (status === "sent" && this.controls(component, feature, generation) && !this.isLocked()) {
            // A reviewed send authorizes dismissal of only the bound version.
            dismissNotification(source.key, source.postTime);
            setTimeout(() => restoreVisit?.(), 0);
          }
        };
        this.hooks.closeSurface?.(feature, false);
        const cancel = shell.openReviewedVoiceInput({ id: "extension-notification", captureTitle: "Reply", concealUnderlay: true, capturePrompt: "Speak your reply...", label: `Send reply via ${source.appName}: ${source.title}`.slice(0, 200), onSend: text => {
          if (sent || !current()) return; sent = true; this.reviews.delete(reviewKey);
          if (external) { if (!external.send(text, status => complete(status))) complete("unknown"); }
          else { const accepted = replyToNotification(source.key, index, source.postTime, text); complete(accepted ? "sent" : "unknown"); }
        } }, current, () => { unavailable = true; this.reviews.delete(reviewKey); result(false, "Reply unavailable"); }, () => {
          this.reviews.delete(reviewKey);
          setTimeout(() => { if (!sent) result(false, "Reply cancelled", "rejected"); }, 0);
        });
        if (!unavailable) this.reviews.set(reviewKey, { cancel, current }); return;
      }
      result(false, "Unsupported notification action"); return;
    }
    if (action === "sleep") { shell.sleepAtAppRoot(); result(true); return; }
    if (action === "close-surface") { this.hooks.closeSurface?.(feature); result(true); return; }
    const id = data.windowId ?? data.appId;
    if (typeof id !== "string" || id.length > 512) { result(false, "Invalid app target"); return; }
    const window = shell.getWindows().find(item => item.windowId === id);
    if (action === "uninstall-app" && feature === "ui.launcher" && this.hooks.uninstallApp && this.hooks.apps?.().some(app => app.appId === id && app.uninstallable === true)) {
      try { await this.hooks.uninstallApp(id); result(true); } catch { result(false, "Uninstall outcome unavailable"); } return;
    }
    if (action === "open-app" && this.hooks.apps?.().some(app => app.appId === id)) { this.hooks.launchApp?.(id); result(true); return; }
    if (action === "focus-app" && window) { shell.focusWindow(window.windowId); result(true); return; }
    if (action === "close-app" && window?.closeable) { shell.closeWindow(window.windowId); result(true); return; }
    if (action === "show-app-menu" && window) { shell.openSystemMenu(window.windowId); result(true); return; }
    result(false, "Action target unavailable");
  }
  private async tool(component: string, generation: number, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.controls(component, "device-tools", generation) || this.isLocked()) return { ok: false, error: "Device tools unavailable" };
    if (!name.startsWith("host.notifications.")) return toolRegistry.callTool(name, args, { proactive: false });
    const sources = readActiveNotifications(50, false); // APK message content is never sent to generic assistant tools.
    if (name === "host.notifications.list") {
      const leased = this.toolNotifications.update(component, generation, sources);
      const content = JSON.stringify(leased.map(({ id, source }) => this.snapshot(source, id)));
      return content.length <= 28000 ? { ok: true, content } : { ok: false, error: "Notification snapshot exceeds tool response limit" };
    }
    const source = this.toolNotifications.resolve(component, generation, args.key, args.postTime, sources, true);
    if (!source) return { ok: false, error: "Notification is stale" };
    let ok = false;
    if (name === "host.notifications.dismiss") ok = dismissNotification(source.key, source.postTime);
    else if (typeof args.actionIndex === "number" && Number.isSafeInteger(args.actionIndex)) {
      if (name === "host.notifications.action") ok = invokeNotificationActionAtVersion(source.key, args.actionIndex, source.postTime);
      else if (name === "host.notifications.reply" && typeof args.text === "string" && args.text.trim() && args.text.length <= 8000) ok = replyToNotification(source.key, args.actionIndex, source.postTime, args.text);
    }
    return ok ? { ok: true, content: "Completed." } : { ok: false, error: "Notification action stale or outcome unknown; do not retry" };
  }
}
