/**
 * TS wrapper for the Java FaceclawSettings singleton: settings storage shared
 * by every isolate (main thread and app workers), with cross-isolate change
 * notifications. Each isolate that subscribes registers one Java listener;
 * Java dispatches through the registering thread's Looper so callbacks run on
 * this isolate's own thread.
 */
import { Utils } from "@nativescript/core";

declare const com: any;

let javaInstance: any = null;
// The Java-side listener proxy must stay referenced or it gets GC'd.
let retainedListenerProxy: any = null;
const changeListeners = new Set<(key: string) => void>();

/** Release this isolate's native observer before its worker is terminated. */
export function disposeSettingsStore(): void {
  changeListeners.clear();
  if (retainedListenerProxy !== null) getJava().unregisterListener(retainedListenerProxy);
  retainedListenerProxy = null;
}

function getJava(): any {
  if (javaInstance === null) {
    const context = Utils.android?.getApplicationContext?.();
    javaInstance = context
      ? com.faceclaw.app.FaceclawSettings.getInstance(context)
      : com.faceclaw.app.FaceclawSettings.getInstance();
  }
  return javaInstance;
}

export function getStringSetting(key: string, defaultValue: string): string {
  return String(getJava().getString(key, defaultValue));
}

export function setStringSetting(key: string, value: string): void {
  getJava().setString(key, value);
}

export function getBooleanSetting(key: string, defaultValue: boolean): boolean {
  return Boolean(getJava().getBoolean(key, defaultValue));
}

export function setBooleanSetting(key: string, value: boolean): void {
  getJava().setBoolean(key, value);
}

/**
 * Subscribe to setting changes from any isolate (including this one). The
 * callback runs on this isolate's own thread, one message-loop tick after the
 * change.
 */
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  if (retainedListenerProxy === null) {
    retainedListenerProxy = new com.faceclaw.app.FaceclawSettingsListener({
      onSettingChanged: (key: string) => {
        for (const registered of Array.from(changeListeners)) {
          try {
            registered(String(key));
          } catch (error) {
            console.warn("settings change listener failed", error);
          }
        }
      },
    });
    getJava().registerListener(retainedListenerProxy);
  }
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
