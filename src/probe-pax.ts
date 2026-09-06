/**
 * One-shot probe: query Aeroglobe with {1 adult, 1 child, 1 infant} for a
 * single route/date and dump the raw response so we can see the per-pax
 * fare-breakdown shape before wiring the scraper parser.
 *
 * Usage (from repo root):
 *   npx tsx src/probe-pax.ts KHI KDU 2026-10-01
 * or default (KHI→KDU, 30 days out):
 *   npx tsx src/probe-pax.ts
 *
 * Env: same SUPABASE + AEROGLOBE creds the main scraper uses; nothing is
 * written to Supabase. Output goes to stdout + out/probe-pax-<ts>.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAeroglobeCredentials } from "./credentials.js";
import { loginAeroglobe } from "./scrapers/aeroglobe.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "./config.js";

const SEARCH_URL = "https://ag-proxima-prod.aeroglobe.pk/api/v1/flights/search/";

const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://agent.aeroglobe.io",
  referer: "https://agent.aeroglobe.io/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function generatePollId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let body = "";
  for (let i = 0; i < 7; i += 1) body += chars[Math.floor(Math.random() * chars.length)];
  return `W84W${body}_${Math.floor(Math.random() * 1000)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [origin = "KHI", destination = "KDU", depart = defaultDepart()] = process.argv.slice(2);

  const creds = await resolveAeroglobeCredentials();
  console.log(`[probe] logging in… (creds from ${creds.source})`);
  const session = await loginAeroglobe(creds.email, creds.password);
  console.log(`[probe] org=${session.organizationId} profile=${session.financialProfileId}`);

  const pollId = generatePollId();
  const body = {
    route_type: "ONEWAY",
    traveler_count: { adult_count: 1, child_count: 1, infant_count: 1 },
    cabin_class: "ECONOMY",
    full_result: true,
    non_stop_flight: false,
    origin,
    destination,
    departure_date: depart,
    financial_profile_id: session.financialProfileId,
    poll_id: pollId,
    selected_airlines: [],
    pricing: null,
  };

  console.log(`[probe] search ${origin}->${destination} ${depart} pax=1A1C1I`);

  let final: any = null;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Aeroglobe search HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const json = (await res.json()) as any;
    const data = json?.data;
    if (data?.keep_polling === false) {
      final = json;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!final) throw new Error("Poll exhausted without keep_polling=false");

  // Persist raw so we can grep the exact JSON path to per-pax fares.
  const outDir = join(process.cwd(), "out");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(outDir, `probe-pax-${origin}-${destination}-${depart}-${stamp}.json`);
  await writeFile(path, JSON.stringify(final, null, 2));

  // Also dump the first fare_option's price sub-tree to stdout so it's
  // grep-friendly in CI logs without opening the artifact.
  const firstOpt = final?.data?.journey_legs?.[0]?.flight_options?.[0];
  const firstFare = firstOpt?.fare_options?.[0];
  console.log(`[probe] wrote ${path}`);
  console.log(`[probe] first option airline=${firstOpt?.airline?.name} flight_numbers=${JSON.stringify(firstOpt?.flight_numbers)}`);
  console.log(`[probe] first fare_option price keys: ${Object.keys(firstFare?.price ?? {}).join(",")}`);
  console.log(`[probe] first fare_option price JSON:\n${JSON.stringify(firstFare?.price, null, 2)}`);
}

function defaultDepart(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error(`[probe:fatal] ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});
