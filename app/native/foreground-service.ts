import { Utils } from "@nativescript/core";

declare const com: any;

function getContext(): android.content.Context {
  const context = Utils.android.getApplicationContext();
  if (!context) throw new Error("Android application context unavailable");
  return context;
}

function createIntent(action: string, text?: string): android.content.Intent {
  const context = getContext();
  const intent = new android.content.Intent(context, com.faceclaw.app.FaceclawForegroundService.class);
  intent.setAction(action);
  if (text) {
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_TEXT, text);
  }
  return intent;
}

export function startForegroundNotification(text: string): void {
  if (!global.isAndroid) return;
  const context = getContext();
  const intent = createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_START, text);
  androidx.core.content.ContextCompat.startForegroundService(context, intent);
}

export function updateForegroundNotification(text: string): void {
  if (!global.isAndroid) return;
  const context = getContext();
  context.startService(createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_UPDATE, text));
}

export function stopForegroundNotification(): void {
  if (!global.isAndroid) return;
  const context = getContext();
  context.startService(createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_STOP));
}
