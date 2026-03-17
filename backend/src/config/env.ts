/**
 * Load and validate environment variables.
 * Drive: use either service account (CREDENTIALS_PATH) or OAuth (CLIENT_ID + CLIENT_SECRET + REFRESH_TOKEN).
 * On error, throws with a clear message listing what is missing or invalid.
 */

export interface EnvConfig {
  GEMINI_API_KEY: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID: string;
  /** Service account JSON path. Set this OR the OAuth trio below. */
  GOOGLE_DRIVE_CREDENTIALS_PATH: string;
  /** OAuth: client ID (use with CLIENT_SECRET + REFRESH_TOKEN instead of CREDENTIALS_PATH). */
  GOOGLE_DRIVE_CLIENT_ID: string;
  GOOGLE_DRIVE_CLIENT_SECRET: string;
  /** OAuth: refresh token from one-time OAuth flow. */
  GOOGLE_DRIVE_REFRESH_TOKEN: string;
  PORT: number;
  NODE_ENV: string;
  /** Optional: full proxy URL. If not set, SCRAPING_PROXY_API_KEY can be used for automatic rotating proxy (ScraperAPI). */
  SCRAPING_PROXY_URL: string;
  /** Optional: ScraperAPI key. When set, proxy is built automatically and IP rotates each session. Ignored if SCRAPING_PROXY_URL is set. */
  SCRAPING_PROXY_API_KEY: string;
}

let cached: EnvConfig | null = null;

function get(key: string): string {
  const value = process.env[key];
  return value === undefined ? "" : String(value).trim();
}

export function loadEnv(): EnvConfig {
  if (cached) return cached;

  const missing: string[] = [];
  const gemini = get("GEMINI_API_KEY");
  const rootFolderId = get("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  if (!gemini) missing.push("GEMINI_API_KEY");
  if (!rootFolderId) missing.push("GOOGLE_DRIVE_ROOT_FOLDER_ID");

  const credentialsPath = get("GOOGLE_DRIVE_CREDENTIALS_PATH");
  const clientId = get("GOOGLE_DRIVE_CLIENT_ID");
  const clientSecret = get("GOOGLE_DRIVE_CLIENT_SECRET");
  const refreshToken = get("GOOGLE_DRIVE_REFRESH_TOKEN");

  const useServiceAccount = !!credentialsPath;
  const useOAuth = !!(clientId && clientSecret && refreshToken);

  if (!useServiceAccount && !useOAuth) {
    if (clientId || clientSecret || refreshToken) {
      const oauthMissing: string[] = [];
      if (!clientId) oauthMissing.push("GOOGLE_DRIVE_CLIENT_ID");
      if (!clientSecret) oauthMissing.push("GOOGLE_DRIVE_CLIENT_SECRET");
      if (!refreshToken) oauthMissing.push("GOOGLE_DRIVE_REFRESH_TOKEN");
      missing.push(
        `Drive OAuth incomplete: ${oauthMissing.join(", ")}. Set all three, or use GOOGLE_DRIVE_CREDENTIALS_PATH (service account) instead.`
      );
    } else {
      missing.push(
        "Google Drive: set either GOOGLE_DRIVE_CREDENTIALS_PATH (service account JSON path) or all of GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN (OAuth)."
      );
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing or invalid configuration: ${missing.join(" | ")}. ` +
        `Set them in the .env file in the project root (or in the directory where you start the server).`
    );
  }

  const portStr = process.env.PORT ?? "3000";
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT: "${portStr}". Must be a number between 1 and 65535. Check the PORT entry in .env.`
    );
  }

  const scrapingProxy = get("SCRAPING_PROXY_URL");
  const scrapingProxyApiKey = get("SCRAPING_PROXY_API_KEY");

  cached = {
    GEMINI_API_KEY: gemini,
    GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId,
    GOOGLE_DRIVE_CREDENTIALS_PATH: credentialsPath,
    GOOGLE_DRIVE_CLIENT_ID: clientId,
    GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
    GOOGLE_DRIVE_REFRESH_TOKEN: refreshToken,
    PORT: port,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    SCRAPING_PROXY_URL: scrapingProxy,
    SCRAPING_PROXY_API_KEY: scrapingProxyApiKey,
  };

  return cached;
}

export function getConfig(): EnvConfig {
  if (!cached) return loadEnv();
  return cached;
}
