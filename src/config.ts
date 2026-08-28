export type AirportCode = "KHI" | "LHE" | "ISB" | "KDU" | "GIL" | "GWD";
export type Airline = "PIA" | "AirBlue" | "AirSial" | "Flyjinnah" | "Unknown";

export interface RouteSpec {
  origin: AirportCode;
  destination: AirportCode;
}

// Both directions are scraped as separate ONEWAY queries so the quote engine
// has independent fares for outbound and inbound legs (packages need both:
// e.g. KHI→ISB to start a road tour, ISB→KHI to return). RETURN queries are
// only fired for origin→destination pairs (not the reverse) since RETURN
// fares are combined-leg prices, not per-direction.
export const ROUTES: RouteSpec[] = [
  // Skardu (KDU) — peak season Skardu fly-in packages
  { origin: "ISB", destination: "KDU" },
  { origin: "KDU", destination: "ISB" },
  { origin: "LHE", destination: "KDU" },
  { origin: "KDU", destination: "LHE" },
  { origin: "KHI", destination: "KDU" },
  { origin: "KDU", destination: "KHI" },
  // Gilgit (GIL) — PIA only
  { origin: "ISB", destination: "GIL" },
  { origin: "GIL", destination: "ISB" },
  // Trunk routes
  { origin: "KHI", destination: "ISB" },
  { origin: "ISB", destination: "KHI" },
  { origin: "LHE", destination: "ISB" },
  { origin: "ISB", destination: "LHE" },
  { origin: "KHI", destination: "LHE" },
  { origin: "LHE", destination: "KHI" },
];

// SCRAPE_MODE picks which horizon set the runner uses:
//  - "normal"   (default): near-term dates, runs every 12h — feeds live quotes
//  - "extended": far-term dates 90–180 days out, runs monthly — reveals which
//    routes/carriers actually operate 3–6 months down the line. Empty scrape
//    results in this window are recorded in flight_route_scrape_log so the
//    quote engine can distinguish "no scrape yet" from "carrier suspended."
export type ScrapeMode = "normal" | "extended";

export function getScrapeMode(): ScrapeMode {
  const raw = (process.env.SCRAPE_MODE ?? "normal").toLowerCase();
  return raw === "extended" ? "extended" : "normal";
}

// Defaults applied to every route unless overridden below.
export const DEFAULT_ONEWAY_HORIZONS = [30];
export const DEFAULT_RETURN_HORIZONS = [7, 30, 60];
export const DEFAULT_RETURN_NIGHTS = [5, 7];        // both gaps by default

// Extended mode — 90/120/150/180 day horizons. Samples 4 far dates per route
// per monthly run. Adequate to detect a Nov–Mar carrier suspension pattern
// (each month becomes a distinct depart_date bucket in the scrape log).
export const EXTENDED_ONEWAY_HORIZONS = [90, 120, 150, 180];
export const EXTENDED_RETURN_HORIZONS = [90, 120, 150, 180];
export const EXTENDED_RETURN_NIGHTS = [5];          // single gap keeps run time bounded

// Per-route overrides. Empty array `[]` disables that search type for the route.
const ROUTE_OVERRIDES: Record<
  string,
  { oneway?: number[]; return?: number[]; returnNights?: number[] }
> = {
  // Skardu — highest-value route; wider ONEWAY coverage in both directions
  "ISB-KDU": { oneway: [7, 30] },
  "KDU-ISB": { oneway: [7, 30] },
  "LHE-KDU": { oneway: [7, 30] },
  "KHI-KDU": { oneway: [7, 30] },
  // Trunk RETURN routes with low package volume — single horizon, single gap
  "LHE-ISB": { return: [30], returnNights: [5] },
  "KHI-LHE": { return: [7], returnNights: [5] },
};

// Forward pairs eligible for RETURN searches (no reverse-direction RETURN
// since combined-leg pricing would double-count).
const RETURN_FORWARD_PAIRS = new Set<string>([
  "ISB-KDU",
  "LHE-KDU",
  "KHI-KDU",
  "ISB-GIL",
  "KHI-ISB",
  "LHE-ISB",
  "KHI-LHE",
]);

export function onewayHorizonsFor(origin: string, destination: string, mode: ScrapeMode = getScrapeMode()): number[] {
  if (mode === "extended") return EXTENDED_ONEWAY_HORIZONS;
  const key = `${origin}-${destination}`;
  return ROUTE_OVERRIDES[key]?.oneway ?? DEFAULT_ONEWAY_HORIZONS;
}

export function returnHorizonsFor(origin: string, destination: string, mode: ScrapeMode = getScrapeMode()): number[] {
  const key = `${origin}-${destination}`;
  if (!RETURN_FORWARD_PAIRS.has(key)) return [];
  if (mode === "extended") return EXTENDED_RETURN_HORIZONS;
  return ROUTE_OVERRIDES[key]?.return ?? DEFAULT_RETURN_HORIZONS;
}

export function returnNightsFor(origin: string, destination: string, mode: ScrapeMode = getScrapeMode()): number[] {
  if (mode === "extended") return EXTENDED_RETURN_NIGHTS;
  const key = `${origin}-${destination}`;
  return ROUTE_OVERRIDES[key]?.returnNights ?? DEFAULT_RETURN_NIGHTS;
}

// Aeroglobe polling tuning
export const POLL_INTERVAL_MS = 1500;
export const POLL_MAX_ATTEMPTS = 25;        // ~37.5s upper bound per search
                                            // bumped from 15 to give slower
                                            // carrier APIs (AirBlue, AirSial)
                                            // more time to return options
export const INTER_SEARCH_JITTER_MS = [800, 2_000];
