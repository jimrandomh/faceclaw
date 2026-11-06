/** Keeping what's saved about a G1 current as an install changes its arms' addresses. */
import {
  loadDeviceAddresses,
  loadPairedGlassesIdentity,
  saveDeviceAddresses,
  savePairedGlassesIdentity,
} from "../g2/device-addresses";
import type { EvenAdvertisement } from "../g2/even-advertisement";
import type { GlassesPairCandidate } from "../g2/pairing-candidates";
import type { G1Side } from "./flash-plan";

export function saveG1Pair(pair: GlassesPairCandidate): void {
  const stored = loadDeviceAddresses();
  saveDeviceAddresses({ left: pair.left!.address, right: pair.right!.address, ring: stored.ring });
  const identity = loadPairedGlassesIdentity();
  savePairedGlassesIdentity({
    serial: pair.serial ?? identity?.serial ?? "",
    leftName: pair.left!.name,
    rightName: pair.right!.name,
    leftAddress: pair.left!.address,
    rightAddress: pair.right!.address,
    ringName: identity?.ringName ?? "",
    ringAddress: stored.ring,
    pairedAtMs: identity?.pairedAtMs ?? Date.now(),
  });
}

/** Saved as soon as it's known: if anything stops the install after this, the next try and the session still find this arm. */
export function saveG1Arm(side: G1Side, arm: EvenAdvertisement): void {
  saveDeviceAddresses({ ...loadDeviceAddresses(), [side]: arm.address });
  const identity = loadPairedGlassesIdentity();
  if (identity) {
    savePairedGlassesIdentity(side === "left"
      ? { ...identity, leftName: arm.name, leftAddress: arm.address }
      : { ...identity, rightName: arm.name, rightAddress: arm.address });
  }
}
