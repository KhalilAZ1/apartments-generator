/**
 * Proxy configuration for scraping. Used by processListings and scraper-session to avoid circular deps.
 * Proxy on/off is persisted in settings (admin sets it for everyone).
 */

import * as fs from "fs";
import * as path from "path";
import { getConfig } from "./config/env";
import { getSettings, updateSettings } from "./settings";

const SCRAPERAPI_DISABLED_FILE = path.resolve(__dirname, "..", ".scraperapi_no_credits");

export function isScraperApiDisabled(): boolean {
  try {
    return fs.existsSync(SCRAPERAPI_DISABLED_FILE);
  } catch {
    return false;
  }
}

export function markScraperApiCreditsExhausted(): void {
  try {
    fs.writeFileSync(SCRAPERAPI_DISABLED_FILE, new Date().toISOString(), "utf8");
  } catch (_) {}
}

export function enableProxyForSession(): void {
  updateSettings({ proxyEnabled: true });
}

export function disableProxyForSession(): void {
  updateSettings({ proxyEnabled: false });
}

export function isProxyManuallyEnabled(): boolean {
  return getSettings().proxyEnabled;
}

function parseProxyUrl(proxyUrl: string): { server: string; username?: string; password?: string } | undefined {
  const s = proxyUrl.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    const server = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
    const username = u.username || undefined;
    const password = u.password || undefined;
    return { server, ...(username && { username }), ...(password && { password }) };
  } catch {
    return undefined;
  }
}

const SCRAPERAPI_PROXY_SERVER = "http://proxy-server.scraperapi.com:8001";

export function getProxyForSession(config: ReturnType<typeof getConfig>): { server: string; username?: string; password?: string } | undefined {
  // IMPORTANT: do not use proxy unless it was manually enabled (persisted in settings).
  if (!isProxyManuallyEnabled()) return undefined;
  if (config.SCRAPING_PROXY_URL.trim()) return parseProxyUrl(config.SCRAPING_PROXY_URL);
  if (isScraperApiDisabled()) return undefined;
  const key = config.SCRAPING_PROXY_API_KEY.trim();
  if (!key) return undefined;
  return { server: SCRAPERAPI_PROXY_SERVER, username: "scraperapi", password: key };
}
