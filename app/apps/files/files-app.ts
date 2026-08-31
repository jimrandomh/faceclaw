import { readTextFile, type DirectoryEntry } from "../../native/file-access";
import { isFontFile } from "../../native/font-files";
import { installFontFile, isFontInstalled } from "../../graphics/installed-fonts";
import { isDecodableImageFile } from "../../native/image-files";
import { readEvenHubPackageManifest } from "../evenhub/installed-apps";
import { EvenHubPermissionDialogLayer } from "../evenhub/permission-dialog";
import { FileBrowserLayer } from "./file-browser";
import { FileInfoDialogLayer, type FileInfoAction } from "./file-info-dialog";
import { type LayerContext } from "../../ui/layers";
import { FontPreviewerLayer } from "./font-previewer";
import { ImageViewerLayer } from "./image-viewer";
import { TextViewerLayer } from "./text-viewer";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const FILES_WINDOW_ID = "files";
export const FILES_SURFACE_ID = "window:files";

const TEXT_FILE = /\.(txt|md|log)$/i;
const EHPK_FILE = /\.ehpk$/i;

export type FilesAppOptions = InProcessAppOptions & {
  /** Open a text document as its own shell window (also used by the share intent). */
  openDocumentWindow: (title: string, text: string) => void;
  /** Open an image file as its own shell window. */
  openImageWindow: (title: string, path: string) => void;
  /** Launch an EvenHub app package (.ehpk) through the EvenHub host. */
  openEhpkApp: (path: string) => void;
  /** Copy an EHPK into the installed-app store, register it, and launch it. */
  installEhpkApp: (path: string) => Promise<void> | void;
  /** Open a font file's previewer as its own shell window. */
  openFontWindow: (title: string, path: string) => void;
};

/**
 * The Files app's launcher-opened window: a file browser over Places
 * (bookmarks and storage roots). Picking any file opens an info dialog with
 * metadata plus, for viewable types (text, images), the open actions.
 */
export function createFilesAppWindow(options: FilesAppOptions): InProcessWindow {
  let created: InProcessWindow | null = null;
  const browser = new FileBrowserLayer({
    isSupportedFile: (name) => TEXT_FILE.test(name) || isDecodableImageFile(name) || EHPK_FILE.test(name) || isFontFile(name),
    // The browser handles double-click itself (up a level), so it is not
    // wrapped in YieldAtRootLayer; it yields explicitly from the top level.
    onLeave: () => shell.yieldFocusToSidebar(),
    onFilePicked: (entry, ctx) => {
      ctx.stack.push(new FileInfoDialogLayer(entry, fileOpenActions(entry, options)));
    },
  });
  created = createInProcessWindow({
    appId: "files",
    windowId: FILES_WINDOW_ID,
    title: "Files",
    iconLetter: "F",
    icon: "folder",
    closeable: true,
    // Browser actions (view switch, bookmarks) only apply while the browser
    // itself is on top; a pushed viewer or dialog gets just the defaults.
    menuItems: () => (created && !created.stack.isAtBase() ? [] : browser.buildMenuItems()),
    actions: options.actions,
    onFocus: (lastInput) => browser.onFocus(lastInput),
    baseLayer: browser,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  return created;
}

/** One opened text document as its own window (from the browser or a share intent). */
export function createTextDocumentWindow(
  windowId: string,
  title: string,
  text: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "F",
    icon: "file-text",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new TextViewerLayer(text, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/** One opened font file's previewer as its own window. */
export function createFontDocumentWindow(
  windowId: string,
  title: string,
  path: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "F",
    icon: "type",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new FontPreviewerLayer(path, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/** One opened image file as its own window. */
export function createImageDocumentWindow(
  windowId: string,
  title: string,
  path: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "F",
    icon: "image",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new ImageViewerLayer(path, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/**
 * Show the permission-confirmation dialog for an .ehpk before install/run,
 * then run `proceed` if the user allows. Packages with neither permissions nor
 * a privacy policy skip the dialog and proceed immediately.
 */
function confirmEhpkPermissions(ctx: LayerContext, entry: DirectoryEntry, proceed: () => void): void {
  const manifest = readEvenHubPackageManifest(entry.path);
  if (!manifest || (manifest.permissions.length === 0 && !manifest.privacyPolicyUrl)) {
    proceed();
    return;
  }
  ctx.stack.push(
    new EvenHubPermissionDialogLayer(
      manifest.name,
      manifest.permissions,
      manifest.privacyPolicyUrl,
      proceed,
      () => {},
    ),
  );
}

/**
 * The open actions for the picked-file dialog: View here / Open in new
 * window for viewable types, empty for everything else (metadata only).
 */
function fileOpenActions(entry: DirectoryEntry, options: FilesAppOptions): FileInfoAction[] {
  if (TEXT_FILE.test(entry.name)) {
    return [
      {
        label: "View here",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          ctx.stack.push(new TextViewerLayer(text ?? "(could not read file)", entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          options.openDocumentWindow(entry.name, text ?? "(could not read file)");
        },
      },
    ];
  }
  if (EHPK_FILE.test(entry.name)) {
    return [
      {
        label: "Run app",
        onSelect: (ctx) => {
          ctx.stack.pop();
          confirmEhpkPermissions(ctx, entry, () => options.openEhpkApp(entry.path));
        },
      },
      {
        label: "Install",
        onSelect: (ctx) => {
          ctx.stack.pop();
          confirmEhpkPermissions(ctx, entry, () => {
            void options.installEhpkApp(entry.path);
          });
        },
      },
    ];
  }
  if (isDecodableImageFile(entry.name)) {
    return [
      {
        label: "View here",
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(new ImageViewerLayer(entry.path, entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          ctx.stack.pop();
          options.openImageWindow(entry.name, entry.path);
        },
      },
    ];
  }
  if (isFontFile(entry.name)) {
    // Install copies into the app-internal fonts directory, making the face
    // available in the Settings font pickers. The row relabels itself with
    // the result (the dialog re-reads labels each paint).
    const install: FileInfoAction = {
      label: isFontInstalled(entry.path) ? "Reinstall" : "Install",
      onSelect: () => {
        const error = installFontFile(entry.path);
        install.label = error ?? "Installed";
      },
    };
    return [
      {
        label: "Preview here",
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(new FontPreviewerLayer(entry.path, entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          ctx.stack.pop();
          options.openFontWindow(entry.name, entry.path);
        },
      },
      install,
    ];
  }
  return [];
}
