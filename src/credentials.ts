import { createClient } from "@supabase/supabase-js";

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
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });
      const { data, error } = await sb
        .from("flight_scraper_config")
        .select("aeroglobe_email, aeroglobe_password, scrape_enabled")
        .eq("id", "default")
        .maybeSingle();

      if (error) {
        console.warn(`[creds] Supabase lookup error: ${error.message} — falling back to env`);
      } else if (data) {
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
      console.warn(`[creds] Supabase lookup threw: ${(err as Error).message} — falling back to env`);
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
