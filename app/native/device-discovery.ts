import { Utils } from "@nativescript/core";

declare const com: any;

export type DiscoveredDevice = {
  address: string;
  name: string;
  role: "left" | "right" | "ring";
  source: "paired" | "scan";
};

export type DiscoveredAddressSet = {
  left: string;
  right: string;
  ring: string;
  summary: string;
};

export class DeviceDiscoveryBridge {
  private readonly discovery: any;

  constructor() {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");
    this.discovery = new com.faceclaw.app.FaceclawDeviceDiscovery(context);
  }

  async getBondedCandidates(): Promise<DiscoveredDevice[]> {
    return parseCandidates(String(this.discovery.getBondedCandidatesJson()));
  }

  async scanCandidates(timeoutMs = 6000): Promise<DiscoveredDevice[]> {
    return parseCandidates(String(this.discovery.scanCandidatesJson(timeoutMs)));
  }
}

export function buildAddressSet(candidates: DiscoveredDevice[]): DiscoveredAddressSet {
  const latestForRole = new Map<DiscoveredDevice["role"], DiscoveredDevice>();
  for (const candidate of candidates) {
    latestForRole.set(candidate.role, candidate);
  }
  const selected = {
    left: latestForRole.get("left")?.address ?? "",
    right: latestForRole.get("right")?.address ?? "",
    ring: latestForRole.get("ring")?.address ?? "",
  };
  const lines = candidates.map((candidate) => `${candidate.role}: ${candidate.name} ${candidate.address}`);
  return {
    ...selected,
    summary: lines.length ? lines.join("\n") : "No matching devices found.",
  };
}

function parseCandidates(json: string): DiscoveredDevice[] {
  const raw = JSON.parse(json) as Array<Record<string, unknown>>;
  return raw
    .map((item) => ({
      address: String(item.address ?? ""),
      name: String(item.name ?? ""),
      role: String(item.role ?? "") as DiscoveredDevice["role"],
      source: String(item.source ?? "") as DiscoveredDevice["source"],
    }))
    .filter((item) => !!item.address && (item.role === "left" || item.role === "right" || item.role === "ring"));
}
