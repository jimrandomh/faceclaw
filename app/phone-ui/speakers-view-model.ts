import { Frame, Observable, action, alert, confirm, prompt } from "@nativescript/core";

import { speakerRegistry, type SpeakerProfile } from "../apps/microphones/speakers";
import { formatDateTime } from "./conversation-format";

/** One speaker row; tap handler rides on the item itself (see pairing-view-model). */
export type SpeakerRowItem = {
  name: string;
  tag: string;
  tagVisibility: "visible" | "collapse";
  wearerVisibility: "visible" | "collapse";
  swatchColor: string;
  meta: string;
  onRowTap: () => void;
};

const PRESET_COLORS: Array<{ label: string; hex: string }> = [
  { label: "Sky", hex: "#4FC3F7" },
  { label: "Amber", hex: "#FFB74D" },
  { label: "Green", hex: "#81C784" },
  { label: "Red", hex: "#E57373" },
  { label: "Purple", hex: "#BA68C8" },
  { label: "Yellow", hex: "#FFD54F" },
  { label: "Teal", hex: "#4DB6AC" },
  { label: "Pink", hex: "#F06292" },
  { label: "Brown", hex: "#A1887F" },
  { label: "Gray", hex: "#90A4AE" },
];

export class SpeakersViewModel extends Observable {
  private _speakerRows: SpeakerRowItem[] = [];
  private _emptyMessage = "";

  get speakerRows(): SpeakerRowItem[] {
    return this._speakerRows;
  }

  get emptyMessage(): string {
    return this._emptyMessage;
  }

  get emptyVisibility(): "visible" | "collapse" {
    return this._emptyMessage ? "visible" : "collapse";
  }

  reload(): void {
    if (!global.isAndroid) {
      this.setRows([], "Speaker management is only available on Android.");
      return;
    }
    speakerRegistry.reload();
    const profiles = speakerRegistry.all();
    this.setRows(
      profiles.map((profile) => this.toRowItem(profile)),
      profiles.length > 0
        ? ""
        : "No speakers yet — voices are enrolled automatically while Captions + Save captions run in the Microphones app on the glasses.",
    );
  }

  private setRows(rows: SpeakerRowItem[], emptyMessage: string): void {
    this._speakerRows = rows;
    this._emptyMessage = emptyMessage;
    this.notifyPropertyChange("speakerRows", rows);
    this.notifyPropertyChange("emptyMessage", emptyMessage);
    this.notifyPropertyChange("emptyVisibility", this.emptyVisibility);
  }

  private toRowItem(profile: SpeakerProfile): SpeakerRowItem {
    const metaParts: string[] = [];
    if (profile.lastHeardAt > 0) metaParts.push(`Last heard ${formatDateTime(profile.lastHeardAt)}`);
    metaParts.push(`${profile.segmentCount} lines`);
    return {
      name: profile.name,
      tag: profile.tag,
      tagVisibility: profile.tag ? "visible" : "collapse",
      wearerVisibility: profile.isWearer ? "visible" : "collapse",
      swatchColor: profile.color || "#90A4AE",
      meta: metaParts.join(" · "),
      onRowTap: () => {
        void this.onSpeakerTap(profile.id);
      },
    };
  }

  private async onSpeakerTap(speakerId: number): Promise<void> {
    const profile = speakerRegistry.byId(speakerId);
    if (!profile) return;
    const choice = await action({
      title: profile.name,
      cancelButtonText: "Cancel",
      actions: [
        "View insights",
        "Rename",
        "Set tag",
        "Set color",
        "Set as my voice",
        "Merge into...",
        "View conversations",
        "Delete",
      ],
    });
    switch (choice) {
      case "View insights":
        await this.viewInsights(profile);
        break;
      case "Rename":
        await this.renameSpeaker(profile);
        break;
      case "Set tag":
        await this.setSpeakerTag(profile);
        break;
      case "Set color":
        await this.setSpeakerColor(profile);
        break;
      case "Set as my voice":
        speakerRegistry.setWearer(profile.id, true);
        this.reload();
        break;
      case "Merge into...":
        await this.mergeSpeaker(profile);
        break;
      case "View conversations":
        Frame.topmost()?.navigate({
          moduleName: "phone-ui/conversations-page",
          context: { speakerId: profile.id },
        });
        break;
      case "Delete":
        await this.deleteSpeaker(profile);
        break;
    }
  }

