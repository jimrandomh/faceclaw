declare const com: any;
declare const java: any;

/**
 * On-device language identification and translation for captions, over ML
 * Kit (bundled language-id, per-pair translation models downloaded on
 * demand). Foreign-language captions show the original line with the
 * translation to the phone's default language beneath it.
 */

let languageIdentifier: any | null = null;
// Translators are expensive to build (model download on first use); cache by
// "src>dst" and keep the proxies referenced so they aren't GC'd mid-flight.
const translators = new Map<string, any>();
const downloadedPairs = new Set<string>();

/** The phone's default language as a two-letter code (the translation target). */
export function deviceLanguage(): string {
  if (!global.isAndroid) return "en";
  try {
    return String(java.util.Locale.getDefault().getLanguage() || "en");
  } catch {
    return "en";
  }
}

function successListener(resolve: (value: any) => void): any {
  return new com.google.android.gms.tasks.OnSuccessListener({
    onSuccess: (result: any) => resolve(result),
  });
}

function failureListener(reject: (reason: Error) => void): any {
  return new com.google.android.gms.tasks.OnFailureListener({
    onFailure: (error: any) => reject(new Error(String(error?.getMessage?.() ?? error))),
  });
}

/**
 * Identify the language of a caption line. Resolves to a BCP-47 code, or
 * "und" when ML Kit isn't confident. Short lines are noisy; callers should
 * apply hysteresis across consecutive finals before switching languages.
 */
export function identifyLanguage(text: string): Promise<string> {
  if (!global.isAndroid || !text.trim()) return Promise.resolve("und");
  return new Promise((resolve) => {
    try {
      if (!languageIdentifier) {
        languageIdentifier = com.google.mlkit.nl.languageid.LanguageIdentification.getClient();
      }
      languageIdentifier
        .identifyLanguage(text)
        .addOnSuccessListener(successListener((code: any) => resolve(String(code))))
        .addOnFailureListener(failureListener(() => resolve("und")));
    } catch (error) {
      console.warn(`language id failed: ${error}`);
      resolve("und");
    }
  });
}

function translatorFor(sourceLang: string, targetLang: string): any | null {
  const key = `${sourceLang}>${targetLang}`;
  const cached = translators.get(key);
  if (cached) return cached;
  try {
    const TranslateLanguage = com.google.mlkit.nl.translate.TranslateLanguage;
    const source = TranslateLanguage.fromLanguageTag(sourceLang);
    const target = TranslateLanguage.fromLanguageTag(targetLang);
    if (source == null || target == null) return null;
    const options = new com.google.mlkit.nl.translate.TranslatorOptions.Builder()
      .setSourceLanguage(source)
      .setTargetLanguage(target)
      .build();
    const translator = com.google.mlkit.nl.translate.Translation.getClient(options);
    translators.set(key, translator);
    return translator;
  } catch (error) {
    console.warn(`translator setup failed (${key}): ${error}`);
    return null;
  }
}

/**
 * Translate one caption line. Resolves to the translated text, or "" when the
 * pair is unsupported or the model download hasn't finished (translation of
 * later lines picks up once it has; downloads are WiFi-unrestricted since
 * caption sessions are live).
 */
export function translateText(text: string, sourceLang: string, targetLang: string): Promise<string> {
  if (!global.isAndroid || !text.trim() || sourceLang === targetLang) {
    return Promise.resolve("");
  }
  const translator = translatorFor(sourceLang, targetLang);
  if (!translator) return Promise.resolve("");
  const key = `${sourceLang}>${targetLang}`;
  return new Promise((resolve) => {
    const runTranslate = () => {
      translator
        .translate(text)
        .addOnSuccessListener(successListener((result: any) => resolve(String(result))))
        .addOnFailureListener(failureListener(() => resolve("")));
    };
    if (downloadedPairs.has(key)) {
      runTranslate();
      return;
    }
    try {
      const conditions = new com.google.mlkit.common.model.DownloadConditions.Builder().build();
      translator
        .downloadModelIfNeeded(conditions)
        .addOnSuccessListener(
          successListener(() => {
            downloadedPairs.add(key);
            runTranslate();
          }),
        )
        .addOnFailureListener(failureListener(() => resolve("")));
    } catch (error) {
      console.warn(`translation model download failed (${key}): ${error}`);
      resolve("");
    }
  });
}
