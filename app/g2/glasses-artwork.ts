/**
 * Product artwork for Even Realities hardware, keyed by the decoded serial.
 *
 * Prefer the photo of the exact SKU the serial decoded to, and fall back to
 * the generic product shot. Every surface that draws "the user's glasses"
 * should route through this — once the pair is known, showing brown Frame B
 * for a grey Frame A pair is a small lie the wearer will notice immediately.
 *
 * The PNGs live under `app/images/glasses/` (six SKU crops at 600×196 on a
 * shared bounding box so they render at the same scale, plus the generic G2
 * and R1 product shots). NativeScript
 * resolves `~/` to the app folder for `<Image src>`.
 *
 * This module is pure (no NativeScript imports) so it can run under node tests.
 */

import { BUNDLED_VARIANT_ASSET_NAMES, type GlassesHardwareIdentity } from "./glasses-hardware-identity";

export const GLASSES_IMAGE_DIR = "~/images/glasses";

/** Generic Even G2 product shot, used before the serial is known or for SKUs without art. */
export const GENERIC_G2_IMAGE_PATH = `${GLASSES_IMAGE_DIR}/even_realities_g2.png`;

/** Even R1 ring product shot. */
export const R1_IMAGE_PATH = `${GLASSES_IMAGE_DIR}/even_realities_r1.png`;

/** The SKU-specific photo, or null when none is bundled for this identity. */
export function variantImagePath(identity: GlassesHardwareIdentity | null | undefined): string | null {
  const name = identity?.imageAssetName;
  return name ? `${GLASSES_IMAGE_DIR}/${name}.png` : null;
}

/** The best available photo for these glasses: the SKU's own, else the generic shot. */
export function glassesImagePath(identity: GlassesHardwareIdentity | null | undefined): string {
  return variantImagePath(identity) ?? GENERIC_G2_IMAGE_PATH;
}

/** Relative file names (under `app/images/glasses/`) that must exist for the resolver's claims to hold. */
export function requiredArtworkFileNames(): string[] {
  return [...Array.from(BUNDLED_VARIANT_ASSET_NAMES).map((name) => `${name}.png`), "even_realities_g2.png", "even_realities_r1.png"].sort();
}