  /** The contact's conversation memory: last heard, recap, action items, facts. */
  private async viewInsights(profile: SpeakerProfile): Promise<void> {
    const parts: string[] = [];
    if (profile.lastHeardAt > 0) parts.push(`Last heard ${formatDateTime(profile.lastHeardAt)}.`);
    if (profile.lastRecap) parts.push(`Last conversation: ${profile.lastRecap}`);
    if (profile.actionItems.length) {
      parts.push(`Action items:\n${profile.actionItems.map((item) => `• ${item}`).join("\n")}`);
    }
    if (profile.facts.length) {
      parts.push(`Facts:\n${profile.facts.map((fact) => `• ${fact}`).join("\n")}`);
    }
    if (!profile.lastRecap && !profile.actionItems.length && !profile.facts.length) {
      parts.push(
        "No conversation insights yet — they are generated on-device when a captioned " +
          "conversation with this person ends (requires the downloaded assistant model).",
      );
    }
    await alert({
      title: profile.name,
      message: parts.join("\n\n"),
      okButtonText: "Close",
    });
  }

  private async renameSpeaker(profile: SpeakerProfile): Promise<void> {
    const result = await prompt({
      title: "Rename speaker",
      defaultText: profile.name,
      okButtonText: "Rename",
      cancelButtonText: "Cancel",
    });
    const name = result.result ? result.text.trim() : "";
    if (!name || name === profile.name) return;
    speakerRegistry.rename(profile.id, name);
    this.reload();
  }

  private async setSpeakerTag(profile: SpeakerProfile): Promise<void> {
    const result = await prompt({
      title: "Set tag",
      message: "A short label like \"work\", \"family\", or \"neighbor\".",
      defaultText: profile.tag,
      okButtonText: "Save",
      cancelButtonText: "Cancel",
    });
    if (!result.result) return;
    speakerRegistry.setTag(profile.id, result.text.trim());
    this.reload();
  }

  private async setSpeakerColor(profile: SpeakerProfile): Promise<void> {
    const picked = await action({
      title: "Set color",
      cancelButtonText: "Cancel",
      actions: PRESET_COLORS.map((color) => `${color.label} (${color.hex})`),
    });
    const chosen = PRESET_COLORS.find((color) => `${color.label} (${color.hex})` === picked);
    if (!chosen) return;
    speakerRegistry.setColor(profile.id, chosen.hex);
    this.reload();
  }

  private async mergeSpeaker(profile: SpeakerProfile): Promise<void> {
    const others = speakerRegistry.all().filter((candidate) => candidate.id !== profile.id);
    if (others.length === 0) return;
    const picked = await action({
      title: "Merge into...",
      message: `${profile.name}'s lines and voice-print will move to the speaker you pick.`,
      cancelButtonText: "Cancel",
      actions: others.map((candidate) => candidate.name),
    });
    const target = others.find((candidate) => candidate.name === picked);
    if (!target) return;
    const confirmed = await confirm({
      title: "Merge speakers",
      message: `Merge ${profile.name} into ${target.name}? This cannot be undone.`,
      okButtonText: "Merge",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) return;
    speakerRegistry.merge(profile.id, target.id);
    this.reload();
  }

  private async deleteSpeaker(profile: SpeakerProfile): Promise<void> {
    const confirmed = await confirm({
      title: "Delete speaker",
      message: `Delete ${profile.name}? Their transcript lines stay but lose the speaker label.`,
      okButtonText: "Delete",
      cancelButtonText: "Cancel",
    });
    if (!confirmed) return;
    speakerRegistry.remove(profile.id);
    this.reload();
  }
}
