/**
 * One browser session with proxy for the app. Reused for "Check scraper IP" and "Process listings"
 * so the same proxy IP is used until the session ends (after a run or idle timeout).
 */

import { Browser, BrowserContext, Page } from "playwright";
import { createBrowser, applyHumanLikePage, IMMOWELT_USER_AGENT } from "./scraper/immowelt";
import { getConfig } from "./config/env";
import { getProxyForSession } from "./proxy-config";

const HTTPBIN_IP_URL = "http://httpbin.org/ip";
const SESSION_IDLE_MS = 15 * 60 * 1000; // 15 minutes

let session: {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  proxyKey: string;
  lastUsedAt: number;
  /** Cached so Check IP always returns the same IP for this session until logout. */
  cachedIp: string | null;
  cachedUsingProxy: boolean;
} | null = null;

function proxyKey(proxy: { server: string; username?: string; password?: string } | undefined): string {
  if (!proxy) return "none";
  return `${proxy.server}|${proxy.username ?? ""}|${proxy.password ?? ""}`;
}

export interface ScraperSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  usingProxy: boolean;
}

/**
 * Get or create the shared scraper session. One IP per session until closeSession() or idle timeout.
 */
export async function getOrCreateSession(): Promise<ScraperSession> {
  const config = getConfig();
  const proxy = getProxyForSession(config);
  const key = proxyKey(proxy);

  const now = Date.now();
  if (session) {
    if (session.proxyKey !== key) {
      await closeSession();
    } else if (now - session.lastUsedAt > SESSION_IDLE_MS) {
      await closeSession();
    } else {
      session.lastUsedAt = now;
      return {
        browser: session.browser,
        context: session.context,
        page: session.page,
        usingProxy: !!proxy,
      };
    }
  }

  const browser = await createBrowser();
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent: IMMOWELT_USER_AGENT,
    locale: "de-DE",
    viewport: { width: 1920, height: 1080 },
    timezoneId: "Europe/Berlin",
  };
  if (proxy) contextOptions.proxy = proxy;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await applyHumanLikePage(page);

  session = {
    browser,
    context,
    page,
    proxyKey: key,
    lastUsedAt: now,
    cachedIp: null,
    cachedUsingProxy: !!proxy,
  };

  return {
    browser,
    context,
    page,
    usingProxy: !!proxy,
  };
}

/**
 * Close the shared session. Call after Process listings run ends so next run gets a new IP.
 */
export async function closeSession(): Promise<void> {
  if (!session) return;
  try {
    await session.context.close();
    await session.browser.close();
  } catch (_) {}
  session = null;
}

/**
 * Return the IP that the current session's proxy exposes (same IP the scraped site sees).
 * Cached per session so every click returns the same IP until the session is closed (logout).
 */
export async function getSessionIp(): Promise<{ ip: string; usingProxy: boolean } | null> {
  const s = await getOrCreateSession();
  if (session?.cachedIp != null) {
    return { ip: session.cachedIp, usingProxy: session.cachedUsingProxy };
  }
  try {
    await s.page.goto(HTTPBIN_IP_URL, { waitUntil: "load", timeout: 15000 });
    const text = (await s.page.textContent("body"))?.trim() ?? "";
    const data = text ? (JSON.parse(text) as { origin?: string }) : {};
    const ip = typeof data?.origin === "string" ? data.origin : null;
    if (ip && session) {
      session.cachedIp = ip;
      session.cachedUsingProxy = s.usingProxy;
      return { ip, usingProxy: s.usingProxy };
    }
  } catch (_) {}
  return null;
}
