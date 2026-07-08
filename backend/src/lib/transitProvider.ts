import type { Env } from "../env";

export interface RawArrival {
  lineNumber: string;
  etaSeconds: number;
  stopsRemaining: number | null;
  garageNo: string | null;
  gps: { lat: number; lon: number } | null;
}

// Abstracts the upstream live-arrivals source. The concrete endpoint and its
// request shape live entirely in env vars (see backend/.dev.vars, never
// committed) — nothing about the real provider is hardcoded here or anywhere
// else in source, per the project's data-provider rule.
export interface TransitDataProvider {
  fetchArrivals(stopId: string): Promise<RawArrival[]>;
}

export class BgnaplataTransitProvider implements TransitDataProvider {
  constructor(private readonly env: Env) {}

  async fetchArrivals(stopId: string): Promise<RawArrival[]> {
    const extraFields = JSON.parse(this.env.TRANSIT_SOURCE_FORM_EXTRA_JSON) as Record<string, string>;
    const body = new URLSearchParams({
      r: stopId,
      b: generateClientId(),
      ...extraFields,
    });

    const res = await fetch(this.env.TRANSIT_SOURCE_BASE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": `StiglaApp/0.1 (+${this.env.SOURCE_USER_AGENT_CONTACT}; personal use, low volume)`,
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Transit source responded ${res.status}`);
    }

    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) return [];

    return raw.map(parseRawArrival);
  }
}

export function parseRawArrival(item: unknown): RawArrival {
  const r = item as Record<string, unknown>;
  const vehicles = Array.isArray(r.vehicles) ? (r.vehicles as Record<string, unknown>[]) : [];
  const firstVehicle = vehicles[0];
  const gps =
    firstVehicle && typeof firstVehicle.lat === "string" && typeof firstVehicle.lng === "string"
      ? { lat: parseFloat(firstVehicle.lat), lon: parseFloat(firstVehicle.lng) }
      : null;

  return {
    lineNumber: String(r.line_number ?? ""),
    etaSeconds: typeof r.seconds_left === "number" ? r.seconds_left : 0,
    stopsRemaining: typeof r.stations_between === "number" ? r.stations_between : null,
    garageNo: typeof r.garage_no === "string" ? r.garage_no : null,
    gps: gps && !Number.isNaN(gps.lat) && !Number.isNaN(gps.lon) ? gps : null,
  };
}

function generateClientId(): string {
  const digits = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0");
  return `ST${digits}`;
}
