import { wrapText } from "../../graphics/textwrap";
import { type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { ScrollingDialogLayer, type DialogBody, type DialogRow } from "./scrolling-dialog";

/** Wider than the permission dialog: the RayNeo iO's window is short, so fewer, longer lines fit better. */
const DIALOG_WIDTH = 420;

/**
 * Shown over an EvenHub app the first time it runs with a RayNeo iO paired
 * (see glasses-compat.ts): the app is made for Even Realities glasses and
 * won't display correctly on the iO's screen. The app starts underneath.
 * Continue (or double-click) dismisses the warning; Close app closes the
 * app's window. Either answer counts as having seen it; a window closed with
 * the warning still up shows it again next time.
 */
export class EvenHubDisplayWarningLayer extends ScrollingDialogLayer {
  constructor(
    private readonly appName: string,
    private readonly onAnswered: () => void,
    private readonly closeApp: () => void,
  ) {
    super(DIALOG_WIDTH);
  }

  protected bodyRows({ image, font, left, textWidth }: DialogBody): DialogRow[] {
    const step = lineStep(font);
    const rows: DialogRow[] = [];
    for (const line of wrapText(font, "Compatibility warning", textWidth)) {
      rows.push({ height: step + 2, draw: (top) => image.drawText(font, left, top, line, 235) });
    }
    rows[rows.length - 1]!.height += 6;
    const message =
      `${this.appName} is an EvenHub app, made for Even Realities glasses. It will not display correctly ` +
      "on the RayNeo iO, because the iO's screen has a different resolution.";
    // One row per wrapped line, so a large font scrolls line by line.
    const lines = wrapText(font, message, textWidth);
    for (let index = 0; index < lines.length; index++) {
      rows.push({
        height: step + (index === lines.length - 1 ? 8 : 0),
        draw: (top) => image.drawText(font, left, top, lines[index]!, 190),
      });
    }
    return rows;
  }

  protected actions(): string[] {
    return ["Continue", "Close app"];
  }

  protected activate(action: string, ctx: LayerContext): void {
    this.close(ctx, () => {
      this.onAnswered();
      if (action === "Close app") this.closeApp();
    });
  }

  protected backedOut(): void {
    this.onAnswered();
  }

  protected abandoned(): void {
    // Not answered: the next launch shows it again.
  }
}
