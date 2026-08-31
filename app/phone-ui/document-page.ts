import { Frame, NavigatedData, Page, knownFolders } from "@nativescript/core";

/** Phone-side viewer for the project docs that webpack.config.js copies into
 * the bundle under about/ (LICENSE, PRIVACY, ...). The glasses-side
 * equivalent lives in ui/dashboard/settings-menus.ts. */
type DocumentContext = { fileName?: string; title?: string } | undefined;

export function navigatingTo(args: NavigatedData): void {
  const page = args.object as Page;
  const context = args.context as DocumentContext;
  const fileName = context?.fileName ?? "";
  page.bindingContext = {
    title: context?.title ?? fileName,
    text: readBundledDoc(fileName),
    onBackTap: () => Frame.topmost()?.goBack(),
  };
}

function readBundledDoc(fileName: string): string {
  try {
    const text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync();
    return text || `(${fileName} is missing from this build)`;
  } catch {
    return `(${fileName} is missing from this build)`;
  }
}
