import { wrapText, truncateText } from "../../graphics/textwrap";
import { fontSelectionLabel, getDefaultSmallFont, getUiFontSelection } from "../../graphics/ui-fonts";
import { GrayImage, type UiFont } from "../../graphics/image";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { MenuLayer, type MenuLayout } from "../../ui/menu";

/**
 * Unicode test: sample texts chosen to exercise text-rendering features that
 * need special support beyond one-glyph-per-codepoint left-to-right layout.
 * Each sample is rendered with the user's configured UI font so gaps (tofu,
 * unshaped Arabic, misplaced combining marks, reversed RTL runs, missing CJK
 * coverage) show up the way they would in real app content.
 *
 * Every sample lists what it exercises so a tester knows what "correct" looks
 * like without reading this file.
 */
export type UnicodeSample = {
  /** Menu label: the language, with the feature in parentheses. */
  label: string;
  /** What a correct rendering has to get right, shown under the title. */
  exercises: string;
  /** The text itself; paragraphs separated by "\n". */
  text: string;
};

// Sentences are mostly Article 1 of the Universal Declaration of Human Rights
// (the same passage in every language, so a tester who knows one can compare
// line lengths and shapes across scripts), plus a pangram or two.
export const UNICODE_SAMPLES: readonly UnicodeSample[] = [
  {
    label: "English (ligatures)",
    exercises: "fi/fl/ff pairs stay separate glyphs; kerning (AV, To, Wa)",
    text:
      "All human beings are born free and equal in dignity and rights. They are endowed with reason and conscience and should act towards one another in a spirit of brotherhood.\n" +
      "Ligature pairs: office affluent waffle fjord shuffle difficult\n" +
      "Kerning pairs: AVATAR Toward Wavy LTA. Yo Te Ty\n" +
      "The quick brown fox jumps over the lazy dog. 0123456789",
  },
  {
    label: "French (precomposed accents)",
    exercises: "é è ê ç œ æ ù as single precomposed codepoints",
    text:
      "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.\n" +
      "Portez ce vieux whisky au juge blond qui fume. Œuvre, cœur, æther, à côté, où, naïve, Noël.",
  },
  {
    label: "German / Polish / Turkish",
    exercises: "ß ä ö ü; ą ę ł ń ś ź ż; dotted İ and dotless ı",
    text:
      "Falsches Üben von Xylophonmusik quält jeden größeren Zwerg. Straße, Fußgänger, Ärger, Öl, Übung.\n" +
      "Pchnąć w tę łódź jeża lub ośm skrzyń fig. Zażółć gęślą jaźń.\n" +
      "Pijamalı hasta yağız şoföre çabucak güvendi. İstanbul, ılık, Iğdır, iyi.",
  },
  {
    label: "Vietnamese (stacked marks)",
    exercises: "tone mark above a vowel that already has a diacritic (ấ ệ ở ữ)",
    text:
      "Tất cả mọi người sinh ra đều được tự do và bình đẳng về nhân phẩm và quyền lợi. Mọi con người đều được tạo hóa ban cho lý trí và lương tâm và cần phải đối xử với nhau trong tình bằng hữu.\n" +
      "Tiếng Việt: Hà Nội, Huế, Đà Nẵng, Sài Gòn. ấ ầ ẩ ẫ ậ ế ề ể ễ ệ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ ứ ừ ử ữ ự",
  },
  {
    label: "Combining marks (decomposed)",
    exercises: "base letter + separate combining accent must overlay, not advance",
    text:
      // Written with explicit combining codepoints (no String.normalize, so
      // the sample is the same on every JS engine).
      "Decomposed: café naïve résumé Việt Nam Saõ Paulo\n" +
      "Precomposed: café naïve résumé Việt Nam São Paulo\n" +
      "Both lines should look identical.\n" +
      "Stacked: à́̂ ë̄ ô̧ ñ́ ů̈\n" +
      "Marks with no base: ́ ̈ ̧ (should attach to nothing, or a dotted circle)",
  },
  {
    label: "Greek",
    exercises: "Greek alphabet with tonos/dialytika; final sigma ς vs σ",
    text:
      "Όλοι οι άνθρωποι γεννιούνται ελεύθεροι και ίσοι στην αξιοπρέπεια και τα δικαιώματα. Είναι προικισμένοι με λογική και συνείδηση, και οφείλουν να συμπεριφέρονται μεταξύ τους με πνεύμα αδελφοσύνης.\n" +
      "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία. ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ αβγδεζηθικλμνξοπρσςτυφχψω",
  },
  {
    label: "Russian (Cyrillic)",
    exercises: "Cyrillic coverage incl. й ё ъ ь; italic-free shapes",
    text:
      "Все люди рождаются свободными и равными в своем достоинстве и правах. Они наделены разумом и совестью и должны поступать в отношении друг друга в духе братства.\n" +
      "Съешь же ещё этих мягких французских булок, да выпей чаю. АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ",
  },
  {
    label: "Arabic (RTL, joining)",
    exercises: "right-to-left; letters take initial/medial/final forms; lam-alef لا ligature",
    text:
      "يولد جميع الناس أحرارًا متساوين في الكرامة والحقوق. وقد وهبوا عقلاً وضميرًا وعليهم أن يعامل بعضهم بعضًا بروح الإخاء.\n" +
      "السلام عليكم. العربية لغة جميلة.\n" +
      "Arabic-Indic digits: ٠١٢٣٤٥٦٧٨٩ and Persian: پ چ ژ گ",
  },
  {
    label: "Hebrew (RTL, niqqud)",
    exercises: "right-to-left; vowel points (niqqud) below/inside letters; final forms ך ם ן ף ץ",
    text:
      "כל בני אדם נולדו בני חורין ושווים בערכם ובזכויותיהם. כולם חוננו בתבונה ובמצפון, לפיכך חובה עליהם לנהוג איש ברעהו ברוח של אחוה.\n" +
      "With niqqud: שָׁלוֹם עוֹלָם. בְּרֵאשִׁית בָּרָא אֱלֹהִים\n" +
      "Final forms: מלך שלום דין סוף ארץ",
  },
  {
    label: "Bidirectional (mixed)",
    exercises: "RTL runs inside LTR lines and vice versa; numbers and punctuation keep their side",
    text:
      "The Hebrew word שלום means peace, and the Arabic word سلام means the same.\n" +
      "Price: 120 ש\"ח (about $32) — call 555-1234.\n" +
      "מספר הטלפון שלי הוא 052-1234567, ואני גר ב-Tel Aviv.\n" +
      "أعيش في London منذ 5 سنوات.\n" +
      "Nested: he said \"مرحبا (hello) بكم\" and left.",
  },
  {
    label: "Hindi (Devanagari)",
    exercises: "conjuncts (क्ष त्र ज्ञ), vowel sign ि drawn BEFORE its consonant, headline bar",
    text:
      "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता और समानता प्राप्त है। उन्हें बुद्धि और अन्तरात्मा की देन प्राप्त है और परस्पर उन्हें भाईचारे के भाव से बर्ताव करना चाहिए।\n" +
      "Reordering: कि (ka + i) की (ka + ii) दिल्ली हिन्दी\n" +
      "Conjuncts: क्ष त्र ज्ञ द्ध श्र प्र स्त्री",
  },
  {
    label: "Thai (no spaces, stacked)",
    exercises: "no inter-word spaces (wrap by syllable); vowels and tone marks stack above/below",
    text:
      "มนุษย์ทั้งหลายเกิดมามีอิสระและเสมอภาคกันในเกียรติศักดิ์และสิทธิ ต่างมีเหตุผลและมโนธรรม และควรปฏิบัติต่อกันด้วยเจตนารมณ์แห่งภราดรภาพ\n" +
      "สวัสดีครับ ภาษาไทย กรุงเทพมหานคร\n" +
      "Stacked marks: ปั้น ที่ กี้ น้ำ ป์ ฐ์",
  },
  {
    label: "Chinese (Simplified)",
    exercises: "CJK coverage; full-width punctuation ，。；wrapping between any two characters",
    text:
      "人人生而自由，在尊严和权利上一律平等。他们赋有理性和良心，并应以兄弟关系的精神相对待。\n" +
      "你好，世界！中文测试。繁體：臺灣、香港、澳門。\n" +
      "Mixed: 我有 3 个 apples 和 2 个 oranges。",
  },
  {
    label: "Japanese (kana + kanji)",
    exercises: "hiragana, katakana, kanji, half-width katakana ｶﾀｶﾅ, long vowel mark ー",
    text:
      "すべての人間は、生れながらにして自由であり、かつ、尊厳と権利とについて平等である。人間は、理性と良心とを授けられており、互いに同胞の精神をもって行動しなければならない。\n" +
      "いろはにほへと ちりぬるを。コンピューター、テレビ、ゲーム。\n" +
      "半角カナ: ｺﾝﾋﾟｭｰﾀｰ  全角英数: ＡＢＣ１２３",
  },
  {
    label: "Korean (Hangul)",
    exercises: "precomposed syllables; conjoining jamo (ㅎㅏㄴ) should compose to 한",
    text:
      "모든 인간은 태어날 때부터 자유로우며 그 존엄과 권리에 있어 동등하다. 인간은 천부적으로 이성과 양심을 부여받았으며 서로 형제애의 정신으로 행동하여야 한다.\n" +
      "안녕하세요, 세계! 한국어 테스트.\n" +
      "Jamo: 한 (= 한)  Compatibility jamo: ㅎ ㅏ ㄴ",
  },
  {
    label: "Emoji (ZWJ, modifiers)",
    exercises: "color emoji as monochrome; skin-tone modifiers, ZWJ families, flag pairs, VS16 render as ONE glyph",
    text:
      "Basic: 😀 👍 ❤ ☀ ★\n" +
      "Variation selector: ❤️ ☀️ ✈️ (same as above but VS16)\n" +
      "Skin tone: 👍🏻 👍🏽 👍🏿 👋🏾\n" +
      "ZWJ: 👨‍👩‍👧‍👦 👩‍💻 🏳️‍🌈\n" +
      "Flags: 🇯🇵 🇺🇸 🇩🇪 🇧🇷\n" +
      "Keycaps: 1️⃣ #️⃣",
  },
  {
    label: "Symbols & misc",
    exercises: "math, arrows, box drawing, currency, non-BMP (astral) codepoints",
    text:
      "Math: ∑ ∫ √ ∞ ≠ ≤ ≥ ± × ÷ π θ λ\n" +
      "Arrows: ← ↑ → ↓ ↔ ⇒ ⇔\n" +
      "Box: ┌─┬─┐ │ │ │ ├─┼─┤ └─┴─┘ ▲▼● ░▒▓█\n" +
      "Currency: $ € £ ¥ ₹ ₩ ₪ ¢\n" +
      "Astral: 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝕳𝖊𝖑𝖑𝖔 𐐀𐐁 🜁🜂\n" +
      "Zero-width: a​b (ZWSP) c‍d (ZWJ) e⁠f (WJ) should read as ab cd ef",
  },
];

