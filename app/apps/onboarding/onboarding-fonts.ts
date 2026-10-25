/**
 * The onboarding's own fonts: bundled Roboto at fixed sizes, deliberately
 * not the user's UI font, so the pages are readable before (and while) the
 * text size is being chosen. Bitmap Terminus stands in where TTF rendering
 * is unavailable.
 */
import { getFont, getTerminusFont } from "../../graphics/bdffont";
import type { UiFont } from "../../graphics/image";
import { ensurePreinstalledFonts, installedFontPath } from "../../graphics/installed-fonts";
import { TtfFont } from "../../graphics/ttf-font";

export type OnboardingFontRole = "hero" | "title" | "body" | "detail";

const ROLE_FONTS: Record<OnboardingFontRole, { file: string; size: number; fallback: () => UiFont }> = {
  /** The welcome page's "Faceclaw". */
  hero: { file: "Roboto-Regular.ttf", size: 44, fallback: () => getFont("terminus32") },
  /** Page titles. */
  title: { file: "Roboto-Regular.ttf", size: 26, fallback: () => getFont("terminus24") },
  /** Prompts and choices. */
  body: { file: "Roboto-Regular.ttf", size: 20, fallback: () => getTerminusFont(20, false) ?? getFont("terminus16") },
  /** Explanations under titles and beside choices. */
  detail: { file: "Roboto-Regular.ttf", size: 16, fallback: () => getFont("terminus16") },
};

let fontsEnsured = false;

export function onboardingFont(role: OnboardingFontRole): UiFont {
  if (!fontsEnsured) {
    fontsEnsured = true;
    try {
      ensurePreinstalledFonts(); // onboarding may be the first thing to draw TTF text
    } catch (error) {
      console.warn(`onboarding font preinstall failed: ${error}`);
    }
  }
  const spec = ROLE_FONTS[role];
  return TtfFont.load(installedFontPath(spec.file), spec.size) ?? spec.fallback();
}
