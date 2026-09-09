import { extensionPlatform } from "../../apps/external/extension-platform";
import { onEffectiveExtensionsChanged } from "../extension-settings";
import { appViewportSize } from "./geometry";
import { shell, type ShellWindow } from "./shell";

/** Keep the pinned host launcher as the immediate fallback for a lost provider. */
export function attachLauncherSurface(window: ShellWindow): void {
  const original = { hitTest: window.hitTest, input: window.handleInput, render: window.requestRender, relayout: window.relayout, foreground: window.setForeground, screen: window.setScreenOn };
  let visible = true, opened = "", wasFailed = false;
  const sync = (): boolean => {
    const platform = extensionPlatform(), winner = platform?.feature("ui.launcher");
    if (!platform || !winner) { opened = ""; return false; }
    // A timed-out stream is quarantined by the platform. Keep the host grid in
    // charge until an explicit retry or a new owner/epoch appears.
    if (platform.surfaceFailed("ui.launcher")) return false;
    const size = appViewportSize(window.heightMode ?? "min");
    const key = `${winner.component}:${winner.generation}:${size.width}:${size.height}`;
    if (key !== opened) {
      if (!platform.openSurface("ui.launcher", size.width, size.height)) return false;
      opened = key;
    }
    platform.setSurfaceVisibility("ui.launcher", visible, shell.isScreenOn());
    return platform.surfaceReady("ui.launcher");
  };
  window.handleInput = (event, frameId) => { if (sync()) extensionPlatform()?.surfaceInput("ui.launcher", event); else return original.input(event, frameId); };
  window.hitTest = (x, y) => {
    if (!sync()) return original.hitTest?.(x, y) ?? false;
    const platform = extensionPlatform();
    const size = appViewportSize(window.heightMode ?? "min");
    platform?.surfacePointer("ui.launcher", x, y, size.width, size.height);
    return platform?.surfaceReady("ui.launcher") === true;
  };
  window.requestRender = () => { if (!sync()) original.render(); };
  window.relayout = () => { original.relayout?.(); opened = ""; sync(); };
  window.setForeground = on => { visible = on; original.foreground?.(on); sync(); };
  window.setScreenOn = on => { original.screen?.(on); sync(); };
  extensionPlatform()?.onSurfaceHealthChanged(() => {
    const platform = extensionPlatform();
    const failed = platform?.surfaceFailed("ui.launcher") === true;
    // The listener also fires for first-frame takeover. Do not reopen that
    // stream, but do forget the old key on failure and on the following retry.
    if (failed || wasFailed) opened = "";
    wasFailed = failed;
    window.requestRender();
  });
  onEffectiveExtensionsChanged(() => window.requestRender());
}
