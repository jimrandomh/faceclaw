import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { GrayImage } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { ALL_NOTIFICATIONS, readActiveNotifications } from "../native/notification-icons";
import { readNotificationSources, setNotificationSourceEnabled, shouldShowNotificationOnGlasses } from "../native/notification-sources";
import { type InputEvent } from "./gestures";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";
import { drawToggleMenuItem, MenuLayer, type MenuItem } from "./menu";

function notificationFilterRows(): { items: MenuItem[]; packages: string[] } {
  readActiveNotifications(ALL_NOTIFICATIONS);
  const sources = readNotificationSources().sort((a, b) =>
    a.appName.localeCompare(b.appName) || a.packageName.localeCompare(b.packageName));
  const items: MenuItem[] = sources.map((source) => {
    const read = () => shouldShowNotificationOnGlasses(source.packageName);
    const write = (value: boolean) => setNotificationSourceEnabled(source, value);
    return {
      label: source.appName,
      description: source.packageName,
      onSelect: () => write(!read()),
      render: ({ image, x, y, width, selected }) => {
        const font = getDefaultSmallFont();
        drawToggleMenuItem(image, font, x, y, width, truncateText(font, source.appName, width - 48), read(), selected, `notification-filter:${source.packageName}`);
      },
    };
  });
  if (!items.length) items.push({ label: "No notification sources discovered yet.", disabled: true, onSelect: () => {} });
  return { items, packages: sources.map(source => source.packageName) };
}

/** Refresh rows as new sources arrive, keeping the current selection by package. */
export class NotificationFilterLayer implements Layer {
  private menu: MenuLayer | null = null;
  /** The package behind each current row, parallel to the menu's items. */
  private packages: string[] = [];

  private currentMenu(): MenuLayer {
    const { items, packages } = notificationFilterRows();
    const selectedPackage = this.menu?.selectedIndex != null ? this.packages[this.menu.selectedIndex] : undefined;
    const index = selectedPackage === undefined ? -1 : packages.indexOf(selectedPackage);
    this.packages = packages;

    if (!this.menu) {
      this.menu = new MenuLayer("Notification filter", items, { page: true, footer: "On = show popups on glasses" }).selectItem(Math.max(0, index));
    } else {
      this.menu.setItems(items, index >= 0 ? index : undefined);
    }
    return this.menu;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.currentMenu().paint(ctx, paintBelow);
  }

  hitTest(x: number, y: number, ctx: LayerContext): Promise<boolean> | boolean {
    return this.menu?.hitTest(x, y, ctx) ?? false;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.currentMenu().handleInput(event, ctx);
  }
}
