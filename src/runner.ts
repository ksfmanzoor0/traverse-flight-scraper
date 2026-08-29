import {
  ROUTES,
  INTER_SEARCH_JITTER_MS,
  onewayHorizonsFor,
  returnHorizonsFor,
  returnNightsFor,
  getScrapeMode,
} from "./config.js";
import { resolveAeroglobeCredentials } from "./credentials.js";
import { loginAeroglobe, searchAeroglobe, type AeroglobeSession } from "./scrapers/aeroglobe.js";
import { persist, persistScrapeLog, type ScrapeLogEntry } from "./storage.js";
import type { FareRow } from "./types.js";

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function jitterMs(): number {
  const [lo, hi] = INTER_SEARCH_JITTER_MS;
  return Math.floor(lo + Math.random() * (hi - lo));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runOnce(): Promise<{ collected: number; persisted: number; errors: number; visits: number }> {
  const mode = getScrapeMode();
  const creds = await resolveAeroglobeCredentials();
  console.log(`[aero] mode=${mode} logging in… (creds from ${creds.source})`);
  const session: AeroglobeSession = await loginAeroglobe(creds.email, creds.password);
  console.log(
    `[aero] session: org=${session.organizationId} profile=${session.financialProfileId} user="${session.userFullName}"`,
  );

  const scrapedAtIso = new Date().toISOString();
  let totalCollected = 0;
  let totalPersisted = 0;
  let totalVisits = 0;
  let errors = 0;

  for (const route of ROUTES) {
    // Per-route accumulators. Flush after each route so a timeout mid-run
    // preserves everything collected up to the last completed route instead
    // of losing the whole session's work (extended mode = ~4 hrs).
    const routeFares: FareRow[] = [];
    const routeVisits: ScrapeLogEntry[] = [];
    const onewayHorizons = onewayHorizonsFor(route.origin, route.destination, mode);
    const returnHorizons = returnHorizonsFor(route.origin, route.destination, mode);
    const returnNights = returnNightsFor(route.origin, route.destination, mode);

    // ONEWAY
    for (const offset of onewayHorizons) {
      const departDate = isoDateOffset(offset);
      try {
        const rows = await searchAeroglobe({
          session,
          origin: route.origin,
          destination: route.destination,
          routeType: "ONEWAY",
          departDate,
        });
        routeFares.push(...rows);
        const carriersSeen = uniqueAirlines(rows);
        routeVisits.push({
          origin: route.origin, destination: route.destination,
          routeType: "ONEWAY", departDate, returnDate: null,
          carriersSeen, fareCount: rows.length, mode, scrapedAt: scrapedAtIso,
        });
        console.log(`[aero] ONEWAY ${route.origin}→${route.destination} ${departDate}: ${rows.length} fares [${carriersSeen.join(",") || "empty"}]`);
      } catch (err) {
        errors += 1;
        console.error(`[aero] ONEWAY ${route.origin}→${route.destination} ${departDate} failed: ${(err as Error).message}`);
      }
      await sleep(jitterMs());
    }

    // RETURN — only forward pairs, per-route horizons, × per-route night gaps
    for (const offset of returnHorizons) {
      const departDate = isoDateOffset(offset);
      for (const nights of returnNights) {
        const returnDate = addDays(departDate, nights);
        try {
          const rows = await searchAeroglobe({
            session,
            origin: route.origin,
            destination: route.destination,
            routeType: "RETURN",
            departDate,
            returnDate,
          });
          routeFares.push(...rows);
          const carriersSeen = uniqueAirlines(rows);
          routeVisits.push({
            origin: route.origin, destination: route.destination,
            routeType: "RETURN", departDate, returnDate,
            carriersSeen, fareCount: rows.length, mode, scrapedAt: scrapedAtIso,
          });
          console.log(
            `[aero] RETURN ${route.origin}↔${route.destination} ${departDate}→${returnDate} (${nights}n): ${rows.length} fares [${carriersSeen.join(",") || "empty"}]`,
          );
        } catch (err) {
          errors += 1;
          console.error(
            `[aero] RETURN ${route.origin}↔${route.destination} ${departDate}→${returnDate} failed: ${(err as Error).message}`,
          );
        }
        await sleep(jitterMs());
      }
    }

    // Flush this route's results before moving on. Best-effort — a persist
    // failure logs the error and continues to the next route rather than
    // aborting the whole run.
    const dedup = dedupFares(routeFares);
    try {
      const fareResult = await persist(dedup);
      const logResult = await persistScrapeLog(routeVisits);
      totalCollected += dedup.length;
      totalPersisted += fareResult.wrote;
      totalVisits += logResult.wrote;
      console.log(
        `[flush] ${route.origin}→${route.destination}: fares=${dedup.length} wrote=${fareResult.wrote} visits=${routeVisits.length} logged=${logResult.wrote}`,
      );
    } catch (err) {
      errors += 1;
      console.error(`[flush] ${route.origin}→${route.destination} persist failed: ${(err as Error).message}`);
    }
  }

  console.log(
    `[runner] mode=${mode} collected=${totalCollected} persisted=${totalPersisted} visits=${totalVisits} errors=${errors}`,
  );

  return { collected: totalCollected, persisted: totalPersisted, errors, visits: totalVisits };
}

function uniqueAirlines(rows: FareRow[]): string[] {
  return Array.from(new Set(rows.map((r) => r.airline))).sort();
}

function dedupFares(rows: FareRow[]): FareRow[] {
  // Keep cheapest fare per (origin, destination, airline, route_type, depart_date, return_date, source).
  const seen = new Map<string, FareRow>();
  for (const r of rows) {
    const key = `${r.origin}|${r.destination}|${r.airline}|${r.routeType}|${r.departDate}|${r.returnDate ?? ""}|${r.source}`;
    const prior = seen.get(key);
    if (!prior || r.fareTotal < prior.fareTotal) seen.set(key, r);
  }
  return Array.from(seen.values());
}