const MARGIN_X = 18;
const TITLE_Y = 8;
const FOOTER_MARGIN = 20;
const BODY_GAP = 6;

/**
 * Shows one Unicode sample wrapped to the page, with the feature under test
 * under the title and the current font in the footer. Scroll pages through
 * the text; double-click goes back to the language list.
 */
export class UnicodeSampleLayer implements Layer {
  private lines: string[] | null = null;
  private wrappedForWidth = 0;
  private wrappedWithFont = 0;
  private firstLine = 0;
  private bodyLineCount = 1;

  constructor(private readonly sample: UnicodeSample) {}

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const textWidth = width - 2 * MARGIN_X;

    image.drawText(font, MARGIN_X, TITLE_Y, truncateText(font, this.sample.label, textWidth), 220);
    const noteY = TITLE_Y + font.lineHeight;
    const noteLines = wrapText(font, this.sample.exercises, textWidth);
    for (let i = 0; i < noteLines.length; i++) {
      image.drawText(font, MARGIN_X, noteY + i * font.lineHeight, noteLines[i]!, 120);
    }

    const bodyY = noteY + noteLines.length * font.lineHeight + BODY_GAP;
    const footerY = height - FOOTER_MARGIN;
    this.bodyLineCount = Math.max(1, Math.floor((footerY - bodyY) / font.lineHeight));

