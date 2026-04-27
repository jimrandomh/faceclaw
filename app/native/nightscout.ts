import { loadNightscoutSettings } from "../ui/dashboard-settings";

export type NightscoutPoint = {
  timestampMs: number;
  sgv: number;
};

export type NightscoutCarbEvent = {
  timestampMs: number;
  carbs: number;
};

export type NightscoutBolusEvent = {
  timestampMs: number;
  insulin: number;
};

export type NightscoutBasalEvent = {
  timestampMs: number;
  durationMinutes: number;
  rate: number;
};

export type NightscoutState = {
  available: boolean;
  status: string;
  units: string;
  history: NightscoutPoint[];
  latest: NightscoutPoint | null;
  delta: number | null;
  direction: string;
  iob: number | null;
  cob: number | null;
  cageTimestampMs: number | null;
  pumpStatus: string;
  openapsStatusShort: string;
  carbs: NightscoutCarbEvent[];
  boluses: NightscoutBolusEvent[];
  basal: NightscoutBasalEvent[];
  lastUpdatedMs: number | null;
  configurationMissing: boolean;
};

type NightscoutEntryResponse = {
  sgv?: unknown;
  date?: unknown;
  direction?: unknown;
};

type NightscoutDeviceStatusResponse = {
  openaps?: {
    iob?: {
      iob?: unknown;
      timestamp?: unknown;
      mills?: unknown;
    };
    suggested?: {
      COB?: unknown;
      timestamp?: unknown;
      mills?: unknown;
    };
    enacted?: {
      COB?: unknown;
      timestamp?: unknown;
      mills?: unknown;
    };
  };
  pump?: {
    clock?: unknown;
    reservoir?: unknown;
    battery?: {
      voltage?: unknown;
      status?: unknown;
    };
    status?: {
      status?: unknown;
      bolusing?: unknown;
      suspended?: unknown;
      timestamp?: unknown;
    };
  };
  created_at?: unknown;
};

type NightscoutStatusResponse = {
  settings?: {
    units?: unknown;
  };
};

type NightscoutTreatmentResponse = {
  created_at?: unknown;
  timestamp?: unknown;
  eventType?: unknown;
  carbs?: unknown;
  insulin?: unknown;
  absolute?: unknown;
  rate?: unknown;
  duration?: unknown;
};

const NIGHTSCOUT_REFRESH_MS = 60_000;
const NIGHTSCOUT_HISTORY_COUNT = 30;
const NIGHTSCOUT_GRAPH_WINDOW_MS = 2 * 60 * 60 * 1000;
const NIGHTSCOUT_TREATMENT_LOOKBACK_MS = 3 * 60 * 60 * 1000;

const DEFAULT_NIGHTSCOUT_STATE: NightscoutState = {
  available: false,
  status: "Nightscout unavailable.",
  units: "mg/dL",
  history: [],
  latest: null,
  delta: null,
  direction: "",
  iob: null,
  cob: null,
  cageTimestampMs: null,
  pumpStatus: "",
  openapsStatusShort: "--",
  carbs: [],
  boluses: [],
  basal: [],
  lastUpdatedMs: null,
  configurationMissing: true,
};

export class NightscoutBridge {
  private readonly listeners = new Set<(state: NightscoutState) => void>();
  private state: NightscoutState = { ...DEFAULT_NIGHTSCOUT_STATE };
  private refreshHandle: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;

