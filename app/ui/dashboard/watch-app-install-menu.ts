import { TextViewerLayer } from "../../apps/files/text-viewer";
import { WATCH_APP_INSTALLERS } from "../../g2/watch-app-install-guide";
import { watchAppInstall, type WatchAppInstallSource } from "../../native/watch-app-install";
import { type LayerContext } from "../layers";
import { type MenuItem } from "../menu";

const LABEL = "Install watch app";

/**
 * Settings > Watch: the row that starts installing the Apple Watch app, as the
 * Install button on the phone's settings page does. An empty list unless the
 * paired watch lacks the app and this copy of Faceclaw has one to give it (so
 * always, on Android); the panel re-reads it on every paint.
 *
 * The installing happens in another iPhone app, which the phone has to open,
 * and it only can while Faceclaw is on its screen. With the phone in a pocket
 * the row says to get it out, and the opening follows when Faceclaw is in front.
 */
export function watchAppInstallMenuItems(): MenuItem[] {
  const source = watchAppInstall.getState() === "not-installed" ? watchAppInstall.getSource() : null;
  return source ? [installMenuItem(source)] : [];
}

function installMenuItem(source: WatchAppInstallSource): MenuItem {
  const { name, steps } = WATCH_APP_INSTALLERS[source];
  return {
    label: LABEL,
    description: `Opens ${name} on your iPhone. ${steps}`,
    onSelect: async (ctx) => {
      // The row can outlive its reason: nothing repaints Settings when the watch gets the app some other way.
      if (watchAppInstall.getState() !== "not-installed") {
        ctx.actions.requestRender();
        return;
      }
      repaintWhenInstalled(ctx);
      const handover = await watchAppInstall.openSourceWhenInFront();
      if (handover === "opened") return;
      const message =
        handover === "waiting"
          ? `Unlock your iPhone and open Faceclaw to go on to ${name}. ${steps}`
          : `Couldn't open ${name} on your iPhone. Open it from the Home Screen. ${steps}`;
      ctx.stack.push(new TextViewerLayer(message, LABEL));
    },
  };
}

let stopWatchingInstall: (() => void) | null = null;

/** Once the watch has the app, the row goes and the status above it changes; nothing else would repaint for that. */
function repaintWhenInstalled(ctx: LayerContext): void {
  stopWatchingInstall?.();
  stopWatchingInstall = watchAppInstall.onStateChanged(() => {
    ctx.actions.requestRender();
    if (watchAppInstall.getState() !== "installed") return;
    stopWatchingInstall?.();
    stopWatchingInstall = null;
  });
}
