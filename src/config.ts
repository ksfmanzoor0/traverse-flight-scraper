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

// Extended mode — Mon–Fri offsets from day 61 to day 180 (roughly 2–6 months
// out from the run day). Non-overlapping with normal mode (which caps at day
// 60 depart_date via the RETURN 60+7-night horizon). ~86 sample dates per
// route, ~3.5 hrs per monthly run.
//
// From a late-August run, this covers **late October → late February** — the
// exact window where PK domestic winter suspensions (LHE/KHI ↔ KDU) and
// day-of-week-only schedules (PIA Wed/Thu/Fri, AirBlue Mon/Wed on ISB↔KDU)
// become visible in the log.
//
// RETURN searches are disabled in extended mode — the ONEWAY per-leg data
// tells us which carriers operate each day; RETURN is combined-leg pricing
// that duplicates the signal and doubles run time.
export const EXTENDED_ONEWAY_MIN_OFFSET = 61;
export const EXTENDED_ONEWAY_MAX_OFFSET = 180;
export const EXTENDED_RETURN_HORIZONS: number[] = [];
export const EXTENDED_RETURN_NIGHTS: number[] = [];

/** Generate all Mon–Fri offsets in [min, max] relative to today. */
export function extendedOnewayOffsets(
  today: Date = new Date(),
  min: number = EXTENDED_ONEWAY_MIN_OFFSET,
  max: number = EXTENDED_ONEWAY_MAX_OFFSET,
): number[] {
  const offsets: number[] = [];
  for (let offset = min; offset <= max; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + offset);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    offsets.push(offset);
  }
  return offsets;
}

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
  if (mode === "extended") return extendedOnewayOffsets();
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
