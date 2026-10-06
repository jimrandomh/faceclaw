import { getStringSetting, setStringSetting } from "../../native/settings-store";
import type { StoredEnvironment } from "./t3-client";

/**
 * Paired T3 Code environments, stored as JSON under one settings key (like
 * the Terminal app's connections). Each entry holds the bearer token issued
 * at pairing; it lasts 30 days and is never shown on screen.
 */
export const T3_ENVIRONMENTS_KEY = "t3code.environments";

export function loadEnvironments(): StoredEnvironment[] {
  const raw = getStringSetting(T3_ENVIRONMENTS_KEY, "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any): StoredEnvironment => ({
        id: String(item?.id ?? ""),
        environmentId: String(item?.environmentId ?? ""),
        label: String(item?.label ?? ""),
        httpBaseUrl: String(item?.httpBaseUrl ?? ""),
        wsBaseUrl: String(item?.wsBaseUrl ?? ""),
        accessToken: String(item?.accessToken ?? ""),
        expiresAtMs: Number(item?.expiresAtMs) || 0,
        enabled: item?.enabled !== false,
      }))
      .filter((environment) => environment.id && environment.httpBaseUrl && environment.accessToken);
  } catch {
    return [];
  }
}

export function saveEnvironments(environments: StoredEnvironment[]): void {
  setStringSetting(T3_ENVIRONMENTS_KEY, JSON.stringify(environments));
}

/** Insert or replace (by local id). */
export function upsertEnvironment(environment: StoredEnvironment): void {
  const environments = loadEnvironments();
  const index = environments.findIndex((candidate) => candidate.id === environment.id);
  if (index >= 0) environments[index] = environment;
  else environments.push(environment);
  saveEnvironments(environments);
}

export function removeEnvironment(id: string): void {
  saveEnvironments(loadEnvironments().filter((environment) => environment.id !== id));
}
