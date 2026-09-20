/**
 * Always-available window-management assistant tools: launch launcher apps,
 * list / focus / close shell windows, and manage the launcher's folder
 * grouping. Registered from the dashboard controller (which owns launchApp);
 * mirrors what the user can do from the launcher grid and the sidebar.
 *
 * The launchable set is the built-in launcher apps plus whatever EvenHub
 * packages are installed right now, matching the launcher grid. Installs and
 * uninstalls change that set at runtime, so the tools re-register (replacing
 * themselves by name) whenever it changes to keep the id enums and
 * descriptions current; register() fires the tools-changed broadcast that
 * propagates the new specs to the assistant backends.
 */
import { shell, type ShellWindow } from "../ui/shell/shell";
import type { AppDefinition } from "../apps/app-definition";
import {
  disbandFolder,
  FOLDER_NAME_MAX_LENGTH,
  getFolderAssignments,
  getFolders,
  resolveFolderName,
  setAppFolder,
} from "../apps/launcher/launcher-folders";
import {
  getInstalledEvenHubApps,
  getInstalledEvenHubFingerprint,
  installedEvenHubAppId,
} from "../apps/evenhub/installed-apps";
import { onAnySettingChanged } from "../ui/dashboard-settings";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

export type WindowToolsOptions = {
  /** The built-in launcher apps; installed EvenHub apps are added dynamically. */
  apps: readonly AppDefinition[];
  /** Launch (or focus) an app exactly as the launcher grid would. */
  launchApp: (appId: string) => Promise<void> | void;
  /** Repaint the shell surface so the sidebar reflects a focus change. */
  requestShellRender: () => void;
};

let registered = false;

export function registerWindowTools(
  options: WindowToolsOptions,
  registry: ToolRegistry = toolRegistry,
): void {
  if (registered) return;
  registered = true;
  registerTools(options, registry);
  let fingerprint = getInstalledEvenHubFingerprint();
  onAnySettingChanged(() => {
    const current = getInstalledEvenHubFingerprint();
    if (current === fingerprint) return;
    fingerprint = current;
    registerTools(options, registry);
  });
}

