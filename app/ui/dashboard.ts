import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { loadEmbeddedTerminus12, loadEmbeddedTerminus16 } from "../graphics/bdffont";
import { BATTERY_ICON_WIDTH, drawBattery } from "../graphics/battery";
import { loadPngAsGrayImage } from "../graphics/imagefile";
import { type RawInputEvent } from "../native/faceclaw-communicator";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout";
import { readActiveNotificationIcons } from "../native/notification-icons";
import { readPhoneBatteryState } from "../native/phone-battery";
import { readSystemStatusIcons } from "../native/system-status-icons";
import { EventSourceType, OsEventTypeList } from "../g2/events";
import {
  getDashboardPlugin,
  isBlankDashboardPlugin,
  listDashboardPlugins,
  type DashboardPluginCardBounds,
  type DashboardPluginState,
} from "./dashboard-plugins";
import {
  DEFAULT_SYSTEM_CARD_NAME,
  getDashboardSlotIds,
  isNightscoutSettingsConfigured,
  loadDashboardSlotConfig,
  loadNightscoutSettings,
  loadScreenTimeoutSetting,
  loadSystemCardSettings,
  loadSystemCardName,
  loadVoiceControlEnabled,
  loadWakeModeSetting,
  nextScreenTimeoutSetting,
  nextWakeModeSetting,
  saveDashboardSlotPlugin,
  saveNightscoutApiToken,
  saveNightscoutSiteUrl,
  saveScreenTimeoutSetting,
  saveWakeModeSetting,
  screenTimeoutLabel,
  screenTimeoutMs,
  saveSystemCardSetting,
  saveSystemCardName,
  saveVoiceControlEnabled,
  wakeModeLabel,
  type DashboardSlotId,
  type NightscoutSettings,
  type ScreenTimeoutSetting,
  type SystemCardSettingKey,
  type WakeModeSetting,
} from "./dashboard-settings";
import { Layer, LayerActions, LayerStack, type DashboardInputEvent, type LayerContext } from "./layers";
import { drawRightValueMenuItem, drawToggleMenuItem, MenuLayer } from "./menu";

type DashboardCardId = "system" | DashboardSlotId;
export type DashboardBatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  ring: number | null;
};

let dashboardState = {
  logLines: [] as string[],
  screenOn: true,
  lastInputAtMs: Date.now(),
  slotConfig: loadDashboardSlotConfig(),
  systemCardName: loadSystemCardName(),
  systemCardSettings: loadSystemCardSettings(),
  screenTimeout: loadScreenTimeoutSetting(),
  wakeMode: loadWakeModeSetting(),
  voiceControlEnabled: loadVoiceControlEnabled(),
  tiledWakePaintPending: false,
  nightscoutSettings: loadNightscoutSettings(),
  battery: {
    headset: null,
    headsetCharging: null,
    ring: null,
  } as DashboardBatteryLevels,
};

let cachedDashboardLogo: GrayImage | null | undefined;
const dashboardActions: LayerActions = {
  disconnect: () => {},
  startSystemNameEdit: () => {},
  endSystemNameEdit: () => {},
  startNightscoutSiteUrlEdit: () => {},
  startNightscoutApiTokenEdit: () => {},
  endTextSettingEdit: () => {},
  setVoiceControlEnabled: () => {},
};
const dashboardFont = loadEmbeddedTerminus12();
const dashboardSystemFont = loadEmbeddedTerminus16();
const NOTIFICATION_ICON_SIZE = 24;
const SYSTEM_CARD_ITEM_HEIGHT = 38;
const SYSTEM_CARD_ITEM_GAP = 2;
const BATTERY_ITEM_Y_OFFSET = 4;
const TOP_LEFT_MENU_LAYOUT = { x: 8, y: 8, width: 272, height: 128 };
const TOP_RIGHT_MENU_LAYOUT = { x: 296, y: 8, width: 272, height: 128 };

function rawInputEventToInputEvent(event: RawInputEvent): DashboardInputEvent {
  if (event.kind === "sys-event") {
    if (event.eventType === OsEventTypeList.CLICK_EVENT) {
      return {
        type: "click",
        source: eventSourceToString(event.eventSource),
      };
    } else if (event.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return {
        type: "double-click",
        source: eventSourceToString(event.eventSource),
      };
    }
  } else if (event.kind === "text-click") {
    if (event.eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { type: "scroll-down" };
    } else if (event.eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { type: "scroll-up" };
    }
  }
  return {
    type: "unknown",
    kind: event.kind,
    eventSource: event.eventSource,
    eventType: event.eventType,
  };
}

