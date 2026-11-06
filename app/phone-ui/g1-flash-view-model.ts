import { Frame, Observable } from "@nativescript/core";

import { G1ArmScanner } from "../g1/arm-scanner";
import { G1V0_IMAGE } from "../g1/firmware/g1v0-image";
import { buildG1Firmware, type BuiltG1Firmware, type G1BuildProgress } from "../g1/firmware-builder";
import { saveG1Arm, saveG1Pair } from "../g1/addresses";
import { G1_CASE_INSTRUCTIONS, G1_INSTALL_NOTICE, G1_SIDES, g1FlashPercent, type G1FlashResult, type G1Side } from "../g1/flash-plan";
import { loadDeviceAddresses, loadPairedGlassesIdentity } from "../g2/device-addresses";
import { downloadAndExtractEvenHubFonts, hasExtractedEvenHubFonts } from "../g2/firmware-builder";
import { type GlassesPairCandidate } from "../g2/pairing-candidates";
import { resumeAutoReconnect, suppressAutoReconnect } from "../g2/reconnect-policy";
import { ensureBlePermissions } from "../native/ble-permissions";
import { G1Flasher, type G1FlasherOptions } from "../native/g1-flasher";
import { formatErrorMessage } from "../util/format-error";
import { finishOnboardingNavigation } from "./onboarding-navigation";
import { setOnboardingCompleted, setPreviewOnlyMode } from "./onboarding-state";

type Phase = "intro" | "preparing" | "flashing" | "flashed" | "error" | "unavailable";

const LOCATE_MS = 45_000;
/** An arm takes about 20 s to copy the image, and a hung boot resets itself within two minutes. */
const RETURN_MS = 240_000;
const CONNECT_MS = 60_000;
/** A new arm pairs only once it knows it's in the case, which a full case can take a while to tell it. */
const FIRST_PAIRING_MS = 120_000;

/**
 * The install page on a G1, in place of OnboardingFlashViewModel. The two arms are separate devices that each take the
 * image over MCUmgr (G1ArmFlashFlow), left first. There is nothing on the lens to confirm with before g1v0 is on the arm,
 * so the confirmation is on the phone: the page before, or this one's intro.
 *
 * Every run starts by listening for what each arm runs now, so a retry picks up wherever the last one stopped. An arm's
 * new address is saved as soon as it's known.
 */
export class G1FlashViewModel extends Observable {
  private phase: Phase = "intro";
  private readonly fromOnboarding: boolean;
  private readonly scanner = new G1ArmScanner();
  private image: BuiltG1Firmware | null = null;
  private flasher: G1Flasher | null = null;
  private generation = 0;
  private disposed = false;
  private unpairedArm = false;

  headline = "Install Faceclaw's Firmware";
  status = "";
  log = "";
  busy = false;
  progress = 0;

  constructor(options?: { mode?: "install" | "uninstall"; fromOnboarding?: boolean; autoStart?: boolean }) {
    super();
    this.fromOnboarding = options?.fromOnboarding ?? true;
    if (options?.mode === "uninstall") {
      // Restoring Even's firmware has never been run on a real arm, and an arm whose network core is older than the
      // image may not come back, so the phone doesn't offer it yet.
      this.phase = "unavailable";
      this.headline = "Back to Even's Firmware";
      this.status = "Faceclaw can't restore Even's firmware on a G1 yet. It takes a computer: see \"Restore Even's firmware\" in " +
        "the ScouterKit firmware's README.";
      return;
    }
    suppressAutoReconnect();
    this.status = `${G1_CASE_INSTRUCTIONS}\n\n${G1_INSTALL_NOTICE}`;
    if (options?.autoStart) void this.run();
  }

  // --- what the page binds --------------------------------------------------

  get logVisibility(): "visible" | "collapse" {
    return this.log ? "visible" : "collapse";
  }

  get busyVisibility(): "visible" | "collapse" {
    return this.busy ? "visible" : "collapse";
  }

  get progressVisibility(): "visible" | "collapse" {
    return this.phase === "flashing" ? "visible" : "collapse";
  }

  get primaryLabel(): string {
    switch (this.phase) {
      case "intro":
        return "Install";
      case "flashed":
        return "Finish";
      case "error":
        return "Retry";
      default:
        return "";
    }
  }

  get primaryVisibility(): "visible" | "collapse" {
    return this.primaryLabel ? "visible" : "collapse";
  }

