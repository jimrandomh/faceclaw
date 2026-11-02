/**
 * The paired glasses' screen (per eye), which the shell and UI lay out in:
 * the G2's 640x480, or the RayNeo iO's 540x220 with the Faceclaw firmware.
 *
 * Read straight from the settings store (the key dashboard-settings.ts's
 * glassesTypeSetting writes), so this stays a leaf that UI primitives can
 * import without pulling in the settings module, and every isolate (the
 * main one, app workers, the phone preview) agrees with the session.
 */
import { getStringSetting } from "../native/settings-store";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, RAYNEO_IO_HEIGHT, RAYNEO_IO_WIDTH } from "./image";

/** Settings key of the paired glasses' type: "g2" (default) or "rayneo-io". */
export const GLASSES_TYPE_KEY = "deviceType";

/** Whether the paired glasses are a RayNeo iO. */
export function isRayNeoIoConfigured(): boolean {
  return getStringSetting(GLASSES_TYPE_KEY, "g2") === "rayneo-io";
}

export function screenWidth(): number {
  return isRayNeoIoConfigured() ? RAYNEO_IO_WIDTH : G2_LENS_WIDTH;
}

export function screenHeight(): number {
  return isRayNeoIoConfigured() ? RAYNEO_IO_HEIGHT : G2_LENS_HEIGHT;
}