function eventSourceToString(eventSource: number): "ring" | "left-arm" | "right-arm" {
  if (eventSource === EventSourceType.TOUCH_EVENT_FROM_RING) {
    return "ring";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L) {
    return "left-arm";
  } else if (eventSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R) {
    return "right-arm";
  }
  return "ring";
}

export async function receiveInput(event: RawInputEvent): Promise<void> {
  const inputEvent = rawInputEventToInputEvent(event);
  dashboardState.lastInputAtMs = Date.now();
  dashboardState.logLines.push(eventToString(inputEvent));
  await dashboardLayers.handleInput(inputEvent);
}

function eventToString(event: DashboardInputEvent): string {
  switch (event.type) {
    case "click":
      return `Click from ${event.source}`;
    case "double-click":
      return `Double click from ${event.source}`;
    case "scroll-up":
      return `Scroll up`;
    case "scroll-down":
      return `Scroll down`;
    default:
    case "unknown":
      return `Unknown event: ${event.kind} ${event.eventSource} ${event.eventType}`;
  }
}

export function logToDashboard(message: string): void {
  dashboardState.logLines.push(message);
}

export function setDashboardActions(actions: Partial<LayerActions>): void {
  dashboardLayers.setActions(actions);
}

export function drawDashboard(): GrayImage {
  return dashboardLayers.paint();
}

export function consumeDashboardTiledWakePaint(): boolean {
  const value = dashboardState.tiledWakePaintPending;
  dashboardState.tiledWakePaintPending = false;
  return value;
}

export function setDashboardSystemCardName(name: string): string {
  const savedName = saveSystemCardName(name);
  dashboardState.systemCardName = savedName;
  return savedName;
}

export function getDashboardSystemCardName(): string {
  return dashboardState.systemCardName;
}

export function setDashboardNightscoutSiteUrl(siteUrl: string): string {
  const savedUrl = saveNightscoutSiteUrl(siteUrl);
  dashboardState.nightscoutSettings = {
    ...dashboardState.nightscoutSettings,
    siteUrl: savedUrl,
  };
  return savedUrl;
}

export function setDashboardNightscoutApiToken(apiToken: string): string {
  const savedToken = saveNightscoutApiToken(apiToken);
  dashboardState.nightscoutSettings = {
    ...dashboardState.nightscoutSettings,
    apiToken: savedToken,
  };
  return savedToken;
}

export function getDashboardNightscoutSettings(): NightscoutSettings {
  return { ...dashboardState.nightscoutSettings };
}

export function setDashboardSystemCardSetting(key: SystemCardSettingKey, value: boolean): void {
  dashboardState.systemCardSettings = {
    ...dashboardState.systemCardSettings,
    [key]: value,
  };
  saveSystemCardSetting(key, value);
}

export function isDashboardVoiceControlEnabled(): boolean {
  return dashboardState.voiceControlEnabled;
}

export function setDashboardVoiceControlEnabled(value: boolean): void {
  dashboardState.voiceControlEnabled = saveVoiceControlEnabled(value);
}

export function applyDashboardScreenTimeout(nowMs = Date.now()): boolean {
  const timeoutMs = screenTimeoutMs(dashboardState.screenTimeout);
  if (timeoutMs === null || !dashboardState.screenOn) return false;
  if (nowMs - dashboardState.lastInputAtMs < timeoutMs) return false;
  dashboardState.screenOn = false;
  dashboardLayers.clearToBase();
  return true;
}

export function resetDashboardSleepTimerAndWake(nowMs = Date.now()): boolean {
  dashboardState.lastInputAtMs = nowMs;
  if (dashboardState.screenOn) return false;

  dashboardState.screenOn = true;
  dashboardState.tiledWakePaintPending = dashboardState.wakeMode === "tiled";
  dashboardLayers.clearToBase();
  dashboardLayers.push(createRootMenuLayer());
  return true;
}

export function setDashboardBatteryLevels(levels: Partial<DashboardBatteryLevels>): void {
  dashboardState.battery = {
    ...dashboardState.battery,
    ...levels,
  };
}

function getDisplayedSystemCardName(): string {
  return dashboardState.systemCardName || DEFAULT_SYSTEM_CARD_NAME;
}

type SystemCardFlowItem =
  | { type: "battery"; label: string; percentCharge: number; isCharging: boolean }
  | { type: "notification"; icon: GrayImage };

