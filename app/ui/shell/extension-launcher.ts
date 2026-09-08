import { extensionPlatform } from "../../apps/external/extension-platform";
import { onEffectiveExtensionsChanged } from "../extension-settings";
import { appViewportSize } from "./geometry";
import { shell, type ShellWindow } from "./shell";

/** Keep the pinned host launcher as the immediate fallback for a lost provider. */
export function attachLauncherSurface(window: ShellWindow): void {
  const original = { hitTest: window.hitTest, input: window.handleInput, render: window.requestRender, relayout: window.relayout, foreground: window.setForeground, screen: window.setScreenOn };
  let visible = true, opened = "";
  const sync = (): boolean => {
    const platform = extensionPlatform(), winner = platform?.feature("ui.launcher");
    if (!platform || !winner) { opened = ""; return false; }
    const size = appViewportSize(window.heightMode ?? "min");
    const key = `${winner.component}:${winner.generation}:${size.width}:${size.height}`;
    if (key !== opened) {
      if (!platform.openSurface("ui.launcher", size.width, size.height)) return false;
      opened = key;
    }
    platform.setSurfaceVisibility("ui.launcher", visible, shell.isScreenOn());
    return true;
  };
  window.handleInput = (event, frameId) => { if (sync()) extensionPlatform()?.surfaceInput("ui.launcher", event); else return original.input(event, frameId); };
  window.hitTest = (x, y) => {
    if (!sync()) return original.hitTest?.(x, y) ?? false;
    const size = appViewportSize(window.heightMode ?? "min");
    extensionPlatform()?.surfacePointer("ui.launcher", x, y, size.width, size.height);
    return true;
  };
  window.requestRender = () => { if (!sync()) original.render(); };
  window.relayout = () => { original.relayout?.(); opened = ""; sync(); };
  window.setForeground = on => { visible = on; original.foreground?.(on); sync(); };
  window.setScreenOn = on => { original.screen?.(on); sync(); };
  onEffectiveExtensionsChanged(() => window.requestRender());
}
