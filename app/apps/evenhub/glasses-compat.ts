/**
 * EvenHub with glasses that aren't Even Realities': with a RayNeo iO paired,
 * the store is off (it is Even's, and its apps are made for their glasses),
 * while apps sideloaded through Files or the Developer app still run, after a
 * warning the first time each one launches that it won't display correctly
 * (EvenHub apps lay out for the G2's 576x288 display; the iO's is 540x220).
 */
import { glassesTypeSetting } from "../../ui/dashboard-settings";
import { getStringSetting, setStringSetting } from "../../native/settings-store";

/** The package IDs whose RayNeo iO display warning has been answered, as a JSON array. */
const DISPLAY_WARNED_KEY = "evenhub.rayneoDisplayWarned";

/** Whether the EvenHub store can be used: with Even Realities glasses paired, not a RayNeo iO. */
export function isEvenHubStoreAvailable(): boolean {
  return glassesTypeSetting.get() !== "rayneo-io";
}

/** Whether launching this package should warn that it won't display correctly on these glasses. */
export function needsDisplayWarning(packageId: string): boolean {
  return glassesTypeSetting.get() === "rayneo-io" && !displayWarnedPackages().includes(packageId);
}

/** The user answered the package's display warning: don't show it again. */
export function markDisplayWarningShown(packageId: string): void {
  const warned = displayWarnedPackages();
  if (warned.includes(packageId)) return;
  setStringSetting(DISPLAY_WARNED_KEY, JSON.stringify([...warned, packageId]));
}

function displayWarnedPackages(): string[] {
  try {
    const parsed: unknown = JSON.parse(getStringSetting(DISPLAY_WARNED_KEY, "[]"));
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
