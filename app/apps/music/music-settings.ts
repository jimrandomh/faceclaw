import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { mediaBrowserBridge } from "../../native/media-browser";
import { isMediaAppEnabled, readMediaApps, setMediaAppEnabled } from "../../native/media-apps";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawToggleMenuItem, MenuLayer, type MenuItem } from "../../ui/menu";

/** Discovered apps stay visible even when ignored or no longer publishing a session. */
export class MusicSettingsLayer implements Layer {
  private menu: MenuLayer | null = null;
  private menuWidth = 0;
  /** The package behind each current row, parallel to the menu's items. */
  private packages: string[] = [];

  constructor() {
    // Refresh installed browser services, remembering ignored services too.
    mediaBrowserBridge.listBrowsableApps(true);
  }

  /** Refresh the rows from the remembered apps, keeping the selection on the same package. */
  private currentMenu(ctx: LayerContext): MenuLayer {
    const apps = readMediaApps().sort((a, b) =>
      a.appName.localeCompare(b.appName) || a.packageName.localeCompare(b.packageName));
    const items: MenuItem[] = apps.map((app) => ({
      label: app.appName,
      onSelect: () => setMediaAppEnabled(app, !isMediaAppEnabled(app.packageName)),
      render: ({ image, x, y, width, selected }) => {
        const font = getDefaultSmallFont();
        const duplicateName = apps.some((other) => other !== app && other.appName === app.appName);
        const label = duplicateName ? `${app.appName} (${app.packageName})` : app.appName;
        drawToggleMenuItem(image, font, x, y, width, truncateText(font, label, width - 48),
          isMediaAppEnabled(app.packageName), selected);
      },
    }));
    if (!items.length) items.push({ label: "No media apps discovered yet.", disabled: true, onSelect: () => {} });
    const selectedPackage = this.menu?.selectedIndex != null ? this.packages[this.menu.selectedIndex] : undefined;
    const index = apps.findIndex((app) => app.packageName === selectedPackage);
    this.packages = apps.map((app) => app.packageName);

    const width = ctx.stack.getBaseSize().width;
    if (!this.menu || width !== this.menuWidth) {
      this.menuWidth = width;
      this.menu = new MenuLayer("Music settings", items, {
        x: 8, y: 8, width: width - 16,
        opaque: true, showBorder: false,
        footer: "On = enabled   Off = ignored",
      }).selectItem(Math.max(0, index));
    } else {
      this.menu.setItems(items, index >= 0 ? index : undefined);
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
