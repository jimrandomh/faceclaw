import { type RawAdvertisement } from "../g2/even-advertisement";
import { DiscoveryAggregator } from "../g2/pairing-candidates";
import type { DiscoveredAddressSet } from "./device-discovery";

/**
 * Pick one address per role from a batch of raw advertisements — the manual
 * address page's "load" helper and the flash flow's address resolution.
 *
 * Runs the batch through the same `DiscoveryAggregator` the pairing page
 * uses, so left/right come from ONE serial-joined pair (the closest complete
 * one) rather than from whichever arm of whatever pair advertised last —
 * "latest per role" silently welded together arms of two different pairs.
 * When no arm carries a serial at all (a bonded-device listing has no
 * manufacturer data), there is nothing to join on and the latest arm per side
 * is used as before.
 */
export function buildAddressSet(candidates: RawAdvertisement[]): DiscoveredAddressSet {
  const aggregator = new DiscoveryAggregator();
  for (const raw of candidates) aggregator.ingest(raw);
  const classified = aggregator.advertisements();
  const pairs = aggregator.pairs();

  let left = "";
  let right = "";
  const completePair = pairs.find((pair) => pair.completeness === "complete");
  if (completePair) {
    left = completePair.left!.address;
    right = completePair.right!.address;
  } else if (classified.every((candidate) => !candidate.serial)) {
    for (const role of ["left", "right"] as const) {
      const latest = classified
        .filter((candidate) => candidate.role === role)
        .sort((a, b) => b.seenAtMs - a.seenAtMs)[0];
      if (role === "left") left = latest?.address ?? "";
      else right = latest?.address ?? "";
    }
  }
  // Arms with serials but no complete pair: leave the addresses empty. The
  // summary below names what was heard; guessing would defeat the serial join.

  const lines = classified.map((candidate) => {
    const extras = [candidate.serial ? `serial ${candidate.serial}` : null, candidate.rssi != null ? `${candidate.rssi} dBm` : null].filter(Boolean);
    return `${candidate.role}: ${candidate.name} ${candidate.address}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  });
  return {
    left,
    right,
    ring: aggregator.rings()[0]?.advertisement.address ?? "",
    summary: lines.length ? lines.join("\n") : "No matching devices found.",
  };
}