  get secondaryLabel(): string {
    return "Back";
  }

  get secondaryVisibility(): "visible" | "collapse" {
    // No way out mid-install, or after one.
    return this.phase === "preparing" || this.phase === "flashing" || this.phase === "flashed" ? "collapse" : "visible";
  }

  onPrimaryTap(): void {
    if (this.phase === "intro" || this.phase === "error") void this.run();
    else if (this.phase === "flashed") this.finish();
  }

  onSecondaryTap(): void {
    if (this.phase === "intro" || this.phase === "error" || this.phase === "unavailable") this.leave();
  }

  // --- the install ----------------------------------------------------------

  private async run(): Promise<void> {
    const generation = ++this.generation;
    const live = () => !this.disposed && generation === this.generation;
    this.setPhase("preparing");
    this.setBusy(true);
    this.setText("Preparing Firmware", "Getting the firmware ready...");
    try {
      await ensureBlePermissions();
      if (!live()) return;
      if (!this.image) {
        this.image = await buildG1Firmware((progress) => {
          if (live()) this.setStatus(describeBuild(progress));
        });
        this.appendLog(`firmware ${this.image.version} prepared and verified (${this.image.bytes.toLocaleString()} bytes)`);
      }
      await this.prepareFonts(live);
      if (!live()) return;

      this.setPhase("flashing");
      this.setText("Installing Firmware", "Listening for your glasses...");
      const identity = loadPairedGlassesIdentity();
      const stored = loadDeviceAddresses();
      const pair = await this.scanner.waitForPair({ serial: identity?.serial, left: stored.left, right: stored.right }, LOCATE_MS);
      if (!live()) return;
      if (!pair) {
        throw new Error("Couldn't hear both arms of your glasses. Make sure they're in the case with the lid open, and that no other app " +
          "or phone is connected to them, then retry.");
      }
      saveG1Pair(pair);

      this.unpairedArm = false;
      for (const side of G1_SIDES) {
        await this.installArm(side, pair, live);
        if (!live()) return;
      }
      this.finished();
    } catch (error) {
      if (live()) this.failed(formatErrorMessage(error));
    }
  }

  private async installArm(side: G1Side, pair: GlassesPairCandidate, live: () => boolean): Promise<void> {
    const arm = pair[side]!;
    const fromStock = arm.g1Firmware === "stock";
    this.setProgress(g1FlashPercent(side, 0, 1));
    this.setStatus(`Connecting to the ${side} arm...`);
    const installed = await this.flash({
      address: arm.address,
      side,
      firmwarePath: this.image!.path,
      mode: fromStock ? "stock" : "update",
      connectWindowMs: CONNECT_MS,
    }, (state) => {
      if (state === "pairing") this.setStatus(`Pairing with the ${side} arm. If your phone asks, accept it.`);
      else if (state === "checking") this.setStatus(`Checking the ${side} arm...`);
      else if (state === "flashing") this.setStatus(`Sending the firmware to the ${side} arm. Nothing has changed yet.`);
      else if (state === "committing") this.setStatus(`Installing on the ${side} arm. Keep the glasses in the case.`);
    }, (sent, total) => this.setProgress(g1FlashPercent(side, sent, total)));
    if (!live()) return;
    this.setProgress(g1FlashPercent(side, 1, 1));
    if (!installed.flashed) {
      this.appendLog(`${side} arm already runs ${installed.version}`);
      return;
    }

    this.setStatus(`The ${side} arm is restarting into the new firmware. This takes about 20 seconds; keep it in the case.`);
    const identity = loadPairedGlassesIdentity();
    const back = await this.scanner.waitForG1v0Arm(side, identity?.serial ?? pair.serial, RETURN_MS);
    if (!live()) return;
    if (!back) {
      throw new Error(`The ${side} arm hasn't come back yet. Leave the glasses in the plugged-in case for a few minutes, with the lid ` +
        "open: an interrupted install finishes by itself. Then retry.");
    }
    saveG1Arm(side, back);
    if (back.g1Firmware === "g1v0-safe") {
      throw new Error(`The ${side} arm came back in safe mode: the new firmware restarted repeatedly. Retry to install it again.`);
    }

    this.setStatus(`Pairing with the ${side} arm. If your phone asks, accept it.`);
    let running: G1FlashResult;
    try {
      running = await this.flash({
        address: back.address,
        side,
        firmwarePath: "",
        mode: "probe",
        connectWindowMs: fromStock ? FIRST_PAIRING_MS : RETURN_MS,
      });
    } catch (error) {
      if (!fromStock || !live()) throw error;
      // Installed, as its advertising shows; it just won't pair yet. The next connection pairs it.
      this.appendLog(`${side} arm not paired yet: ${formatErrorMessage(error)}`);
      this.unpairedArm = true;
      return;
    }
    if (!live()) return;
    if (running.version !== installed.version) {
      throw new Error(`The ${side} arm runs ${running.version}, not ${installed.version}: it didn't take the new firmware. Retry to try again.`);
    }
    this.appendLog(`${side} arm runs ${running.version}`);
  }

