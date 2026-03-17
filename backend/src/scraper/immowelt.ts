/**
 * Scrape listing gallery: open page, click gallery button, collect candidate image URLs.
 * Designed for immowelt.at but not hard-coded to that domain.
 * Uses human-like delays and interactions to reduce bot detection.
 */

import { chromium, Browser, Page, ElementHandle, Frame } from "playwright";

/** Random delay in ms between min and max (inclusive). */
function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/** Wait a random amount of time (human-like hesitation). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GALLERY_BUTTON_PATTERNS = [
  /Alle\s+\d+\s*Bilder\s*ansehen/i,
  /Alle\s+\d+\s*Fotos\s*ansehen/i,
  /Alle\s+\d+\s*Bilder/i,
  /Alle\s+\d+\s*Fotos/i,
  /\d+\s*Bilder\s*ansehen/i,
  /\d+\s*Fotos\s*ansehen/i,
  /Bilder\s*ansehen/i,
  /Fotos\s*ansehen/i,
  /Galerie\s*öffnen/i,
  /alle\s*bilder/i,
  /alle\s*fotos/i,
];

const MIN_IMAGE_WIDTH = 100;
const MIN_IMAGE_HEIGHT = 100;
const MAX_ICON_SIZE = 80;

export interface ScrapeScreenshot {
  step: string;
  base64: string;
}

export interface ScrapeResult {
  imageUrls: string[];
  logs: string[];
  screenshots: ScrapeScreenshot[];
  error: string | null;
}

/** When ScraperAPI returns this error, the route will disable proxy and retry without it. */
export const SCRAPERAPI_NO_CREDITS_ERROR = "SCRAPERAPI_NO_CREDITS";

/**
 * Check if URL looks like a real photo (not icon/logo).
 */
function looksLikePhotoUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes("logo") || u.includes("icon") || u.includes("badge") || u.includes("partner")) return false;
  const ext = u.split(".").pop()?.split("?")[0];
  return ["jpg", "jpeg", "png", "webp"].includes(ext ?? "");
}

/**
 * Filter out SVGs and tiny images by URL/size hints.
 */
function isReasonableImage(src: string, width?: number, height?: number): boolean {
  if (src.toLowerCase().includes(".svg")) return false;
  if (width != null && height != null) {
    if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) return false;
    if (width <= MAX_ICON_SIZE && height <= MAX_ICON_SIZE) return false;
  }
  return true;
}

/**
 * Scrape a single listing URL: navigate, open gallery, collect image URLs.
 * Caller is responsible for browser lifecycle; pass a page (can be reused).
 */
