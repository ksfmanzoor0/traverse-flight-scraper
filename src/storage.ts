import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FareRow } from "./types.js";

const DRY_RUN = process.env.DRY_RUN === "true";

let client: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

export async function persist(rows: FareRow[]): Promise<{ wrote: number; skipped: number; destination: string }> {
  if (rows.length === 0) return { wrote: 0, skipped: 0, destination: "noop" };

  if (DRY_RUN) {
    const outDir = join(process.cwd(), "out");
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(outDir, `fares-${stamp}.json`);
    await writeFile(path, JSON.stringify(rows, null, 2));
    return { wrote: rows.length, skipped: 0, destination: path };
  }

  const sb = getSupabase();
  if (!sb) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing (set DRY_RUN=true to write JSON instead)");
  }

  const payload = rows.map((r) => ({
    origin: r.origin,
    destination: r.destination,
    airline: r.airline,
    flight_numbers: r.flightNumbers,
    route_type: r.routeType,
    depart_date: r.departDate,
    return_date: r.returnDate,
    fare_total: r.fareTotal,
    base_fare: r.baseFare,
    tax: r.tax,
    rbd: r.rbd,
    is_refundable: r.isRefundable,
    currency: r.currency,
    source: r.source,
    source_url: r.sourceUrl,
    scraped_at: r.scrapedAt,
  }));

  const { error, count } = await sb
    .from("flight_routes")
    .upsert(payload, {
      onConflict: "origin,destination,airline,route_type,depart_date,return_date,source",
      count: "exact",
    });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  return { wrote: count ?? rows.length, skipped: 0, destination: "supabase:flight_routes" };
}
