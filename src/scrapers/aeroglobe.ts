import type { AirportCode, Airline } from "../config.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "../config.js";
import type { FareRow, RouteType } from "../types.js";

const AUTH_URL = "https://ag-proxima-prod.aeroglobe.pk/api/auth/login/";
const SEARCH_URL = "https://ag-proxima-prod.aeroglobe.pk/api/v1/flights/search/";

export interface AeroglobeSession {
  accessToken: string;
  refreshToken: string;
  organizationId: string;
  financialProfileId: string;
  userFullName: string;
}

const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://agent.aeroglobe.io",
  referer: "https://agent.aeroglobe.io/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

export async function loginAeroglobe(email: string, password: string): Promise<AeroglobeSession> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(`Aeroglobe login HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const body = (await res.json()) as any;
  if (!body?.success) {
    throw new Error(`Aeroglobe login failed: ${body?.message || JSON.stringify(body)}`);
  }

  const r = body.response;
  const access = r?.token?.access;
  const refresh = r?.token?.refresh;
  const orgData = r?.user?.organization_user_data?.organization;
  const orgId = orgData?.organization_id;
  const profiles = orgData?.financial_profiles ?? [];
  const defaultProfile =
    profiles.find((p: any) => p.is_default === "DEFAULT") ?? profiles[0];

  if (!access || !orgId || !defaultProfile?.public_id) {
    throw new Error(
      `Aeroglobe login response missing fields (access=${!!access}, orgId=${!!orgId}, profile=${!!defaultProfile?.public_id})`,
    );
  }

  return {
    accessToken: access,
    refreshToken: refresh,
    organizationId: orgId,
    financialProfileId: defaultProfile.public_id,
    userFullName: r?.user?.full_name ?? "",
  };
}

function generatePollId(): string {
  // Format observed from Aeroglobe UI: W84W + 7 alphanum + _ + 1-3 digits
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let body = "";
  for (let i = 0; i < 7; i += 1) {
    body += chars[Math.floor(Math.random() * chars.length)];
  }
  const tail = Math.floor(Math.random() * 1000);
  return `W84W${body}_${tail}`;
}

interface SearchOpts {
  session: AeroglobeSession;
  origin: AirportCode;
  destination: AirportCode;
  routeType: RouteType;
  departDate: string;        // YYYY-MM-DD
  returnDate?: string | null; // YYYY-MM-DD when routeType=RETURN
}

export async function searchAeroglobe(opts: SearchOpts): Promise<FareRow[]> {
  const pollId = generatePollId();
  const body: Record<string, unknown> = {
    route_type: opts.routeType,
    traveler_count: { adult_count: 1, child_count: 0, infant_count: 0 },
    cabin_class: "ECONOMY",
    // full_result=true forces Aeroglobe to wait for all carrier APIs to
    // respond before returning keep_polling=false. With false, only the
    // fastest cached carrier (usually PIA) makes it into the response.
    full_result: true,
    non_stop_flight: false,
    origin: opts.origin,
    destination: opts.destination,
    departure_date: opts.departDate,
    financial_profile_id: opts.session.financialProfileId,
    poll_id: pollId,
    selected_airlines: [],
    pricing: null,
  };
  if (opts.routeType === "RETURN") {
    if (!opts.returnDate) throw new Error("returnDate required for RETURN searches");
    body.return_date = opts.returnDate;
  }

  let lastResponse: any = null;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${opts.session.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      throw new Error("Aeroglobe search 401 — access token expired, re-login");
    }
    if (!res.ok) {
      throw new Error(`Aeroglobe search HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    lastResponse = json;
    const data = json?.data;
    if (!data) {
      throw new Error(`Aeroglobe search: missing data envelope`);
    }

    const allLegsHaveOptions =
      Array.isArray(data.journey_legs) &&
      data.journey_legs.length > 0 &&
      data.journey_legs.every((leg: any) => Array.isArray(leg.flight_options) && leg.flight_options.length > 0);

    if (data.keep_polling === false && allLegsHaveOptions) {
      return parseFlightOptions(data, opts, pollId);
    }
    if (data.keep_polling === false && !allLegsHaveOptions) {
      // Server says done but no fares — no flights on that date. Return empty cleanly.
      return [];
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Aeroglobe search exhausted ${POLL_MAX_ATTEMPTS} polls without resolving. Last keep_polling=${lastResponse?.data?.keep_polling}`,
  );
}

function parseFlightOptions(data: any, opts: SearchOpts, pollId: string): FareRow[] {
  const legs = data.journey_legs ?? [];
  const sourceUrl = `${SEARCH_URL}#${opts.routeType}_${opts.origin}-${opts.destination}_${opts.departDate}_poll=${pollId}`;
  const scrapedAt = new Date().toISOString();

  // For ONEWAY: single leg, one row per (option × fare_option).
  // For RETURN: leg[0] outbound, leg[1] inbound. Aeroglobe prices a return as
  // a combined option but lists them per leg with the same pricing structure.
  // We emit one row per (outbound option × cheapest fare_option) to keep the
  // table denormalized but small. For RETURN we tag with returnDate.

  const rows: FareRow[] = [];
  const outboundLeg = legs[0];
  if (!outboundLeg) return rows;

  for (const opt of outboundLeg.flight_options ?? []) {
    const airlineName = (opt?.airline?.name as string) || (opt?.name as string) || "";
    const airline = normalizeAirline(airlineName);

    const cheapest = (opt?.fare_options ?? []).reduce((min: any, fo: any) => {
      const v = fo?.price?.total_amount_after_pricing?.value ?? Number.POSITIVE_INFINITY;
      const cur = min?.price?.total_amount_after_pricing?.value ?? Number.POSITIVE_INFINITY;
      return v < cur ? fo : min;
    }, opt?.fare_options?.[0]);

    if (!cheapest) continue;

    const totalAfter = Number(cheapest?.price?.total_amount_after_pricing?.value ?? cheapest?.price?.gross_fare?.value ?? 0);
    const baseFare = Number(cheapest?.price?.base_fare?.value ?? 0);
    const tax = Number(cheapest?.price?.tax?.value ?? 0);

    rows.push({
      origin: opts.origin,
      destination: opts.destination,
      airline,
      flightNumbers: Array.isArray(opt?.flight_numbers) ? opt.flight_numbers : [],
      routeType: opts.routeType,
      departDate: opts.departDate,
      returnDate: opts.routeType === "RETURN" ? opts.returnDate ?? null : null,
      fareTotal: Math.round(totalAfter),
      baseFare: Math.round(baseFare),
      tax: Math.round(tax),
      rbd: cheapest?.rbd ?? null,
      isRefundable: Boolean(cheapest?.is_refundable),
      currency: "PKR",
      source: "aeroglobe",
      sourceUrl,
      scrapedAt,
    });
  }

  return rows;
}

function normalizeAirline(name: string): Airline {
  const n = name.toLowerCase();
  if (n.includes("pakistan international") || n === "pia") return "PIA";
  if (n.includes("airblue") || n.includes("air blue")) return "AirBlue";
  if (n.includes("airsial") || n.includes("air sial")) return "AirSial";
  if (n.includes("flyjinnah") || n.includes("fly jinnah")) return "Flyjinnah";
  return "Unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