export async function scrapeListingGallery(
  page: Page,
  url: string,
  existingLogs: string[] = []
): Promise<ScrapeResult> {
  const logs = [...existingLogs];
  const screenshots: ScrapeScreenshot[] = [];
  const addLog = (msg: string) => {
    logs.push(`[${new Date().toISOString()}] ${msg}`);
  };

  const captureScreenshot = async (step: string, timeoutMs = 10000) => {
    try {
      const buffer = await page.screenshot({ type: "png", timeout: timeoutMs });
      screenshots.push({ step, base64: buffer.toString("base64") });
    } catch (e) {
      addLog(`Screenshot ${step} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Take a screenshot after a button click; short delay so the page has time to update. */
  const captureAfterClick = async (step: string) => {
    await sleep(randomDelay(400, 800));
    await captureScreenshot(step);
  };

  try {
    const cleanUrl = url.split("#")[0];
    addLog(`Navigating to ${cleanUrl}`);
    const response = await page.goto(cleanUrl, { waitUntil: "load", timeout: 45000 });
    if (response && (response.status() === 402 || response.status() === 407)) {
      addLog("Proxy returned no credits (402/407); ScraperAPI credits may be exhausted.");
      return { imageUrls: [], logs, screenshots, error: SCRAPERAPI_NO_CREDITS_ERROR };
    }
    // Initial human-like pause so content and possible consent popup can appear.
    const afterLoadMs = randomDelay(3000, 6000);
    addLog(`Waiting ${afterLoadMs}ms (human-like pause after load / potential popup)`);
    await sleep(afterLoadMs);
    await captureScreenshot("1. Page loaded");

    let imageUrls: string[];

    // Always handle consent popup first if present (can appear slightly delayed).
    await handleConsentIfPresent(page, addLog, captureScreenshot, captureAfterClick);

    // Determine how to reach the gallery. Target state is a view that contains a "Vollbild-Modus" button.
    addLog('Checking if gallery is already open (looking for "Vollbild-Modus").');
    let fullscreenButton = await findFullscreenButton(page);

    if (!fullscreenButton) {
      addLog('Gallery not open yet; looking for "Alle ... Bilder ansehen" button to open it.');
      const galleryButton = await findGalleryButton(page);
      if (!galleryButton) {
        return {
          imageUrls: [],
          logs,
          screenshots,
          error:
            'Could not find the gallery button ("Alle ... Bilder ansehen") or the gallery view ("Vollbild-Modus"). The page layout may have changed.',
        };
      }

      addLog('Clicking "Alle ... Bilder ansehen" (human-like) to open gallery.');
      await humanLikeClick(page, galleryButton);
      await captureAfterClick('Click: "Alle ... Bilder ansehen"');
      const afterClickMs = randomDelay(2500, 5000);
      addLog(`Waiting ${afterClickMs}ms after gallery button click.`);
      await sleep(afterClickMs);

      // Popup may appear right after click as well; handle it again just in case.
      await handleConsentIfPresent(page, addLog, captureScreenshot, captureAfterClick);

      addLog('Re-checking for "Vollbild-Modus" after opening gallery.');
      fullscreenButton = await findFullscreenButton(page);
      if (!fullscreenButton) {
        return {
          imageUrls: [],
          logs,
          screenshots,
          error:
            'Tried to open the gallery via "Alle ... Bilder ansehen", but could not find the "Vollbild-Modus" button. The gallery overlay may have changed.',
        };
      }
    } else {
      addLog('"Vollbild-Modus" button is already present; treating current view as gallery.');
    }

    // Delay so any consent/settings modal is fully closed and gallery is visible before screenshot
    await sleep(randomDelay(800, 1500));
    await captureScreenshot("2. Gallery opened (Vollbild-Modus visible)");
    addLog("Collecting images from gallery view");
    imageUrls = await collectGalleryImageUrls(page, addLog);

    if (imageUrls.length === 0) {
      return {
        imageUrls: [],
        logs,
        screenshots,
        error: "No apartment photos could be found on this page. The gallery button may be missing or the page layout may have changed.",
      };
    }

    addLog(`Found ${imageUrls.length} candidate image(s)`);
    return { imageUrls, logs, screenshots, error: null };
  } catch (err) {
    try {
      await captureScreenshot("Error state (what the browser showed when it failed)", 5000);
    } catch (_) {}
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    addLog(`Scrape error: ${message}`);
    if (stack) addLog(`Stack: ${stack.split("\n").slice(0, 3).join(" ")}`);
    return {
      imageUrls: [],
      logs,
      screenshots,
      error: `Loading the listing page failed: ${message}. Check the step log and screenshots below for details.`,
    };
  }
}

function normalizeButtonText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

/**
 * Scroll element into view, move mouse to it with a small random offset, then click (slower, human-like).
 */
async function humanLikeClick(page: Page, element: ElementHandle): Promise<void> {
  await element.scrollIntoViewIfNeeded();
  await sleep(randomDelay(200, 600));
  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }
  const x = box.x + box.width / 2 + randomDelay(-8, 8);
  const y = box.y + box.height / 2 + randomDelay(-8, 8);
  await page.mouse.move(x, y, { steps: randomDelay(5, 12) });
  await sleep(randomDelay(100, 400));
  await page.mouse.click(x, y, { delay: randomDelay(50, 150) });
}

async function findGalleryButton(page: Page): Promise<ElementHandle | null> {
  const selector = `a, button, [role="button"], [onclick], [class*="gallery"], [class*="image"], [data-testid]`;
  const elements = await page.$$(selector);
  for (const el of elements) {
    const text = normalizeButtonText((await el.textContent().catch(() => "")) ?? "");
    if (!text) continue;
    for (const pattern of GALLERY_BUTTON_PATTERNS) {
      if (pattern.test(text)) {
        return el;
      }
    }
  }
  return null;
}

/**
 * Find and click a button by text inside a single frame (main or iframe).
 * Consent dialogs can be in iframes, so we must search all frames.
 */
async function clickButtonByTextInFrame(
  frame: Frame,
  patterns: RegExp[],
  addLog: (msg: string) => void,
  labelForLog: string,
  afterClick?: () => Promise<void>
): Promise<boolean> {
  const selector = "button, [role='button'], a";
  const elements = await frame.$$(selector).catch(() => []);
  for (const el of elements) {
    const text = normalizeButtonText((await el.textContent().catch(() => "")) ?? "");
    if (!text) continue;
    if (patterns.some((re) => re.test(text))) {
      addLog(`Clicking button "${text}" (${labelForLog}).`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await sleep(randomDelay(100, 300));
      await el.click({ delay: randomDelay(50, 150) });
      if (afterClick) await afterClick();
      return true;
    }
  }
  return false;
}

/**
 * Try to find and click a button by text in the main page and in all iframes.
 */
async function clickButtonByTextAnyFrame(
  page: Page,
  patterns: RegExp[],
  addLog: (msg: string) => void,
  labelForLog: string,
  afterClick?: () => Promise<void>
): Promise<boolean> {
  // Main frame first (page is the main frame's context)
  const mainClicked = await clickButtonByText(page, patterns, addLog, labelForLog, afterClick);
  if (mainClicked) return true;
  // Then every other frame (consent is often in an iframe)
  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    const clicked = await clickButtonByTextInFrame(frame, patterns, addLog, labelForLog, afterClick);
    if (clicked) return true;
  }
  return false;
}

/**
 * Wait and retry finding/clicking a button in any frame (for "Alle ablehnen" which may appear after a delay).
 */
async function waitAndClickButtonByTextAnyFrame(
  page: Page,
  patterns: RegExp[],
  addLog: (msg: string) => void,
  labelForLog: string,
  timeoutMs: number,
  afterClick?: () => Promise<void>
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const clicked = await clickButtonByTextAnyFrame(page, patterns, addLog, labelForLog, afterClick);
    if (clicked) return true;
    await sleep(randomDelay(250, 450));
  }
  return false;
}

/**
 * Immowelt shows a cookie consent popup that can be in the main page or in an iframe.
 * We detect it by looking for the button "Einstellungen oder ablehnen" (not by body text, which fails in iframes).
 * Click "Einstellungen oder ablehnen" then "Alle ablehnen". Repeat until no consent button is found.
 */
async function handleConsentIfPresent(
  page: Page,
  addLog: (msg: string) => void,
  captureScreenshot: (step: string, timeoutMs?: number) => Promise<void>,
  captureAfterClick: (step: string) => Promise<void>
): Promise<boolean> {
  try {
    let dismissed = false;
    // Keep trying until we don't find the first consent button (handles multiple layers or reappearing popup)
    while (true) {
      const firstClicked = await clickButtonByTextAnyFrame(
        page,
        [/Einstellungen oder ablehnen/i],
        addLog,
        "Einstellungen oder ablehnen",
        async () => captureAfterClick('Click: "Einstellungen oder ablehnen"')
      );
      if (!firstClicked) break;
      dismissed = true;
      await sleep(randomDelay(900, 1600));

      // "Alles ablehnen" (Reject all) is used in the "Einstellungen verwalten" modal; some sites use "Alle ablehnen"
      const secondClicked = await waitAndClickButtonByTextAnyFrame(
        page,
        [/All(?:e|es) ablehnen/i],
        addLog,
        "Alle/Alles ablehnen",
        3500,
        async () => captureAfterClick('Click: "Alles ablehnen" / "Alle ablehnen"')
      );
      if (!secondClicked) {
        addLog('Consent dialog opened but could not find "Alle ablehnen" / "Alles ablehnen" button.');
        break;
      }
      addLog("Consent popup dismissed (Alle/Alles ablehnen).");
      await sleep(randomDelay(800, 1500));
    }
    return dismissed;
  } catch (e) {
    addLog(`Error while trying to dismiss cookie popup: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function clickButtonByText(
  page: Page,
  patterns: RegExp[],
  addLog: (msg: string) => void,
  labelForLog: string,
  afterClick?: () => Promise<void>
): Promise<boolean> {
  const selector = "button, [role='button'], a";
  const elements = await page.$$(selector);
  for (const el of elements) {
    const text = normalizeButtonText((await el.textContent().catch(() => "")) ?? "");
    if (!text) continue;
    if (patterns.some((re) => re.test(text))) {
      addLog(`Clicking button "${text}" (${labelForLog}).`);
      await humanLikeClick(page, el);
      if (afterClick) await afterClick();
      return true;
    }
  }
  return false;
}

async function waitAndClickButtonByText(
  page: Page,
  patterns: RegExp[],
  addLog: (msg: string) => void,
  labelForLog: string,
  timeoutMs: number,
  afterClick?: () => Promise<void>
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const clicked = await clickButtonByText(page, patterns, addLog, labelForLog, afterClick);
    if (clicked) return true;
    await sleep(randomDelay(250, 450));
  }
  return false;
}

async function findFullscreenButton(page: Page): Promise<ElementHandle | null> {
  const selector = "button, [role='button'], a";
  const elements = await page.$$(selector);
  for (const el of elements) {
    const text = normalizeButtonText((await el.textContent().catch(() => "")) ?? "");
    if (!text) continue;
    if (/Vollbild-Modus/i.test(text)) {
      return el;
    }
  }
  return null;
}

function resolveSrc(src: string, baseUrl: string): string {
  if (src.startsWith("http")) return src;
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return new URL(src, baseUrl).href;
  return new URL(src, baseUrl).href;
}

async function getImageUrl(img: ElementHandle, page: Page): Promise<string | null> {
  const src = await img.getAttribute("src");
  const srcset = await img.getAttribute("srcset");
  let raw = src ?? (srcset ? srcset.split(",")[0].trim().split(/\s+/)[0] : null);
  if (!raw) return null;
  const resolved = resolveSrc(raw, page.url());
  if (!looksLikePhotoUrl(resolved)) return null;
  const width = await img.getAttribute("width").then((w) => (w ? parseInt(w, 10) : undefined));
  const height = await img.getAttribute("height").then((h) => (h ? parseInt(h, 10) : undefined));
  if (!isReasonableImage(resolved, width, height)) return null;
  return resolved;
}

async function collectGalleryImageUrls(
  page: Page,
  addLog: (msg: string) => void
): Promise<string[]> {
  const urls = new Set<string>();
  const baseUrl = page.url();

  const selectors = [
    "[class*='gallery'] img",
    "[class*='lightbox'] img",
    "[class*='modal'] img",
    "[class*='overlay'] img",
    "[class*='carousel'] img",
    "[class*='masonry'] img",
    "[class*='image'] img",
    ".slick-slide img",
    "[data-gallery] img",
    "picture img",
    "img[src*='immowelt']",
    "img[src*='mms.']",
    "img[src*='cloudfront']",
    "main img",
    "[class*='Expose'] img",
    "[class*='expose'] img",
  ];

  for (const sel of selectors) {
    try {
      const imgs = await page.$$(sel);
      for (const img of imgs) {
        const resolved = await getImageUrl(img, page);
        if (resolved) urls.add(resolved);
      }
    } catch {
      // selector might not match
    }
  }

  if (urls.size === 0) {
    const allImgs = await page.$$("img");
    for (const img of allImgs) {
      const resolved = await getImageUrl(img, page);
      if (resolved) urls.add(resolved);
    }
  }

  addLog(`Collected ${urls.size} image URL(s) from page`);
  return Array.from(urls);
}

/** Realistic Chrome user agent (desktop, recent). Exported for context setup. */
export const IMMOWELT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Create a browser instance with human-like / anti-detection settings.
 * Caller must close it when done.
 */
export async function createBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--disable-extensions",
      "--disable-default-apps",
      "--no-first-run",
      "--window-size=1920,1080",
    ],
  });
}

/**
 * Apply human-like page setup: viewport, UA, locale, and scripts to reduce automation detection.
 */
export async function applyHumanLikePage(page: import("playwright").Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
  });
  await page.addInitScript(() => {
    const nav = (globalThis as any).navigator;
    if (nav) {
      Object.defineProperty(nav, "webdriver", { get: () => undefined });
    }
    try {
      (globalThis as any).chrome = { runtime: {} };
    } catch (_) {}
  });
}