function registerTools(options: WindowToolsOptions, registry: ToolRegistry): void {
  const installedApps = getInstalledEvenHubApps();
  const apps = new Map(options.apps.map((app) => [app.appId, app.title]));
  for (const app of installedApps) {
    apps.set(installedEvenHubAppId(app.packageId), app.name);
  }
  const appIds = Array.from(apps.keys()).sort();
  /** An id plus its display name, when the name isn't obvious from the id. */
  const describeApp = (appId: string): string => {
    const title = apps.get(appId);
    return title && title.toLowerCase() !== appId.toLowerCase() ? `${appId} ("${title}")` : appId;
  };
  const installedNote = installedApps.length
    ? ` Installed EvenHub apps: ${installedApps
        .map((app) => describeApp(installedEvenHubAppId(app.packageId)))
        .join(", ")}.`
    : "";

  registry.registerSystemTool(
    {
      name: "apps.launch",
      description:
        "Open an app on the glasses and bring it to the foreground. If the app already has a window open, this focuses it instead. Wakes the display if it is off." +
        installedNote,
      inputSchema: {
        type: "object",
        properties: {
          app_id: { type: "string", enum: appIds, description: "The app to open." },
        },
        required: ["app_id"],
        additionalProperties: false,
      },
    },
    async (args) => {
      const appId = String(args?.app_id ?? "").trim();
      if (appIds.indexOf(appId) < 0) {
        return err(`Unknown app: ${appId}. Available apps: ${appIds.join(", ")}`);
      }
      shell.wake("window");
      await options.launchApp(appId);
      return ok(`Opened ${describeApp(appId)}.`);
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.list_windows",
      description:
        "List the open windows in the glasses sidebar: window id, title, owning app, and which one is foreground. Pinned windows (the launcher) cannot be closed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => {
      const foregroundId = shell.foregroundWindow()?.windowId ?? null;
      const lines = shell.getWindows().map((window) => {
        const marks = [
          window.windowId === foregroundId ? "foreground" : null,
          window.closeable ? null : "pinned",
        ]
          .filter(Boolean)
          .join(", ");
        return `- ${window.windowId} — "${window.title}" (app: ${window.appId})${marks ? ` [${marks}]` : ""}`;
      });
      return ok(lines.join("\n"));
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.focus_window",
      description:
        "Bring an already-open window to the foreground and give it input focus. Wakes the display if it is off. To open an app that has no window yet, use apps.launch instead.",
      inputSchema: {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description:
              "A window id from apps.list_windows, or an app id when that app has exactly one window open.",
          },
        },
        required: ["window_id"],
        additionalProperties: false,
      },
    },
    (args) => {
      const window = resolveWindow(String(args?.window_id ?? "").trim());
      if (typeof window === "string") return err(window);
      shell.wake("window");
      shell.focusWindow(window.windowId);
      options.requestShellRender();
      return ok(`Focused ${window.windowId} ("${window.title}").`);
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.close_window",
      description: "Close an open window. Pinned windows (the launcher) cannot be closed.",
      inputSchema: {
        type: "object",
        properties: {
          window_id: {
            type: "string",
            description:
              "A window id from apps.list_windows, or an app id when that app has exactly one window open.",
          },
        },
        required: ["window_id"],
        additionalProperties: false,
      },
    },
    (args) => {
      const window = resolveWindow(String(args?.window_id ?? "").trim());
      if (typeof window === "string") return err(window);
      if (!window.closeable) {
        return err(`Window ${window.windowId} is pinned and can't be closed.`);
      }
      shell.closeWindow(window.windowId);
      return ok(`Closed ${window.windowId} ("${window.title}").`);
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.list_folders",
      description:
        "List the app launcher's folders and the apps inside each, plus the ungrouped top-level apps. Includes installed EvenHub apps, shown as app_id (\"display name\").",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => {
      const lines: string[] = [];
      for (const [name, members] of getFolders()) {
        const known = members.filter((appId) => appIds.indexOf(appId) >= 0).sort();
        if (known.length) lines.push(`${name}: ${known.map(describeApp).join(", ")}`);
      }
      const assignments = getFolderAssignments();
      const ungrouped = appIds.filter((appId) => !assignments[appId]);
      lines.push(`Ungrouped: ${ungrouped.length ? ungrouped.map(describeApp).join(", ") : "(none)"}`);
      return ok(lines.join("\n"));
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.move_to_folder",
      description:
        "Group an app into a named launcher folder, creating the folder if it doesn't exist yet. The app appears inside the folder in the launcher grid instead of at the top level.",
      inputSchema: {
        type: "object",
        properties: {
          app_id: { type: "string", enum: appIds, description: "The app to move." },
          folder: {
            type: "string",
            description: "The folder name. An existing folder's name matches case-insensitively.",
          },
        },
        required: ["app_id", "folder"],
        additionalProperties: false,
      },
    },
    (args) => {
      const appId = String(args?.app_id ?? "").trim();
      if (appIds.indexOf(appId) < 0) {
        return err(`Unknown app: ${appId}. Available apps: ${appIds.join(", ")}`);
      }
      const folder = resolveFolderName(String(args?.folder ?? ""));
      if (!folder) return err("folder must be a non-empty name");
      if (folder.length > FOLDER_NAME_MAX_LENGTH) {
        return err(`Folder names are limited to ${FOLDER_NAME_MAX_LENGTH} characters.`);
      }
      setAppFolder(appId, folder);
      return ok(`Moved ${describeApp(appId)} into "${folder}".`);
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.remove_from_folder",
      description:
        "Move an app out of its launcher folder back to the top-level grid. A folder disappears when its last app is removed.",
      inputSchema: {
        type: "object",
        properties: {
          app_id: { type: "string", enum: appIds, description: "The app to ungroup." },
        },
        required: ["app_id"],
        additionalProperties: false,
      },
    },
    (args) => {
      const appId = String(args?.app_id ?? "").trim();
      if (appIds.indexOf(appId) < 0) {
        return err(`Unknown app: ${appId}. Available apps: ${appIds.join(", ")}`);
      }
      const folder = getFolderAssignments()[appId];
      if (!folder) return ok(`${describeApp(appId)} isn't in a folder.`);
      setAppFolder(appId, null);
      return ok(`Removed ${describeApp(appId)} from "${folder}".`);
    },
  );

  registry.registerSystemTool(
    {
      name: "apps.disband_folder",
      description:
        "Delete a launcher folder by moving all of its apps back to the top-level grid.",
      inputSchema: {
        type: "object",
        properties: {
          folder: { type: "string", description: "The folder to disband (case-insensitive)." },
        },
        required: ["folder"],
        additionalProperties: false,
      },
    },
    (args) => {
      const folder = resolveFolderName(String(args?.folder ?? ""));
      if (!folder) return err("folder must be a non-empty name");
      const moved = disbandFolder(folder);
      if (moved === 0) {
        const names = Array.from(getFolders().keys());
        return err(
          names.length
            ? `No folder named "${folder}". Folders: ${names.join(", ")}`
            : `No folder named "${folder}". There are no folders.`,
        );
      }
      return ok(`Disbanded "${folder}"; ${moved} app${moved === 1 ? "" : "s"} moved to the top level.`);
    },
  );
}

/**
 * Find an open window by exact window id, falling back to an app id that has
 * exactly one window. Returns an error message string when nothing (or more
 * than one thing) matches.
 */
function resolveWindow(id: string): ShellWindow | string {
  if (!id) return "window_id is required";
  const windows = shell.getWindows();
  const exact = windows.find((window) => window.windowId === id);
  if (exact) return exact;
  const byApp = windows.filter((window) => window.appId === id);
  if (byApp.length === 1) return byApp[0]!;
  if (byApp.length > 1) {
    return `App ${id} has ${byApp.length} windows open: ${byApp
      .map((window) => window.windowId)
      .join(", ")}. Pass one of those window ids.`;
  }
  return `No open window matches "${id}". Open windows: ${windows
    .map((window) => window.windowId)
    .join(", ")}`;
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
