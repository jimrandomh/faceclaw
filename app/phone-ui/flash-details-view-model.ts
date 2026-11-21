import { Observable } from "@nativescript/core";

type Visibility = "visible" | "collapse";

const DERIVED = ["detailsToggleLabel", "detailsToggleVisibility", "detailsVisibility", "progressDetailVisibility", "logVisibility"] as const;

/**
 * What the flash page keeps behind its Show Details expander, for the G2 and G1 view models alike: the timestamped
 * log, and progress too fine-grained to be worth reading unless something looks stuck. The expander appears once
 * there is something behind it, and stays as the user left it through later phases and retries.
 */
export abstract class FlashDetailsViewModel extends Observable {
  log = "";
  progressDetail = "";
  private detailsExpanded = false;

  get detailsToggleLabel(): string {
    return this.detailsExpanded ? "Hide Details" : "Show Details";
  }

  get detailsToggleVisibility(): Visibility {
    return this.log || this.progressDetail ? "visible" : "collapse";
  }

  get detailsVisibility(): Visibility {
    return this.detailsExpanded ? this.detailsToggleVisibility : "collapse";
  }

  get progressDetailVisibility(): Visibility {
    return this.progressDetail ? "visible" : "collapse";
  }

  get logVisibility(): Visibility {
    return this.log ? "visible" : "collapse";
  }

  onToggleDetailsTap(): void {
    this.detailsExpanded = !this.detailsExpanded;
    this.notifyDetails();
  }

  protected appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.setDetail("log", this.log ? `${this.log}\n[${stamp}] ${line}` : `[${stamp}] ${line}`);
  }

  protected clearLog(): void {
    this.setDetail("log", "");
  }

  protected setProgressDetail(text: string): void {
    this.setDetail("progressDetail", text);
  }

  private setDetail(name: "log" | "progressDetail", value: string): void {
    if (this[name] === value) return;
    this[name] = value;
    this.notifyPropertyChange(name, value);
    this.notifyDetails();
  }

  private notifyDetails(): void {
    for (const property of DERIVED) this.notifyPropertyChange(property, this[property]);
  }
}
