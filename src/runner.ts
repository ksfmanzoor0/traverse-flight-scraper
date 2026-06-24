import { ROUTES, DATE_HORIZON_DAYS, RETURN_TRIP_NIGHTS, INTER_SEARCH_JITTER_MS } from "./config.js";
import { resolveAeroglobeCredentials } from "./credentials.js";
import { loginAeroglobe, searchAeroglobe, type AeroglobeSession } from "./scrapers/aeroglobe.js";
import { persist } from "./storage.js";
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

export async function runOnce(): Promise<{ collected: number; persisted: number; errors: number }> {
  const creds = await resolveAeroglobeCredentials();
  console.log(`[aero] logging in… (creds from ${creds.source})`);
  const session: AeroglobeSession = await loginAeroglobe(creds.email, creds.password);
  console.log(
    `[aero] session: org=${session.organizationId} profile=${session.financialProfileId} user="${session.userFullName}"`,
  );

  const allFares: FareRow[] = [];
  let errors = 0;

  for (const route of ROUTES) {
    for (const offset of DATE_HORIZON_DAYS) {
      const departDate = isoDateOffset(offset);

      // ONE WAY
      try {
        const rows = await searchAeroglobe({
          session,
          origin: route.origin,
          destination: route.destination,
          routeType: "ONEWAY",
          departDate,
        });
        allFares.push(...rows);
        console.log(`[aero] ONEWAY ${route.origin}→${route.destination} ${departDate}: ${rows.length} fares`);
      } catch (err) {
        errors += 1;
        console.error(`[aero] ONEWAY ${route.origin}→${route.destination} ${departDate} failed: ${(err as Error).message}`);
      }
      await sleep(jitterMs());

      // RETURN at each gap
      for (const nights of RETURN_TRIP_NIGHTS) {
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
          console.log(
            `[aero] RETURN ${route.origin}↔${route.destination} ${departDate}→${returnDate} (${nights}n): ${rows.length} fares`,
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
  console.log(
    `[runner] collected=${allFares.length} unique=${dedup.length} wrote=${result.wrote} → ${result.destination} errors=${errors}`,
  );

  return { collected: dedup.length, persisted: result.wrote, errors };
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
