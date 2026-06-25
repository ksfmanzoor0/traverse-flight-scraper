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

// Only fire RETURN searches for these origin→destination pairs (no reverse).
// The combined-leg price would duplicate if both directions queried RETURN.
const RETURN_ONLY_FORWARD_PAIRS = new Set<string>([
  "ISB-KDU",
  "LHE-KDU",
  "KHI-KDU",
  "ISB-GIL",
  "KHI-ISB",
  "LHE-ISB",
  "KHI-LHE",
]);

export function shouldQueryReturn(origin: string, destination: string): boolean {
  return RETURN_ONLY_FORWARD_PAIRS.has(`${origin}-${destination}`);
}

// Days from runtime to sample fares
export const DATE_HORIZON_DAYS = [7, 30, 60];

// Return-trip gaps to sample (in nights). Most packages are 5-7 nights.
export const RETURN_TRIP_NIGHTS = [5, 7];

// Aeroglobe polling tuning
export const POLL_INTERVAL_MS = 1500;
export const POLL_MAX_ATTEMPTS = 15;        // ~22.5s upper bound per search
export const INTER_SEARCH_JITTER_MS = [800, 2_000];
