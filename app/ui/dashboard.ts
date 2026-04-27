import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage, imageFromAsciiArt } from "../graphics/image";
import { loadEmbeddedTerminus12, loadEmbeddedTerminus16 } from "../graphics/bdffont";
import { loadPngAsGrayImage } from "../graphics/imagefile";
import { type RawInputEvent } from "../native/faceclaw-communicator";
import { mediaControllerBridge } from "../native/media-controller";
import { nightscoutBridge } from "../native/nightscout";
import { readActiveNotificationIcons } from "../native/notification-icons";
import { readPhoneBatteryState } from "../native/phone-battery";
import { OsEventTypeList, EventSourceType } from "g2-kit/lite";
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
  loadSystemCardSettings,
  loadSystemCardName,
  saveDashboardSlotPlugin,
  saveNightscoutApiToken,
  saveNightscoutSiteUrl,
  saveSystemCardSetting,
  saveSystemCardName,
  type DashboardSlotId,
  type NightscoutSettings,
  type SystemCardSettingKey,
} from "./dashboard-settings";
import { Layer, LayerActions, LayerStack, type DashboardInputEvent, type LayerContext } from "./layers";
import { MenuLayer } from "./menu";

type DashboardCardId = "system" | DashboardSlotId;
export type DashboardBatteryLevels = {
  headset: number | null;
  headsetCharging: boolean | null;
  ring: number | null;
};

let dashboardState = {
  logLines: [] as string[],
  screenOn: true,
  selectedCard: "system" as DashboardCardId,
  slotConfig: loadDashboardSlotConfig(),
  systemCardName: loadSystemCardName(),
  systemCardSettings: loadSystemCardSettings(),
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
};
const dashboardFont = loadEmbeddedTerminus12();
const dashboardSystemFont = loadEmbeddedTerminus16();
const NOTIFICATION_ICON_SIZE = 24;
const SYSTEM_CARD_ITEM_HEIGHT = 38;
const SYSTEM_CARD_ITEM_GAP = 2;
const BATTERY_ITEM_Y_OFFSET = 4;
const EMPTY_BATTERY_ICON = imageFromAsciiArt(
  [
    " ##################  ",
    " #................#  ",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................###",
    " #................#  ",
    " ##################  ",
  ],
  120,
);
const BATTERY_BOLT_ICON = imageFromAsciiArt(
  [
    "....#..",
    "...##..",
    "..##...",
    ".######",
    "...##..",
    "..##...",
    "..#....",
  ],
  255,
);
const BATTERY_FILL_X = 3;
const BATTERY_FILL_Y = 2;
const BATTERY_FILL_WIDTH = 14;
const BATTERY_FILL_HEIGHT = 6;

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

function drawBattery(percentCharge: number, isCharging: boolean): GrayImage {
  const icon = new GrayImage(EMPTY_BATTERY_ICON.width, EMPTY_BATTERY_ICON.height, 0);
  icon.bitBlt(EMPTY_BATTERY_ICON, 0, 0);
  const clamped = Math.max(0, Math.min(100, percentCharge));
  const fillWidth = Math.round((BATTERY_FILL_WIDTH * clamped) / 100);
  icon.fillRect(BATTERY_FILL_X, BATTERY_FILL_Y, fillWidth, BATTERY_FILL_HEIGHT, 190);
  if (isCharging) {
    overlayImage(icon, BATTERY_BOLT_ICON, 7, 1);
  }
  return icon;
}

function overlayImage(target: GrayImage, source: GrayImage, dx: number, dy: number): void {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const value = source.pixels[y * source.width + x] ?? 0;
      if (value > 0) {
        target.setPixel(dx + x, dy + y, value);
      }
    }
  }
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
  const items = collectBatteryItems();
  if (dashboardState.systemCardSettings.showAndroidNotifications) {
    const maxNotificationIcons = Math.max(0, ((right - left) / Math.max(1, NOTIFICATION_ICON_SIZE + SYSTEM_CARD_ITEM_GAP)) | 0) * 2;
    for (const icon of readActiveNotificationIcons(maxNotificationIcons)) {
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
  return Math.max(EMPTY_BATTERY_ICON.width, dashboardFont.measureText(item.label));
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
    this.drawCardBorder(image, systemBounds, dashboardState.selectedCard === "system");
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
      if (!isBlankDashboardPlugin(pluginId)) {
        this.drawCardBorder(image, bounds, dashboardState.selectedCard === slot);
      }
      getDashboardPlugin(pluginId).renderCard({
        image,
        bounds,
        selected: dashboardState.selectedCard === slot,
        font: dashboardFont,
        state: pluginState,
      });
    }

    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (!dashboardState.screenOn) {
      if (event.type === "double-click") {
        dashboardState.selectedCard = "system";
        dashboardState.screenOn = true;
      }
      return;
    }

    if (event.type === "scroll-up") {
      cycleSelection(-1);
      return;
    }

    if (event.type === "scroll-down") {
      cycleSelection(1);
      return;
    }

    if (event.type === "click") {
      if (dashboardState.selectedCard === "system") {
        ctx.stack.push(createRootMenuLayer());
      } else {
        const pluginId = dashboardState.slotConfig[dashboardState.selectedCard];
        if (pluginId === "nightscout" && !isNightscoutSettingsConfigured(dashboardState.nightscoutSettings)) {
          ctx.stack.push(createNightscoutSettingsMenuLayer());
          return;
        }
        const layer = getDashboardPlugin(pluginId).createFullscreenLayer?.(
          getPluginState,
        );
        if (layer) {
          ctx.stack.push(layer);
        }
      }
      return;
    }

    if (event.type === "double-click") {
      dashboardState.selectedCard = "system";
      dashboardState.screenOn = false;
    }
  }

  private drawCardBorder(image: GrayImage, bounds: DashboardPluginCardBounds, selected: boolean): void {
    if (selected) {
      image.drawRect(bounds.x, bounds.y, bounds.width, bounds.height, 60);
    }
  }
}

function createRootMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Menu",
    [
      {
        label: "About",
        onSelect: (ctx) => {
          ctx.stack.push(new AboutLayer());
        },
      },
      {
        label: "Settings",
        onSelect: (ctx) => {
          ctx.stack.push(createSettingsMenuLayer());
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
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
  );
}

function createSettingsMenuLayer(): MenuLayer {
  return new MenuLayer(
    "Settings",
    [
      {
        label: "Dashboard",
        onSelect: (ctx) => {
          ctx.stack.push(createDashboardSettingsMenuLayer());
        },
      },
      {
        label: "Integrations",
        onSelect: (ctx) => {
          ctx.stack.push(createIntegrationsMenuLayer());
        },
      },
    ],
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
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
          image.drawText(dashboardFont, x, y + 4, `${slotMenuLabel(slot)}: ${pluginLabelForSlot(slot)}`, 200);
        },
      })),
    ],
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
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
          image.drawText(dashboardFont, x, y + 4, `Name: ${getDisplayedSystemCardName()}`, 200);
        },
      },
      createSystemCardToggleItem("Show Faceclaw Logo", "showFaceclawLogo"),
      createSystemCardToggleItem("Show Battery Indicators", "showBatteryIndicators"),
      createSystemCardToggleItem("Show Android Notifications", "showAndroidNotifications"),
    ],
    {
      x: 308,
      y: 24,
      width: 252,
      height: 180,
    },
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
      drawToggleMenuItem(image, x, y, width, label, dashboardState.systemCardSettings[key], selected);
    },
  };
}

function drawToggleMenuItem(image: GrayImage, x: number, y: number, width: number, label: string, enabled: boolean, selected: boolean): void {
  const switchWidth = 34;
  const switchHeight = 16;
  const switchX = x + width - switchWidth - 2;
  const switchY = y + 2;
  image.drawText(dashboardFont, x, y + 4, label, 200);
  const offFill = selected ? 0 : 18;
  image.fillRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 70 : offFill, 8);
  image.drawRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 130 : 55, 8);
  const knobSize = 12;
  const knobX = enabled ? switchX + switchWidth - knobSize - 2 : switchX + 2;
  image.fillRoundedRect(knobX, switchY + 2, knobSize, knobSize, enabled ? 230 : selected ? 170 : 90, 6);
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
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
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
          image.drawText(dashboardFont, x, y + 4, `URL: ${truncateSetting(dashboardState.nightscoutSettings.siteUrl)}`, 200);
        },
      },
      {
        label: "API token",
        onSelect: (ctx) => {
          void ctx.actions.startNightscoutApiTokenEdit();
          ctx.stack.push(new EditTextSettingLayer("Edit API token", () => maskToken(dashboardState.nightscoutSettings.apiToken)));
        },
        render: ({ image, x, y }) => {
          image.drawText(dashboardFont, x, y + 4, `Token: ${maskToken(dashboardState.nightscoutSettings.apiToken)}`, 200);
        },
      },
    ],
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
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
        if (dashboardState.selectedCard === slot && isBlankDashboardPlugin(plugin.id)) {
          dashboardState.selectedCard = "system";
        }
        ctx.stack.pop();
      },
      render: ({ image, x, y }) => {
        const selected = dashboardState.slotConfig[slot] === plugin.id ? " *" : "";
        image.drawText(dashboardFont, x, y + 4, `${plugin.label}${selected}`, 200);
      },
    })),
    {
      x: 16,
      y: 24,
      width: 252,
      height: 180,
    },
  );
}

class AboutLayer implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const logo = getDashboardLogo();
    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(dashboardFont, 22, 16, "About Faceclaw", 220);
    if (logo) {
      image.bitBlt(logo, 22, 42);
    }
    image.drawText(dashboardFont, 108, 48, "Faceclaw", 220);
    image.drawText(dashboardFont, 108, 64, "Dashboard prototype", 180);

    const aboutLines = [
      "A lobster on top of a smiley face.",
      "Perching on the faces of giants.",
      "",
      "System card opens menus.",
      "Swipe cycles dashboard cards.",
      "Plugin cards open fullscreen views.",
    ];
    for (let index = 0; index < aboutLines.length; index++) {
      image.drawText(dashboardFont, 22, 128 + index * 14, aboutLines[index]!, 180);
    }
    image.drawText(dashboardFont, 22, 252, "Double-click to go back", 110);
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
      return { x: 0, y: 0, width: G2_LENS_WIDTH / 2 - 2, height: G2_LENS_HEIGHT / 2 - 2 };
    case "top-right":
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

function cycleSelection(direction: -1 | 1): void {
  const order: DashboardCardId[] = [
    "system",
    ...getDashboardSlotIds().filter((slot) => !isBlankDashboardPlugin(dashboardState.slotConfig[slot])),
  ];
  const index = order.indexOf(dashboardState.selectedCard);
  const currentIndex = index >= 0 ? index : 0;
  dashboardState.selectedCard = order[(currentIndex + direction + order.length) % order.length]!;
}

function slotMenuLabel(slot: DashboardSlotId): string {
  switch (slot) {
    case "top-right":
      return "Top-right slot";
    case "bottom-left":
      return "Bottom-left slot";
    case "bottom-right":
      return "Bottom-right slot";
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

