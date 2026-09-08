import { installedExternalApps, externalAppId } from "../external/platform";
import { shell } from "../../ui/shell/shell";
import { type AppDefinition } from "../app-definition";
import { createLauncherWindow, LAUNCHER_SURFACE_ID, LAUNCHER_WINDOW_ID } from "./launcher-app";
import {
  getInstalledEvenHubApps,
  installedEvenHubAppId,
  renderInstalledEvenHubIcon,
} from "../evenhub/installed-apps";

const launcherApp: AppDefinition = {
  appId: "launcher",
  title: "Apps",
  icon: "layout-grid",
  // The launcher is the app grid itself, not an entry in it.
  showInLauncher: false,
  // Pinned first in the sidebar and the boot foreground; registered at
  // startup rather than launched.
  boot: (ctx) => {
    shell.registerWindow(
      createLauncherWindow({
        actions: {
          ...ctx.actions,
          requestRender: () => shell.foregroundWindow()?.requestRender(),
        },
        apps: () => [
          ...installedExternalApps().map((app) => ({ appId: externalAppId(app.component), label: app.name, icon: "package" as const })),
          ...ctx.apps
            .filter((app) => app.showInLauncher !== false)
            .map((app) => ({
              appId: app.appId,
              label: app.title,
              icon: app.icon,
              renderIcon: app.renderIcon,
            })),
          ...getInstalledEvenHubApps().map((app) => ({
            appId: installedEvenHubAppId(app.packageId),
            label: app.name,
            icon: "package" as const,
            renderIcon: (size: number) => renderInstalledEvenHubIcon(app.packageId, size, app),
            iconKey: `${app.installedAt}:${app.iconFile ?? ""}`,
            uninstallable: true,
          })),
        ],
        launchApp: (appId) => ctx.launchApp(appId),
        uninstallApp: (appId) => ctx.uninstallApp(appId),
        submitFrame: (planes, paintMs, frameId) => ctx.submitWindowFrame(LAUNCHER_SURFACE_ID, planes, paintMs, frameId),
        setSurfaceVisible: (visible) => ctx.setWindowSurfaceVisible(LAUNCHER_SURFACE_ID, visible),
      }),
    );
  },
  // The launcher window is pinned and always open; launching means focusing.
  launch: async (ctx) => {
    shell.focusWindow(LAUNCHER_WINDOW_ID);
    ctx.requestShellRender();
  },
};

export default launcherApp;
