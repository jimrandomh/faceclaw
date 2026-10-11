/** A valid report body, with top-level fields replaced by `overrides`. */
export function sampleReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    reportId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    installId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    level: "full",
    createdAt: "2026-10-10T12:00:00.000Z",
    app: { version: "0.8.3", platform: "android", build: "official" },
    counters: { "2026-10-09": { "g2.connect": 3, "g2.disconnect": 2 }, "2026-10-10": { "g2.connect": 1 } },
    snapshot: { "device.g2.paired": true, "apikey.anthropic": false, "setting.ui-font": "Roboto-Light.ttf:16" },
    ...overrides,
  };
}
