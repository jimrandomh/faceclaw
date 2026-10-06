import { UiFontOverride } from "../../graphics/ui-fonts";

/**
 * The font Glanceboard widgets paint with: the Glanceboard's own Font
 * setting, or the Display UI font while that is unset. Its small, medium and
 * large roles carry the same line-height guarantees as getDefault*Font.
 */
export const glanceFont = new UiFontOverride("glanceboard.font");