  onStateChange(listener: (state: NightscoutState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): NightscoutState {
    return {
      ...this.state,
      history: this.state.history.map((point) => ({ ...point })),
      latest: this.state.latest ? { ...this.state.latest } : null,
      carbs: this.state.carbs.map((event) => ({ ...event })),
      boluses: this.state.boluses.map((event) => ({ ...event })),
      basal: this.state.basal.map((event) => ({ ...event })),
    };
  }

  async start(): Promise<void> {
    if (this.refreshHandle) {
      await this.refreshNow();
      return;
    }
    await this.refreshNow();
    this.refreshHandle = setInterval(() => {
      void this.refreshNow();
    }, NIGHTSCOUT_REFRESH_MS);
  }

  async stop(): Promise<void> {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
    await this.refreshInFlight?.catch(() => {});
  }

  async refreshNow(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.refresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const nowMs = Date.now();
      const settings = loadNightscoutSettings();
      if (!settings.siteUrl || !settings.apiToken) {
        this.state = {
          ...DEFAULT_NIGHTSCOUT_STATE,
          status: "Configure Nightscout site URL and API token.",
          configurationMissing: true,
        };
        this.emit();
        return;
      }
      const treatmentStartIso = new Date(nowMs - NIGHTSCOUT_TREATMENT_LOOKBACK_MS).toISOString();
      const tokenQuery = `token=${encodeURIComponent(settings.apiToken)}`;
      const [entries, deviceStatus, status, treatments, siteChanges] = await Promise.all([
        fetchJson<NightscoutEntryResponse[]>(
          `${settings.siteUrl}/api/v1/entries.json?count=${NIGHTSCOUT_HISTORY_COUNT}&${tokenQuery}`,
        ),
        fetchJson<NightscoutDeviceStatusResponse[]>(
          `${settings.siteUrl}/api/v1/devicestatus.json?count=1&${tokenQuery}`,
        ),
        fetchJson<NightscoutStatusResponse>(
          `${settings.siteUrl}/api/v1/status.json?${tokenQuery}`,
        ),
        fetchJson<NightscoutTreatmentResponse[]>(
          `${settings.siteUrl}/api/v1/treatments.json?find%5Bcreated_at%5D%5B%24gte%5D=${encodeURIComponent(treatmentStartIso)}&${tokenQuery}`,
        ),
        fetchJson<NightscoutTreatmentResponse[]>(
          `${settings.siteUrl}/api/v1/treatments.json?find%5BeventType%5D=Site%20Change&count=1&${tokenQuery}`,
        ),
      ]);

      const history = (entries ?? [])
        .map((entry) => ({
          timestampMs: Number(entry.date ?? 0),
          sgv: Number(entry.sgv ?? NaN),
          direction: typeof entry.direction === "string" ? entry.direction : "",
        }))
        .filter((entry) => Number.isFinite(entry.timestampMs) && Number.isFinite(entry.sgv))
        .sort((a, b) => a.timestampMs - b.timestampMs);

      const latest = history.at(-1) ?? null;
      const previous = history.length >= 2 ? history[history.length - 2]! : null;
      const latestDirection = latest ? (entries?.[0]?.direction as string | undefined) ?? "" : "";
      const latestDeviceStatus = deviceStatus?.[0];
      const iob = Number((latestDeviceStatus?.openaps?.iob?.iob as number | undefined) ?? NaN);
      const cob = firstFiniteNumber(
        latestDeviceStatus?.openaps?.suggested?.COB,
        latestDeviceStatus?.openaps?.enacted?.COB,
      );
      const loopTimestampMs = Math.max(
        parseTimestampMs(latestDeviceStatus?.openaps?.suggested?.mills ?? latestDeviceStatus?.openaps?.suggested?.timestamp),
        parseTimestampMs(latestDeviceStatus?.openaps?.enacted?.mills ?? latestDeviceStatus?.openaps?.enacted?.timestamp),
        parseTimestampMs(latestDeviceStatus?.openaps?.iob?.mills ?? latestDeviceStatus?.openaps?.iob?.timestamp),
      );
      const pumpStatus = formatPumpStatus(latestDeviceStatus, nowMs);
      const parsedTreatments = parseTreatments(treatments ?? [], nowMs);
      const latestSiteChange = parseTimestampMs(siteChanges?.[0]?.created_at ?? siteChanges?.[0]?.timestamp);

      this.state = {
        available: latest !== null,
        status: latest ? "Nightscout updated." : "No Nightscout glucose entries.",
        units: typeof status?.settings?.units === "string" ? status.settings.units : "mg/dL",
        history: history.map(({ timestampMs, sgv }) => ({ timestampMs, sgv })),
        latest: latest ? { timestampMs: latest.timestampMs, sgv: latest.sgv } : null,
        delta: latest && previous ? latest.sgv - previous.sgv : null,
        direction: latestDirection,
        iob: Number.isFinite(iob) ? iob : null,
        cob,
        cageTimestampMs: latestSiteChange > 0 ? latestSiteChange : null,
        pumpStatus,
        openapsStatusShort: loopTimestampMs > 0 ? formatElapsedShort(nowMs - loopTimestampMs) : "--",
        carbs: parsedTreatments.carbs,
        boluses: parsedTreatments.boluses,
        basal: parsedTreatments.basal,
        lastUpdatedMs: nowMs,
        configurationMissing: false,
      };
      this.emit();
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.state = {
        ...this.state,
        available: this.state.latest !== null,
        status: `Nightscout refresh failed: ${message}`,
      };
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function parseTreatments(treatments: NightscoutTreatmentResponse[], nowMs: number): {
  carbs: NightscoutCarbEvent[];
  boluses: NightscoutBolusEvent[];
  basal: NightscoutBasalEvent[];
} {
  const windowStartMs = nowMs - NIGHTSCOUT_TREATMENT_LOOKBACK_MS;
  const carbs: NightscoutCarbEvent[] = [];
  const boluses: NightscoutBolusEvent[] = [];
  const basal: NightscoutBasalEvent[] = [];

  for (const treatment of treatments) {
    const timestampMs = parseTimestampMs(treatment.created_at ?? treatment.timestamp);
    if (timestampMs <= 0 || timestampMs < windowStartMs || timestampMs > nowMs) {
      continue;
    }

    const carbValue = firstFiniteNumber(treatment.carbs);
    if (carbValue !== null && carbValue > 0) {
      carbs.push({ timestampMs, carbs: carbValue });
    }

    const insulinValue = firstFiniteNumber(treatment.insulin);
    if (insulinValue !== null && insulinValue > 0) {
      boluses.push({ timestampMs, insulin: insulinValue });
    }

    const eventType = typeof treatment.eventType === "string" ? treatment.eventType : "";
    const basalRate = firstFiniteNumber(treatment.absolute, treatment.rate);
    const durationMinutes = firstFiniteNumber(treatment.duration);
    if ((eventType === "Temp Basal" || basalRate !== null) && basalRate !== null && durationMinutes !== null && durationMinutes > 0) {
      basal.push({ timestampMs, rate: basalRate, durationMinutes });
    }
  }

  carbs.sort((a, b) => a.timestampMs - b.timestampMs);
  boluses.sort((a, b) => a.timestampMs - b.timestampMs);
  basal.sort((a, b) => a.timestampMs - b.timestampMs);
  return { carbs, boluses, basal };
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function formatPumpStatus(status: NightscoutDeviceStatusResponse | undefined, nowMs: number): string {
  if (!status?.pump) {
    return "--";
  }
  const reservoir = firstFiniteNumber(status.pump.reservoir);
  const voltage = firstFiniteNumber(status.pump.battery?.voltage);
  const commTimestampMs = Math.max(
    parseTimestampMs(status.pump.status?.timestamp),
    parseTimestampMs(status.pump.clock),
    parseTimestampMs(status.created_at),
  );
  const stateLabel = summarizePumpState(status);
  const parts: string[] = [];
  if (reservoir !== null) {
    parts.push(`${Math.round(reservoir)}U`);
  }
  if (voltage !== null) {
    parts.push(`${voltage.toFixed(2)}v`);
  }
  if (commTimestampMs > 0) {
    parts.push(`${formatElapsedShort(nowMs - commTimestampMs)} ago`);
  }
  if (stateLabel) {
    parts.push(stateLabel);
  }
  return parts.join(" ") || "--";
}

function summarizePumpState(status: NightscoutDeviceStatusResponse): string {
  if (status.pump?.status?.suspended === true) {
    return "suspended";
  }
  if (status.pump?.status?.bolusing === true) {
    return "bolusing";
  }
  if (typeof status.pump?.status?.status === "string" && status.pump.status.status.trim()) {
    return status.pump.status.status.trim();
  }
  if (typeof status.pump?.battery?.status === "string" && status.pump.battery.status.trim()) {
    return status.pump.battery.status.trim();
  }
  return "";
}

function formatElapsedShort(elapsedMs: number): string {
  const minutes = Math.max(0, Math.round(elapsedMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

export const nightscoutBridge = new NightscoutBridge();