function collectBatteryItems(): SystemCardFlowItem[] {
  if (!dashboardState.systemCardSettings.showBatteryIndicators) return [];
  const phone = readPhoneBatteryState();
  const items: SystemCardFlowItem[] = [];
  addBatteryItem(items, "Phone", phone.battery, phone.charging);
  addBatteryItem(items, "G2", dashboardState.battery.headset, dashboardState.battery.headsetCharging);
  addBatteryItem(items, "R1", dashboardState.battery.ring, null);
  return items;
}

function addBatteryItem(
  items: SystemCardFlowItem[],
  label: string,
  percentCharge: number | null,
  isCharging: boolean | null,
): void {
  if (percentCharge === null || !Number.isFinite(percentCharge)) return;
  items.push({
    type: "battery",
    label,
    percentCharge,
    isCharging: Boolean(isCharging),
  });
}

function drawBatteryFlowItem(image: GrayImage, x: number, y: number, item: Extract<SystemCardFlowItem, { type: "battery" }>): void {
  const itemWidth = systemCardFlowItemWidth(item);
  const labelX = x + Math.max(0, ((itemWidth - dashboardFont.measureText(item.label)) / 2) | 0);
  image.drawText(dashboardFont, labelX, y + BATTERY_ITEM_Y_OFFSET, item.label, 150);
  const battery = drawBattery(item.percentCharge, item.isCharging);
  image.bitBlt(battery, x + ((itemWidth - battery.width) / 2) | 0, y + 16 + BATTERY_ITEM_Y_OFFSET);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDashboardDate(now: Date): string {
  return `${WEEKDAYS[now.getDay()]} ${MONTHS[now.getMonth()]} ${now.getDate()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function getDashboardLogo(): GrayImage | null {
  if (cachedDashboardLogo !== undefined) {
    return cachedDashboardLogo;
  }
  try {
    cachedDashboardLogo = loadPngAsGrayImage("images/faceclaw-logo-dashboard.png");
  } catch {
    cachedDashboardLogo = null;
  }
  return cachedDashboardLogo;
}

function drawSystemCardFlowItems(image: GrayImage, bounds: DashboardPluginCardBounds): void {
  const left = bounds.x + 10;
  const top = bounds.y + 84;
  const right = bounds.x + bounds.width - 10;
  const bottom = bounds.y + bounds.height - 6;
  const items: SystemCardFlowItem[] = [];
  if (dashboardState.systemCardSettings.showAndroidNotifications) {
    const maxNotificationIcons = Math.max(0, ((right - left) / Math.max(1, NOTIFICATION_ICON_SIZE + SYSTEM_CARD_ITEM_GAP)) | 0) * 2;
    for (const icon of readActiveNotificationIcons(maxNotificationIcons)) {
      items.push({ type: "notification", icon });
    }
  }
  items.push(...collectBatteryItems());
  if (dashboardState.systemCardSettings.showSignalStrength) {
    for (const icon of readSystemStatusIcons()) {
      items.push({ type: "notification", icon });
    }
  }

  let itemX = left;
  let itemY = top;
  for (const item of items) {
    const itemWidth = systemCardFlowItemWidth(item);
    if (itemX > left && itemX + itemWidth > right) {
      itemX = left;
      itemY += SYSTEM_CARD_ITEM_HEIGHT + SYSTEM_CARD_ITEM_GAP;
    }
    if (itemY + SYSTEM_CARD_ITEM_HEIGHT > bottom) {
      break;
    }
    if (item.type === "battery") {
      drawBatteryFlowItem(image, itemX, itemY, item);
    } else {
      image.bitBlt(
        item.icon,
        itemX,
        itemY + ((SYSTEM_CARD_ITEM_HEIGHT - NOTIFICATION_ICON_SIZE) / 2) | 0,
      );
    }
    itemX += itemWidth + SYSTEM_CARD_ITEM_GAP;
  }
}

function systemCardFlowItemWidth(item: SystemCardFlowItem): number {
  if (item.type === "notification") {
    return NOTIFICATION_ICON_SIZE;
  }
  return Math.max(BATTERY_ICON_WIDTH, dashboardFont.measureText(item.label));
}

class DashboardLayer implements Layer {
  paint(): GrayImage {
    if (!dashboardState.screenOn) {
      return new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    }

    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const now = new Date();
    const logo = getDashboardLogo();
    const pluginState = getPluginState();

    const systemBounds = getCardBounds("system");
    if (logo && dashboardState.systemCardSettings.showFaceclawLogo) {
      image.bitBlt(logo, systemBounds.x + 10, systemBounds.y + 10);
    }
    const infoX = logo && dashboardState.systemCardSettings.showFaceclawLogo ? systemBounds.x + 92 : systemBounds.x + 10;
    image.drawText(dashboardSystemFont, infoX, systemBounds.y + 10, getDisplayedSystemCardName(), 200);
    image.drawText(dashboardSystemFont, infoX, systemBounds.y + 32, formatDashboardDate(now), 200);
    drawSystemCardFlowItems(image, systemBounds);

    for (const slot of getDashboardSlotIds()) {
      const bounds = getCardBounds(slot);
      const pluginId = dashboardState.slotConfig[slot];
      getDashboardPlugin(pluginId).renderCard({
        image,
        bounds,
        selected: false,
        font: dashboardFont,
        state: pluginState,
      });
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (!dashboardState.screenOn) {
      if (event.type === "double-click") {
        dashboardState.screenOn = true;
        dashboardState.tiledWakePaintPending = dashboardState.wakeMode === "tiled";
        ctx.stack.push(createRootMenuLayer());
      }
      return;
    }

    if (event.type === "click") {
      ctx.stack.push(createRootMenuLayer());
      return;
    }

    if (event.type === "double-click") {
      dashboardState.screenOn = false;
    }
  }
}

class RootMenuLayer extends MenuLayer {
  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      dashboardState.screenOn = false;
      ctx.stack.clearToBase();
      return;
    }
    await super.handleInput(event, ctx);
  }
}

function createRootMenuLayer(): MenuLayer {
  return new RootMenuLayer(
    "Menu",
    [
      /*{
        label: "Apps",
        onSelect: (ctx) => {
          ctx.stack.push(createAppsMenuLayer());
        },
      },*/
      {
        label: "Settings",
        onSelect: (ctx) => {
          ctx.stack.push(createSettingsMenuLayer());
        },
      },
      ...getDashboardSlotIds().map((slot) => ({
        label: pluginLabelForSlot(slot),
        onSelect: (ctx: LayerContext) => {
          openDashboardSlot(slot, ctx);
        },
        render: ({ image, x, y }: { image: GrayImage; x: number; y: number }) => {
          image.drawText(dashboardFont, x, y + 3, pluginLabelForSlot(slot), 200);
        },
      })),
      {
        label: "System",
        onSelect: (ctx) => {
          ctx.stack.push(createSystemMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createAppsMenuLayer(): MenuLayer {
  return new MenuLayer("Apps", [], TOP_LEFT_MENU_LAYOUT);
}

function createSystemMenuLayer(): MenuLayer {
  return new MenuLayer(
    "System",
    [
      {
        label: "About",
        onSelect: (ctx) => {
          ctx.stack.push(new AboutLayer());
        },
      },
      {
        label: "Quit / Disconnect",
        onSelect: async (ctx) => {
          ctx.stack.clearToBase();
          await ctx.actions.disconnect();
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function openDashboardSlot(slot: DashboardSlotId, ctx: LayerContext): void {
  const pluginId = dashboardState.slotConfig[slot];
  if (isBlankDashboardPlugin(pluginId)) {
    return;
  }
  if (pluginId === "nightscout" && !isNightscoutSettingsConfigured(dashboardState.nightscoutSettings)) {
    ctx.stack.push(createNightscoutSettingsMenuLayer());
    return;
  }
  const layer = getDashboardPlugin(pluginId).createFullscreenLayer?.(getPluginState);
  if (layer) {
    ctx.stack.push(layer);
  }
}

function createSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings",
    [
      {
        label: "Display",
        onSelect: (ctx) => {
          ctx.stack.push(createDisplaySettingsMenuLayer());
        },
      },
      {
        label: "Dashboard",
        onSelect: (ctx) => {
          ctx.stack.push(createDashboardSettingsMenuLayer());
        },
      },
      {
        label: "Voice",
        onSelect: (ctx) => {
          ctx.stack.push(createVoiceSettingsMenuLayer());
        },
      },
      {
        label: "Integrations",
        onSelect: (ctx) => {
          ctx.stack.push(createIntegrationsMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createDisplaySettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Display",
    [
      {
        label: "Screen timeout",
        onSelect: () => {
          setScreenTimeout(nextScreenTimeoutSetting(dashboardState.screenTimeout));
        },
        render: ({ image, x, y, width }) => {
          drawRightValueMenuItem(image, dashboardFont, x, y, width, "Screen timeout", screenTimeoutLabel(dashboardState.screenTimeout));
        },
      },
      {
        label: "Wake mode",
        onSelect: () => {
          setWakeMode(nextWakeModeSetting(dashboardState.wakeMode));
        },
        render: ({ image, x, y, width }) => {
          drawRightValueMenuItem(image, dashboardFont, x, y, width, "Wake mode", wakeModeLabel(dashboardState.wakeMode));
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function setScreenTimeout(value: ScreenTimeoutSetting): void {
  dashboardState.screenTimeout = saveScreenTimeoutSetting(value);
  dashboardState.lastInputAtMs = Date.now();
}

function setWakeMode(value: WakeModeSetting): void {
  dashboardState.wakeMode = saveWakeModeSetting(value);
}

function createVoiceSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Voice",
    [
      {
        label: "Enable",
        onSelect: async (ctx) => {
          await ctx.actions.setVoiceControlEnabled(!dashboardState.voiceControlEnabled);
        },
        render: ({ image, x, y, width, selected }) => {
          drawToggleMenuItem(image, dashboardFont, x, y, width, "Enable", dashboardState.voiceControlEnabled, selected);
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createDashboardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Dashboard",
    [
      {
        label: "System Card",
        onSelect: (ctx) => {
          ctx.stack.push(createSystemCardSettingsMenuLayer());
        },
      },
      ...getDashboardSlotIds().map((slot) => ({
        label: slotMenuLabel(slot),
        onSelect: (ctx) => {
          ctx.stack.push(createSlotPickerMenu(slot));
        },
        render: ({ image, x, y }) => {
          image.drawText(dashboardFont, x, y + 3, `${slotMenuLabel(slot)}: ${pluginLabelForSlot(slot)}`, 200);
        },
      })),
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createSystemCardSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "System Card",
    [
      {
        label: "Name",
        onSelect: (ctx) => {
          void ctx.actions.startSystemNameEdit();
          ctx.stack.push(new EditSystemNameLayer());
        },
        render: ({ image, x, y }) => {
          image.drawText(dashboardFont, x, y + 3, `Name: ${getDisplayedSystemCardName()}`, 200);
        },
      },
      createSystemCardToggleItem("Show Faceclaw Logo", "showFaceclawLogo"),
      createSystemCardToggleItem("Show Battery Indicators", "showBatteryIndicators"),
      createSystemCardToggleItem("Show Android Notifications", "showAndroidNotifications"),
      createSystemCardToggleItem("Show Signal Strength", "showSignalStrength"),
    ],
    TOP_RIGHT_MENU_LAYOUT,
    true,
  );
}

function createSystemCardToggleItem(label: string, key: SystemCardSettingKey) {
  return {
    label,
    onSelect: () => {
      setDashboardSystemCardSetting(key, !dashboardState.systemCardSettings[key]);
    },
    render: ({ image, x, y, width, selected }: { image: GrayImage; x: number; y: number; width: number; selected: boolean }) => {
      drawToggleMenuItem(image, dashboardFont, x, y, width, label, dashboardState.systemCardSettings[key], selected);
    },
  };
}

function createIntegrationsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Integrations",
    [
      {
        label: "Nightscout",
        onSelect: (ctx) => {
          ctx.stack.push(createNightscoutSettingsMenuLayer());
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

function createNightscoutSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Nightscout",
    [
      {
        label: "Site URL",
        onSelect: (ctx) => {
          void ctx.actions.startNightscoutSiteUrlEdit();
          ctx.stack.push(new EditTextSettingLayer("Edit Nightscout URL", () => dashboardState.nightscoutSettings.siteUrl || "(empty)"));
        },
        render: ({ image, x, y }) => {
          image.drawText(dashboardFont, x, y + 3, `URL: ${truncateSetting(dashboardState.nightscoutSettings.siteUrl)}`, 200);
        },
      },
      {
        label: "API token",
        onSelect: (ctx) => {
          void ctx.actions.startNightscoutApiTokenEdit();
          ctx.stack.push(new EditTextSettingLayer("Edit API token", () => maskToken(dashboardState.nightscoutSettings.apiToken)));
        },
        render: ({ image, x, y }) => {
          image.drawText(dashboardFont, x, y + 3, `Token: ${maskToken(dashboardState.nightscoutSettings.apiToken)}`, 200);
        },
      },
    ],
    TOP_LEFT_MENU_LAYOUT,
  );
}

class EditSystemNameLayer implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(dashboardFont, 22, 16, "Edit dashboard name", 220);
    image.drawText(dashboardFont, 22, 52, "Look at the phone app", 200);
    image.drawText(dashboardFont, 22, 70, "to type a new name.", 200);
    image.drawText(dashboardSystemFont, 22, 110, getDisplayedSystemCardName(), 220);
    image.drawText(dashboardFont, 22, 252, "Double-click to go back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.endSystemNameEdit();
      void ctx.actions.endTextSettingEdit();
      ctx.stack.pop();
    }
  }
}

class EditTextSettingLayer implements Layer {
  constructor(
    private readonly title: string,
    private readonly value: () => string,
  ) {}

  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(dashboardFont, 22, 16, this.title, 220);
    image.drawText(dashboardFont, 22, 52, "Look at the phone app", 200);
    image.drawText(dashboardFont, 22, 70, "to type a value.", 200);
    image.drawText(dashboardFont, 22, 110, truncateSetting(this.value(), 52), 220);
    image.drawText(dashboardFont, 22, 252, "Double-click to go back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      void ctx.actions.endTextSettingEdit();
      ctx.stack.pop();
    }
  }
}

function createSlotPickerMenu(slot: DashboardSlotId): MenuLayer {
  return new MenuLayer(
    slotMenuLabel(slot),
    listDashboardPlugins().map((plugin) => ({
      label: plugin.label,
      onSelect: (ctx) => {
        dashboardState.slotConfig[slot] = plugin.id;
        saveDashboardSlotPlugin(slot, plugin.id);
        ctx.stack.pop();
      },
      render: ({ image, x, y }) => {
        const selected = dashboardState.slotConfig[slot] === plugin.id ? " *" : "";
        image.drawText(dashboardFont, x, y + 3, `${plugin.label}${selected}`, 200);
      },
    })),
    TOP_LEFT_MENU_LAYOUT,
  );
}

class AboutLayer implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const logo = getDashboardLogo();
    image.drawText(dashboardFont, 22, 16, "About Faceclaw", 220);
    if (logo) {
      image.bitBlt(logo, 22, 42);
    }
    image.drawText(dashboardFont, 108, 48, "Faceclaw", 220);
    image.drawText(dashboardFont, 108, 64, "Dashboard prototype", 180);

    const aboutLines = [
      "By James Babcock. Distributed under the GNU General Public License, version 3.",
      "Version 0.1.0. Too much of an early janky development prototype to have",
      "proper numbered releases."
    ];
    for (let index = 0; index < aboutLines.length; index++) {
      image.drawText(dashboardFont, 22, 128 + index * 14, aboutLines[index]!, 180);
    }
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}

function getPluginState(): DashboardPluginState {
  return {
    logLines: dashboardState.logLines,
    media: mediaControllerBridge.snapshot(),
    nightscout: nightscoutBridge.snapshot(),
    nightscoutConfigured: isNightscoutSettingsConfigured(dashboardState.nightscoutSettings),
  };
}

function getCardBounds(card: DashboardCardId): DashboardPluginCardBounds {
  switch (card) {
    case "system":
      return {
        x: G2_LENS_WIDTH / 2 + 2,
        y: 0,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
    case "bottom-left":
      return {
        x: 0,
        y: G2_LENS_HEIGHT / 2 + 2,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
    case "bottom-right":
      return {
        x: G2_LENS_WIDTH / 2 + 2,
        y: G2_LENS_HEIGHT / 2 + 2,
        width: G2_LENS_WIDTH / 2 - 2,
        height: G2_LENS_HEIGHT / 2 - 2,
      };
  }
}

function slotMenuLabel(slot: DashboardSlotId): string {
  switch (slot) {
    case "bottom-left":
      return "Bottom-left";
    case "bottom-right":
      return "Bottom-right";
  }
}

function pluginLabelForSlot(slot: DashboardSlotId): string {
  return getDashboardPlugin(dashboardState.slotConfig[slot]).label;
}

function truncateSetting(value: string, maxLength = 22): string {
  const text = value || "(empty)";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function maskToken(token: string): string {
  if (!token) return "(empty)";
  return token.length <= 6 ? "******" : `${token.slice(0, 2)}...${token.slice(-4)}`;
}

const dashboardLayers = new LayerStack(new DashboardLayer(), dashboardFont, dashboardActions);
dashboardLayers.push(createRootMenuLayer());

