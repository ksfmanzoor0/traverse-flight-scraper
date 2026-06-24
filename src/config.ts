export type AirportCode = "KHI" | "LHE" | "ISB" | "KDU" | "GIL" | "GWD";
export type Airline = "PIA" | "AirBlue" | "AirSial" | "Flyjinnah" | "Unknown";

export interface RouteSpec {
  origin: AirportCode;
  destination: AirportCode;
}

export const ROUTES: RouteSpec[] = [
  { origin: "KHI", destination: "KDU" },
  { origin: "LHE", destination: "KDU" },
  { origin: "ISB", destination: "KDU" },
  { origin: "ISB", destination: "GIL" },
  { origin: "KHI", destination: "ISB" },
  { origin: "LHE", destination: "ISB" },
  { origin: "KHI", destination: "LHE" },
  { origin: "KHI", destination: "GWD" },
  { origin: "ISB", destination: "GWD" },
];

// Days from runtime to sample fares
export const DATE_HORIZON_DAYS = [7, 30, 60, 90];

// Return-trip gaps to sample (in nights). Most packages are 5-7 nights.
export const RETURN_TRIP_NIGHTS = [5, 7];

// Aeroglobe polling tuning
export const POLL_INTERVAL_MS = 1500;
export const POLL_MAX_ATTEMPTS = 15;        // ~22.5s upper bound per search
export const INTER_SEARCH_JITTER_MS = [800, 2_000];
