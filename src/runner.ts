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

  const allFares: FareRow[] = [];
  const visits: ScrapeLogEntry[] = [];
  let errors = 0;

  const scrapedAtIso = new Date().toISOString();

  for (const route of ROUTES) {
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
        allFares.push(...rows);
        const carriersSeen = uniqueAirlines(rows);
        visits.push({
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
          allFares.push(...rows);
          const carriersSeen = uniqueAirlines(rows);
          visits.push({
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
  }

  const dedup = dedupFares(allFares);
  const result = await persist(dedup);
  const logResult = await persistScrapeLog(visits);
  console.log(
    `[runner] mode=${mode} collected=${allFares.length} unique=${dedup.length} wrote=${result.wrote} → ${result.destination} visits=${visits.length} logged=${logResult.wrote} errors=${errors}`,
  );

  return { collected: dedup.length, persisted: result.wrote, errors, visits: visits.length };
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