    const lines = this.getLines(font, textWidth);
    this.clampScroll(lines.length);
    const visible = lines.slice(this.firstLine, this.firstLine + this.bodyLineCount);
    for (let i = 0; i < visible.length; i++) {
      image.drawText(font, MARGIN_X, bodyY + i * font.lineHeight, visible[i]!, 235);
    }

    const page = Math.floor(this.firstLine / this.pageStep()) + 1;
    image.drawText(font, MARGIN_X, footerY, `Page ${page}/${this.pageCount(lines.length)}`, 110);
    const fontLabel = fontSelectionLabel(getUiFontSelection());
    image.drawText(font, width - MARGIN_X - font.measureText(fontLabel), footerY, fontLabel, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-down":
        this.firstLine += this.pageStep();
        return;
      case "scroll-up":
        this.firstLine = Math.max(0, this.firstLine - this.pageStep());
        return;
      case "double-click":
        ctx.stack.pop();
        return;
    }
  }

  private pageStep(): number {
    return Math.max(1, this.bodyLineCount - 1);
  }

  private clampScroll(lineCount: number): void {
    if (lineCount <= this.bodyLineCount) {
      this.firstLine = 0;
      return;
    }
    const lastPageStart = (this.pageCount(lineCount) - 1) * this.pageStep();
    this.firstLine = Math.max(0, Math.min(lastPageStart, this.firstLine));
  }

  private pageCount(lineCount: number): number {
    if (lineCount <= this.bodyLineCount) return 1;
    return Math.ceil((lineCount - this.bodyLineCount) / this.pageStep()) + 1;
  }

  private getLines(font: UiFont, width: number): string[] {
    if (this.lines === null || this.wrappedForWidth !== width || this.wrappedWithFont !== font.fingerprintId) {
      // breakLongWords: CJK and Thai have no spaces to wrap at.
      this.lines = wrapText(font, this.sample.text, width, { breakLongWords: true });
      this.wrappedForWidth = width;
      this.wrappedWithFont = font.fingerprintId;
    }
    return this.lines;
  }
}

/** The language list; selecting a row opens its sample. */
export function unicodeTestMenu(layout: MenuLayout): MenuLayer {
  return new MenuLayer(
    "Unicode test",
    UNICODE_SAMPLES.map((sample) => ({
      label: sample.label,
      onSelect: (ctx) => {
        ctx.stack.push(new UnicodeSampleLayer(sample));
      },
    })),
    layout,
  );
}
