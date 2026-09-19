import { getDefaultSmallFont } from "../graphics/ui-fonts";
import { GrayImage } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { ALL_NOTIFICATIONS, readActiveNotifications } from "../native/notification-icons";
import { readNotificationSources, setNotificationSourceEnabled, shouldShowNotificationOnGlasses } from "../native/notification-sources";
import { type InputEvent } from "./gestures";
import { type Layer, type LayerContext, type PaintBelow } from "./layers";
import { drawToggleMenuItem, MenuLayer, type MenuItem } from "./menu";

/** Rebuild rows when new sources arrive, keeping the current selection by package. */
export class NotificationFilterLayer implements Layer {
  private menu: MenuLayer | null = null;
  private packages = "";
  private selectedPackage = "";

  private currentMenu(ctx: LayerContext): MenuLayer {
    readActiveNotifications(ALL_NOTIFICATIONS);
    const sources = readNotificationSources().sort((a, b) =>
      a.appName.localeCompare(b.appName) || a.packageName.localeCompare(b.packageName));
    const signature = JSON.stringify([ctx.stack.getBaseSize().width, sources.map((source) => [source.packageName, source.appName])]);
    if (!this.menu || signature !== this.packages) {
      this.packages = signature;
      const items: MenuItem[] = sources.map((source) => ({
        label: source.appName,
        onSelect: () => setNotificationSourceEnabled(source, !shouldShowNotificationOnGlasses(source.packageName)),
        render: ({ image, x, y, width, selected }) => {
          if (selected) this.selectedPackage = source.packageName;
          const font = getDefaultSmallFont();
          drawToggleMenuItem(image, font, x, y, width, truncateText(font, source.appName, width - 48),
            shouldShowNotificationOnGlasses(source.packageName), selected);
        },
      }));
      if (!items.length) items.push({ label: "No notification sources discovered yet.", disabled: true, onSelect: () => {} });
      this.menu = new MenuLayer("Notification filter", items, {
        x: 8, y: 8, width: ctx.stack.getBaseSize().width - 16,
        opaque: true, showBorder: false,
        footer: "On = show popups on glasses",
      }).selectItem(Math.max(0, sources.findIndex((source) => source.packageName === this.selectedPackage)));
    }
    return this.menu;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.currentMenu(ctx).paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.currentMenu(ctx).handleInput(event, ctx);
  }
}
