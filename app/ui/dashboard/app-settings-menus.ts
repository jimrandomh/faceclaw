import { installedAndroidApps, openAndroidAppSettings, prioritizeExtension, type InstalledAndroidApp } from '../../apps/external/platform';
import { extensionPlatform } from '../../apps/external/extension-platform';
import { extensionBehaviors, type EffectiveExtension } from '../extension-settings';
import { GrayImage } from '../../graphics/image';
import { getDefaultSmallFont } from '../../graphics/ui-fonts';
import { wrapText } from '../../graphics/textwrap';
import { type Layer, type LayerContext } from '../layers';
import { openModalMenu, type MenuItem } from '../menu';
import type { InputEvent } from '../gestures';

const labels: Record<string, string> = {
  'ui.launcher': 'Launcher and folders', 'ui.navigation': 'Gestures', 'ui.app-menu': 'App actions',
  'ui.window-layout': 'Window layout', 'ui.typography': 'Text appearance', 'ui.notifications': 'Notifications',
  assistant: 'Assistant', transcription: 'Dictation', refinement: 'Draft refinement',
  'device-tools': 'Assistant device tools', 'notification-content': 'App notification access',
};
let catalog: InstalledAndroidApp[] = [], catalogAt = -Infinity;
function apps(): InstalledAndroidApp[] {
  if (Date.now() - catalogAt > 30000) { catalog = installedAndroidApps(); catalogAt = Date.now(); }
  return catalog;
}
function appName(component: string): string { const pkg = component.split('/')[0]; return apps().find(app => app.packageName === pkg)?.name || pkg; }

/** A short handoff notice, removed by identity so its timer cannot pop another view. */
export class PhoneSettingsNotice implements Layer {
  private timer: ReturnType<typeof setTimeout> | null;
  constructor(private readonly ctx: LayerContext, private readonly text = 'Check your phone to modify settings.') {
    this.timer = setTimeout(() => this.close(), 3000);
  }
  private close(): void { this.ctx.stack.removeLayer(this); this.ctx.actions.requestRender(); }
  paint(ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow(), font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const w = Math.min(380, width - 32), lines = wrapText(font, this.text, w - 32);
    const h = lines.length * (font.lineHeight + 5) + 32, x = Math.floor((width - w) / 2), y = Math.floor((height - h) / 2);
    image.bakeDeferredDrawsInPlace(); image.fillRoundedRect(x, y, w, h, 1, 8); image.drawRoundedRect(x, y, w, h, 190, 8, 2);
    lines.forEach((line, i) => image.drawText(font, x + 16, y + 16 + i * (font.lineHeight + 5), line, 190));
    return image;
  }
  handleInput(event: InputEvent): void { if (event.type === 'click' || event.type === 'double-click') this.close(); }
  onRemoved(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
}
function openSettings(ctx: LayerContext, packageName: string): void {
  const opened = openAndroidAppSettings(packageName);
  ctx.stack.push(new PhoneSettingsNotice(ctx, opened ? undefined : 'App settings are unavailable. Try again on your phone.'));
  ctx.actions.requestRender();
}
export function installedAppSettingsItems(): MenuItem[] {
  return apps().map(app => ({ label: app.name, description: app.packageName, onSelect: ctx => openSettings(ctx, app.packageName) }));
}
export function contenderStatus(behavior: EffectiveExtension, item: NonNullable<EffectiveExtension['contenders']>[number]): string {
  if (item.reason === 'dependency-owner') return `Needs same app for ${(item.requires ?? []).map(id => labels[id] || id).join(', ')}`;
  if (item.reason === 'dependency-unavailable') return `Waiting for ${(item.requires ?? []).map(id => labels[id] || id).join(', ')}`;
  if (item.reason === 'incompatible') return 'App update needed';
  if (!item.enabled) return 'Off in app';
  if (!item.granted) return 'Permission needed';
  if (behavior.live && !item.connected) return 'Disconnected';
  if (behavior.component === item.component && extensionPlatform()?.surfaceFailed(behavior.feature)) return 'No frame; Faceclaw fallback';
  if (behavior.available && behavior.component === item.component) return 'In use';
  if (behavior.component === item.component && !behavior.available) return 'Selected; unavailable';
  return 'Lower priority';
}
function openOrder(ctx: LayerContext, feature: string): void {
  const behavior = extensionBehaviors().find(item => item.feature === feature); if (!behavior) return;
  const rows: MenuItem[] = (behavior.contenders ?? []).map((item, index) => ({
    label: `${index + 1}. ${appName(item.component)} · ${contenderStatus(behavior, item)}`,
    onSelect: (context, orderMenu) => openModalMenu(context, appName(item.component), [
      { label: 'Move to first', disabled: index === 0, onSelect: (c, actionMenu) => {
        if (!prioritizeExtension(feature, item.component)) return;
        c.stack.removeLayer(actionMenu); c.stack.removeLayer(orderMenu); openOrder(c, feature); c.actions.requestRender();
      } },
      { label: 'App settings', onSelect: c => openSettings(c, item.component.split('/')[0]) },
    ]),
  }));
  if (extensionPlatform()?.surfaceFailed(feature)) rows.push({ label: 'Retry app renderer', onSelect: c => { extensionPlatform()?.retrySurface(feature); c.stack.pop(); c.actions.requestRender(); } });
  rows.push({ label: 'Faceclaw default · fallback', disabled: true, onSelect() {} });
  openModalMenu(ctx, labels[feature] || feature, rows);
}
export function behaviorSettingsItems(): MenuItem[] {
  const items = extensionBehaviors().filter(item => item.feature !== 'notification-content').map(item => ({
    label: labels[item.feature] || item.feature,
    description: item.available && item.component && !extensionPlatform()?.surfaceFailed(item.feature)
      ? `In use: ${appName(item.component)}. Select to view or change app priority.`
      : `Faceclaw default is active.${item.component ? ` Selected: ${appName(item.component)}.` : ""} Select to inspect app priority or retry an unavailable renderer.`,
    onSelect: (ctx: LayerContext) => openOrder(ctx, item.feature),
  }));
  return items.length ? items : [{ label: 'No app overrides', disabled: true, onSelect() {} }];
}
