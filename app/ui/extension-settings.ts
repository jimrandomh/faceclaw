import { getStringSetting, onSettingsStoreChanged } from "../native/settings-store";

/** Native ExtensionRegistry validates, authorizes and publishes this snapshot.
 * Read its effective values in every isolate; never overwrite the user's settings. */
export const EXTENSIONS_EFFECTIVE_KEY = "apps.extensions.effective";

export type ExtensionFeatureId =
  | "ui.launcher" | "ui.navigation" | "ui.app-menu" | "ui.window-layout"
  | "ui.typography" | "ui.notifications" | "assistant" | "transcription"
  | "refinement" | "device-tools" | "notification-content";

export type EffectiveExtension = {
  feature: ExtensionFeatureId;
  component: string;
  configuration: Record<string, string | number | boolean>;
  live: boolean;
  available: boolean;
  generation: number;
  contenders?: { component: string; enabled: boolean; granted: boolean; connected: boolean }[];
};
type ExtensionSnapshot = { version: number; generation: number; features: EffectiveExtension[] };
let lastRaw: string | undefined;
let snapshot: ExtensionSnapshot = { version: 1, generation: 0, features: [] };

function currentSnapshot(): ExtensionSnapshot {
  const raw = getStringSetting(EXTENSIONS_EFFECTIVE_KEY, "");
  if (raw !== lastRaw) {
    lastRaw = raw;
    try {
      const next = JSON.parse(raw) as ExtensionSnapshot;
      snapshot = next?.version === 1 && Array.isArray(next.features)
        ? next : { version: 1, generation: 0, features: [] };
    } catch {
      snapshot = { version: 1, generation: 0, features: [] };
    }
  }
  return snapshot;
}

export function extensionBehaviors(): EffectiveExtension[] { return currentSnapshot().features.filter(entry => entry.contenders?.length); }

export function effectiveExtension(feature: ExtensionFeatureId): EffectiveExtension | undefined {
  return currentSnapshot().features.find(entry => entry.feature === feature && entry.available && entry.component);
}

export function onEffectiveExtensionsChanged(listener: () => void): () => void {
  return onSettingsStoreChanged(key => {
    if (key === EXTENSIONS_EFFECTIVE_KEY) listener();
  });
}

export type NavigationPolicy = {
  doubleTap: "back" | "sleep";
  rootBack: "sleep" | "switcher";
  tapHold: "switcher" | "app-menu";
  hold: "app-menu" | "system-menu";
  wakeFocus: "window" | "sidebar";
};
export function navigationPolicy(): NavigationPolicy {
  return {
    doubleTap: "back", rootBack: "switcher", tapHold: "app-menu", hold: "system-menu", wakeFocus: "sidebar",
    ...effectiveExtension("ui.navigation")?.configuration,
  } as NavigationPolicy;
}

export type WindowLayoutPolicy = {
  centered: boolean;
  sidebarMode: "overlay" | "persistent";
  switcherHeight: "display" | "minimum";
  dividerWidth: number;
  ownTopBar: boolean;
  inputDialogs: "compact" | "viewport";
};
export function windowLayoutPolicy(): WindowLayoutPolicy {
  return {
    centered: false, sidebarMode: "persistent", switcherHeight: "minimum", dividerWidth: 1, ownTopBar: true, inputDialogs: "compact",
    ...effectiveExtension("ui.window-layout")?.configuration,
  } as WindowLayoutPolicy;
}

export type AppMenuPolicy = {
  title?: string;
  displayOffFirst: boolean;
  systemActionsLast: boolean;
  systemTitle: string;
};
export function appMenuPolicy(): AppMenuPolicy {
  return {
    displayOffFirst: false, systemActionsLast: false, systemTitle: "System actions",
    ...effectiveExtension("ui.app-menu")?.configuration,
  } as AppMenuPolicy;
}

export type TypographyPolicy = {
  font?: string; size?: number; raster?: "antialiased" | "crisp" | "hinted";
  borderWidth?: number; selectionBorderWidth?: number; cardRadius?: number;
};
export function typographyPolicy(): TypographyPolicy {
  return effectiveExtension("ui.typography")?.configuration ?? {};
}

/** A layout provider can supply its own header only inside its own app window. */
export function showWindowTopBar(appId?: string): boolean {
  const owner = effectiveExtension("ui.window-layout");
  return !owner || owner.configuration.ownTopBar !== false || appId !== `apk:${owner.component}`;
}