  private async flash(
    options: G1FlasherOptions,
    onState?: (state: string) => void,
    onProgress?: (sent: number, total: number) => void,
  ) {
    const flasher = new G1Flasher(options);
    this.flasher = flasher;
    flasher.onLog((line) => this.appendLog(line));
    if (onState) flasher.onState(onState);
    if (onProgress) flasher.onProgress(onProgress);
    try {
      return await flasher.run();
    } finally {
      if (this.flasher === flasher) this.flasher = null;
      flasher.close();
    }
  }

  /** A G2's install gets these from the same download; Faceclaw's fonts are a phone-side matter, so a failure here is no reason to stop. */
  private async prepareFonts(live: () => boolean): Promise<void> {
    if (hasExtractedEvenHubFonts()) return;
    if (live()) this.setStatus("Preparing fonts...");
    try {
      await downloadAndExtractEvenHubFonts();
    } catch (error) {
      this.appendLog(`fonts not prepared: ${formatErrorMessage(error)}`);
    }
  }

  private finished(): void {
    // The glasses are ready for the main page to connect to.
    resumeAutoReconnect();
    this.setBusy(false);
    this.setProgress(100);
    this.setPhase("flashed");
    this.setText("All Done", `Both arms run Faceclaw's firmware ${G1V0_IMAGE.version}.` + (this.unpairedArm
      ? " Keep the glasses in the case with the lid open until Faceclaw has connected: they only pair in the case."
      : ""));
  }

  private failed(message: string): void {
    this.setBusy(false);
    this.setPhase("error");
    this.setText("Something Went Wrong", message);
  }

  private finish(): void {
    setPreviewOnlyMode(false);
    setOnboardingCompleted(true);
    this.teardown();
    finishOnboardingNavigation();
  }

  private leave(): void {
    this.teardown();
    const frame = Frame.topmost();
    if (this.fromOnboarding && frame?.canGoBack()) {
      frame.goBack();
      return;
    }
    if (!this.fromOnboarding) {
      finishOnboardingNavigation();
      return;
    }
    frame?.navigate({ moduleName: "phone-ui/onboarding-page", clearHistory: true });
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    ++this.generation;
    this.scanner.stop();
    this.flasher?.close();
    this.flasher = null;
  }

  // --- page state -----------------------------------------------------------

  private setText(headline: string, status: string): void {
    this.set("headline", headline);
    this.set("status", status);
  }

  private setStatus(status: string): void {
    this.set("status", status);
  }

  private setBusy(busy: boolean): void {
    this.set("busy", busy);
    this.notifyPropertyChange("busyVisibility", this.busyVisibility);
  }

  private setProgress(percent: number): void {
    this.set("progress", Math.max(0, Math.min(100, Math.round(percent))));
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    for (const property of ["primaryLabel", "primaryVisibility", "secondaryVisibility", "progressVisibility"] as const) {
      this.notifyPropertyChange(property, this[property]);
    }
  }

  private appendLog(line: string): void {
    const stamp = new Date().toISOString().slice(11, 19);
    this.set("log", this.log ? `${this.log}\n[${stamp}] ${line}` : `[${stamp}] ${line}`);
    this.notifyPropertyChange("logVisibility", this.logVisibility);
  }
}

function describeBuild(progress: G1BuildProgress): string {
  switch (progress) {
    case "downloading":
      return "Downloading the parts it needs from Even's firmware server...";
    case "verifying":
      return "Verifying the download...";
    case "assembling":
      return "Assembling the firmware...";
    default:
      return "Saving the firmware...";
  }
}
