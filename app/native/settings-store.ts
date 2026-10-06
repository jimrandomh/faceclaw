/**
 * TS wrapper for the Java FaceclawSettings singleton: settings storage shared
 * by every isolate (main thread and app workers), with cross-isolate change
 * notifications. Each isolate that subscribes registers one Java listener;
 * Java dispatches through the registering thread's Looper so callbacks run on
 * this isolate's own thread.
 */
import { Utils } from "@nativescript/core";

declare const com: any;
declare const android: any;

let javaInstance: any = null;
// The Java-side listener proxy must stay referenced or it gets GC'd.
let retainedListenerProxy: any = null;
const changeListeners = new Set<(key: string) => void>();

// Values already read through JNI, which cost a bridge call each and are read
// many times per paint (display mode, fonts, clock format). Only used while
// this isolate's Java listener is registered on a thread with a Looper: every
// write, from any isolate, notifies that listener, which drops the key before
// any other change listener runs. A write from another isolate is visible here
// once its notification has been dispatched (one message-loop tick), the same
// point at which change listeners hear about it.
// Strings are cached without a default (null = unset). Booleans are cached per
// default, since the Java getter cannot report "unset", except after a write
// from this isolate (defaultValue null: stored, so any default reads it).
const stringCache = new Map<string, string | null>();
const booleanCache = new Map<string, { defaultValue: boolean | null; value: boolean }>();
let cachingEnabled: boolean | null = null;

/** Release this isolate's native observer before its worker is terminated. */
export function disposeSettingsStore(): void {
  changeListeners.clear();
  if (retainedListenerProxy !== null) getJava().unregisterListener(retainedListenerProxy);
  retainedListenerProxy = null;
  cachingEnabled = false;
  stringCache.clear();
  booleanCache.clear();
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

function canCache(): boolean {
  if (cachingEnabled === null) {
    cachingEnabled = false;
    try {
      // FaceclawSettings dispatches notifications through the registering
      // thread's Looper; without one this isolate would never hear of writes.
      if (android.os.Looper.myLooper() !== null) {
        ensureJavaListener();
        cachingEnabled = true;
      }
    } catch {
      cachingEnabled = false;
    }
  }
  return cachingEnabled;
}

export function getStringSetting(key: string, defaultValue: string): string {
  if (!canCache()) return String(getJava().getString(key, defaultValue));
  let value = stringCache.get(key);
  if (value === undefined) {
    const raw = getJava().getString(key, null);
    value = raw === null || raw === undefined ? null : String(raw);
    stringCache.set(key, value);
  }
  return value ?? defaultValue;
}

export function setStringSetting(key: string, value: string): void {
  getJava().setString(key, value);
  if (cachingEnabled) stringCache.set(key, value === null || value === undefined ? null : String(value));
}

export function getBooleanSetting(key: string, defaultValue: boolean): boolean {
  if (!canCache()) return Boolean(getJava().getBoolean(key, defaultValue));
  const cached = booleanCache.get(key);
  if (cached !== undefined && (cached.defaultValue === null || cached.defaultValue === defaultValue)) {
    return cached.value;
  }
  const value = Boolean(getJava().getBoolean(key, defaultValue));
  booleanCache.set(key, { defaultValue, value });
  return value;
}

export function setBooleanSetting(key: string, value: boolean): void {
  getJava().setBoolean(key, value);
  if (cachingEnabled) booleanCache.set(key, { defaultValue: null, value: Boolean(value) });
}

function forgetCachedSetting(key: string | null | undefined): void {
  if (key === null || key === undefined) {
    stringCache.clear();
    booleanCache.clear();
    return;
  }
  stringCache.delete(key);
  booleanCache.delete(key);
}

function ensureJavaListener(): void {
  if (retainedListenerProxy !== null) return;
  retainedListenerProxy = new com.faceclaw.app.FaceclawSettingsListener({
    onSettingChanged: (key: string) => {
      forgetCachedSetting(key === null || key === undefined ? key : String(key));
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

/**
 * Subscribe to setting changes from any isolate (including this one). The
 * callback runs on this isolate's own thread, one message-loop tick after the
 * change.
 */
export function onSettingsStoreChanged(listener: (key: string) => void): () => void {
  ensureJavaListener();
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
