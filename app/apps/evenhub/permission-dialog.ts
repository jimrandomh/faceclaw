import { truncateText, wrapText } from "../../graphics/textwrap";
import { type LayerContext } from "../../ui/layers";
import { permissionDetail, permissionLabel, type EvenHubPermission } from "./permissions";
import { openPrivacyPolicyOnPhone } from "./privacy-policy";
import { lineStep } from "../../ui/metrics";
import { ScrollingDialogLayer, type DialogBody, type DialogRow } from "./scrolling-dialog";

const DIALOG_WIDTH = 320;
const PERM_GAP = 4;

/**
 * Confirmation dialog listing the permissions an EvenHub app declares, shown
 * before installing it or running an uninstalled package. Allow proceeds;
 * Cancel (or double-click) backs out. A privacy-policy-only app still reaches
 * this dialog so the user can review the policy before allowing first run.
 *
 * A long list scrolls a page at a time, and Allow stays inert until the
 * bottom has been reached (see ScrollingDialogLayer), so the user can't
 * Allow without having had the whole list on screen.
 */
export class EvenHubPermissionDialogLayer extends ScrollingDialogLayer {
  constructor(
    private readonly appName: string,
    private readonly permissions: EvenHubPermission[],
    private readonly privacyPolicyUrl: string,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {
    super(DIALOG_WIDTH);
  }

  protected bodyRows({ image, font, left, textWidth }: DialogBody): DialogRow[] {
    const headerStep = lineStep(font) + 2;
    const permLabelStep = lineStep(font) + 1;
    const permDetailStep = lineStep(font) - 1;
    const rows: DialogRow[] = [];
    const heading = this.permissions.length ? `${this.appName} needs:` : `${this.appName} is ready to run`;
    rows.push({
      height: headerStep + 6,
      draw: (top) => image.drawText(font, left, top, truncateText(font, heading, textWidth), 235),
    });
    if (this.permissions.length === 0) {
      rows.push({
        height: permLabelStep + PERM_GAP + 2,
        draw: (top) => image.drawText(font, left, top, "No special permissions requested.", 140),
      });
    }
    for (let index = 0; index < this.permissions.length; index++) {
      const permission = this.permissions[index]!;
      const detail = permissionDetail(permission);
      // One row per wrapped line, so the explanation scrolls line by line.
      const detailLines = detail ? wrapText(font, detail, textWidth - 8) : [];
      const gapBelow = PERM_GAP + (index === this.permissions.length - 1 ? 2 : 0);
      rows.push({
        height: permLabelStep + (detailLines.length ? 0 : gapBelow),
        draw: (top) => image.drawText(font, left, top, truncateText(font, permissionLabel(permission.name), textWidth), 220),
      });
      for (let line = 0; line < detailLines.length; line++) {
        rows.push({
          height: permDetailStep + (line === detailLines.length - 1 ? gapBelow : 0),
          draw: (top) => image.drawText(font, left + 8, top, detailLines[line]!, 140),
        });
      }
    }
    return rows;
  }

  protected actions(): string[] {
    return this.privacyPolicyUrl ? ["Allow", "Privacy policy", "Cancel"] : ["Allow", "Cancel"];
  }

  protected activate(action: string, ctx: LayerContext): void {
    if (action === "Privacy policy") {
      openPrivacyPolicyOnPhone(this.privacyPolicyUrl, this.appName);
    } else if (action === "Allow") {
      this.close(ctx, () => this.onConfirm());
    } else {
      this.close(ctx, () => this.onCancel());
    }
  }

  protected backedOut(): void {
    this.onCancel();
  }

  protected abandoned(): void {
    this.onCancel();
  }
}
