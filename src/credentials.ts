// Hit the REST endpoint directly to avoid the Supabase SDK's WebSocket
// dependency (Node 20 lacks native WS support; Node 22+ has it). Using
// fetch here means the lookup works on either Node version without
// adding `ws` as a dependency.
async function fetchConfigViaRest(supabaseUrl: string, serviceKey: string) {
  const url = `${supabaseUrl}/rest/v1/flight_scraper_config?id=eq.default&select=aeroglobe_email,aeroglobe_password,scrape_enabled`;
  const res = await fetch(url, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase REST ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const rows = (await res.json()) as Array<{
    aeroglobe_email?: string | null;
    aeroglobe_password?: string | null;
    scrape_enabled?: boolean | null;
  }>;
  return rows[0] ?? null;
}

export interface AeroglobeCredentials {
  email: string;
  password: string;
  source: "supabase" | "env";
}

/**
 * Resolves Aeroglobe credentials in this order:
 *   1. flight_scraper_config row in Supabase (admin-managed)
 *   2. AEROGLOBE_EMAIL + AEROGLOBE_PASSWORD env vars (GitHub Secrets fallback)
 *
 * The Supabase row lets ops rotate the password from /admin without
 * touching GitHub Actions secrets.
 */
export async function resolveAeroglobeCredentials(): Promise<AeroglobeCredentials> {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (sbUrl && sbKey) {
    try {
      const data = await fetchConfigViaRest(sbUrl, sbKey);
      if (data) {
        if (data.scrape_enabled === false) {
          throw new Error("[creds] flight_scraper_config.scrape_enabled = false — aborting run");
        }
        if (data.aeroglobe_email && data.aeroglobe_password) {
          return {
            email: data.aeroglobe_email,
            password: data.aeroglobe_password,
            source: "supabase",
          };
        }
        console.warn("[creds] flight_scraper_config row exists but missing email/password — falling back to env");
      }
    } catch (err) {
      // Re-throw scrape_enabled=false errors. Swallow others and fall through to env.
      if ((err as Error).message?.includes("scrape_enabled")) throw err;
      console.warn(`[creds] Supabase REST lookup failed: ${(err as Error).message} — falling back to env`);
    }
  }

  const email = process.env.AEROGLOBE_EMAIL;
  const password = process.env.AEROGLOBE_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Aeroglobe credentials missing. Set them in Supabase flight_scraper_config row OR in AEROGLOBE_EMAIL/AEROGLOBE_PASSWORD env.",
    );
  }
  return { email, password, source: "env" };
}
