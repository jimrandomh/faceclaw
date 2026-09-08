import { Utils } from "@nativescript/core";
import { getUiFontSelection } from "../graphics/ui-fonts";
import { typographyPolicy } from "../ui/extension-settings";
import { onSettingsStoreChanged } from "./settings-store";

declare const com: any;

/** Publish the effective host font, including edits to the underlying user choice. */
export function publishSharedHostStyle(): void {
  if (!global.isAndroid) return;
  const selection = getUiFontSelection();
  const style = { ...typographyPolicy() };
  // The first SDK contract shares bundled fonts. A custom installed face stays
  // local instead of leaking its path or asking another app to open a host file.
  if (selection.kind === "ttf" && /^(Inter_18pt|Roboto|RobotoMono|Montserrat)-(Regular|Light|Bold)\.ttf$/.test(selection.file)
      && selection.size >= 8 && selection.size <= 20) {
    style.font = selection.file;
    style.size = selection.size;
  }
  com.faceclaw.app.FaceclawExternalApps.get(Utils.android.getApplicationContext()).publishSharedStyle(JSON.stringify(style));
}

let subscribed = false;
export function initializeSharedHostStyle(): void {
  if (subscribed) return;
  subscribed = true;
  onSettingsStoreChanged(key => {
    if (key === "apps.extensions.effective" || key === "display.uiFont2" || key === "display.uiFont") publishSharedHostStyle();
  });
  publishSharedHostStyle();
}
