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
  /** Number of rooms (Zimmer) if found on the listing page. */
  rooms?: number;
  /** Living area in m² (Wohnfläche) if found on the listing page. */
  sizeSqm?: number;
  /** Time from start until gallery/collect started (ms). For timing history. */
  waitingDurationMs?: number;
  /** Time to collect image URLs after gallery ready (ms). For timing history. */
  extractDurationMs?: number;
}

/** When ScraperAPI returns this error, the route will disable proxy and retry without it. */
export const SCRAPERAPI_NO_CREDITS_ERROR = "SCRAPERAPI_NO_CREDITS";

/**
 * Try to extract number of rooms and living area (m²) from the listing page.
 * Checks body text and page title (e.g. "1 Zimmer • 60 m² • frei ab..." in title).
 */
async function extractListingDetails(page: Page): Promise<{ rooms?: number; sizeSqm?: number }> {
  const result: { rooms?: number; sizeSqm?: number } = {};
  const parseRooms = (text: string): number | undefined => {
    const m = text.match(/(\d+(?:[,.]\d+)?)\s*Zimmer/i);
    if (!m) return undefined;
    const num = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(num) && num >= 1 && num <= 20 ? num : undefined;
  };
  const parseSqm = (text: string): number | undefined => {
    const m = text.match(/(?:Wohnfläche|Fläche|Living area)[\s:]*(\d+(?:[,.]\d+)?)\s*m²/i)
      || text.match(/(\d+(?:[,.]\d+)?)\s*m²/i);
    if (!m) return undefined;
    const num = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(num) && num >= 10 && num <= 500 ? num : undefined;
  };
  try {
    const bodyText = await page.locator("body").first().textContent({ timeout: 5000 }).catch(() => null);
    if (bodyText) {
      result.rooms = parseRooms(bodyText);
      result.sizeSqm = parseSqm(bodyText);
    }
    const pageTitle = await page.title().catch(() => "");
    if (pageTitle) {
      if (result.rooms == null) result.rooms = parseRooms(pageTitle);
      if (result.sizeSqm == null) result.sizeSqm = parseSqm(pageTitle);
    }
  } catch (_) {}
  return result;
}

/**
 * Click "Zurück zur Anzeige" to close the gallery and return to the listing view.
 * Returns true if the button/link was found and clicked.
 */
async function clickBackToListing(page: Page, addLog: (msg: string) => void): Promise<boolean> {
  const backBtn = page.getByRole("button", { name: /Zurück zur Anzeige/i }).first();
  const visible = await backBtn.isVisible().catch(() => false);
  if (visible) {
    const handle = await backBtn.elementHandle();
    if (handle) {
      await humanLikeClick(page, handle);
      addLog('Clicked "Zurück zur Anzeige".');
      return true;
    }
  }
  const link = page.getByText(/Zurück zur Anzeige/i).first();
  const linkVisible = await link.isVisible().catch(() => false);
  if (linkVisible) {
    const handle = await link.elementHandle();
    if (handle) {
      await humanLikeClick(page, handle);
      addLog('Clicked "Zurück zur Anzeige" (link).');
      return true;
    }
  }
  return false;
}

/**
 * Check if URL looks like a real photo (not icon/logo).
 */
function looksLikePhotoUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (u.includes("logo") || u.includes("icon") || u.includes("badge") || u.includes("partner")) return false;
  // Exclude common non-photo assets that often appear in carousels (maps, markers, placeholders).
  if (
    u.includes("staticmap") ||
    u.includes("mapbox") ||
    u.includes("openstreetmap") ||
    u.includes("leaflet") ||
    u.includes("/map") ||
    u.includes("marker") ||
    u.includes("pin") ||
    u.includes("location")
  ) {
    return false;
  }
  const ext = u.split(".").pop()?.split("?")[0];
  return ["jpg", "jpeg", "png", "webp"].includes(ext ?? "");
}

function looksLikeNonPhotoByAlt(alt: string): boolean {
  const a = alt.toLowerCase();
  // Immowelt carousels sometimes include map/location tiles and UI images; exclude those.
  if (/(karte|map|standort|lage|pin|marker|anfahrt)/i.test(a)) return true;
  return false;
}

function canonicalImageKey(url: string): string {
  // Dedupe variants of the same image (different ?w=, ?h=, ci_seal, etc.)
  // For Immowelt MMS URLs, the unique part is the pathname ending with a UUID.jpg.
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    if (host.includes("mms.immowelt.de")) return `mms:${path}`;
    if (host.includes("immowelt.")) return `immowelt:${path}`;
    return `${host}:${path}`;
  } catch {
    return url.split("?")[0];
  }
}

function parseFirstInt(text: string): number | null {
  const m = text.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function detectCarouselTotalInGallery(page: Page, galleryScope: import("playwright").Locator): Promise<number | null> {
  // 1) "Alle X Bilder ansehen"
  const alleText = await galleryScope
    .getByText(/Alle\s+\d+\s+Bilder\s+ansehen/i)
    .first()
    .textContent()
    .catch(() => null);
  if (alleText) {
    const n = parseFirstInt(alleText);
    if (n && n > 0) return n;
  }

  // 2) "1 / X" indicator inside gallery
  const slashText = await galleryScope
    .getByText(/\b\d+\s*\/\s*\d+\b/)
    .first()
    .textContent()
    .catch(() => null);
  if (slashText) {
    const m = slashText.match(/\b(\d+)\s*\/\s*(\d+)\b/);
    if (m) {
      const total = parseInt(m[2], 10);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }

  // 3) aria-label "1 von X" on slide elements
  const slideLabels = await galleryScope.locator("[aria-roledescription='slide'][aria-label]").allTextContents().catch(() => []);
  for (const label of slideLabels) {
    const m = label.match(/\b\d+\s+von\s+(\d+)\b/i);
    if (m) {
      const total = parseInt(m[1], 10);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }

  return null;
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
  const consoleEnabled = (process.env.SCRAPER_CONSOLE_LOG ?? "1").trim() !== "0";
  const addLog = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logs.push(line);
    if (consoleEnabled) console.log(line);
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
    const scrapeStartMs = Date.now();
    let waitingDurationMs: number | undefined;
    let extractDurationMs: number | undefined;
    const setWaitingOnce = () => {
      if (waitingDurationMs === undefined) waitingDurationMs = Date.now() - scrapeStartMs;
    };
    const setExtractBeforeReturn = () => {
      extractDurationMs = Date.now() - scrapeStartMs - (waitingDurationMs ?? 0);
    };

    const cleanUrl = url.split("#")[0];
    addLog(`Navigating to ${cleanUrl}`);
    const response = await page.goto(cleanUrl, { waitUntil: "load", timeout: 45000 });
    addLog(`Navigation finished. HTTP status: ${response ? response.status() : "unknown (no response)"}`);
    if (response && (response.status() === 402 || response.status() === 407)) {
      addLog("Proxy returned no credits (402/407); ScraperAPI credits may be exhausted.");
      return { imageUrls: [], logs, screenshots, error: SCRAPERAPI_NO_CREDITS_ERROR, rooms: undefined, sizeSqm: undefined };
    }
    // Initial human-like pause so content and possible consent popup can appear.
    const afterLoadMs = randomDelay(3000, 6000);
    addLog(`Waiting ${afterLoadMs}ms (human-like pause after load / potential popup)`);
    await sleep(afterLoadMs);
    await captureScreenshot("1. Page loaded");

    const listingDetails = await extractListingDetails(page);
    if (listingDetails.rooms != null || listingDetails.sizeSqm != null) {
      addLog(`Listing details: ${listingDetails.rooms != null ? `${listingDetails.rooms} Zimmer` : ""}${listingDetails.rooms != null && listingDetails.sizeSqm != null ? ", " : ""}${listingDetails.sizeSqm != null ? `${listingDetails.sizeSqm} m²` : ""}`);
    }

    let imageUrls: string[];

    // Always handle consent popup first if present (can appear slightly delayed).
    await handleConsentIfPresent(page, addLog, captureScreenshot, captureAfterClick);

    // PHASE 1: If gallery masonry / "Vollbild-Modus" view is already open, just extract from it.
    const masonryMain = page.locator('main[data-testid="cdp-gallery.MasonryModal.Masonry"]').first();
    const masonryVisible = await masonryMain.isVisible().catch(() => false);
    const fullscreenOnLoad = await findFullscreenButton(page);
    if (masonryVisible || fullscreenOnLoad) {
      addLog(
        masonryVisible
          ? "Masonry gallery modal already visible on load; extracting images from masonry view."
          : '"Vollbild-Modus" button visible on load; treating current view as gallery and extracting images.'
      );
      await sleep(randomDelay(600, 1200));
      await captureScreenshot("2. Gallery already open");
      setWaitingOnce();
      const urls = await collectOverlayOrGalleryImageUrls(page, addLog);
      if (urls.length > 0) {
        addLog(`Found ${urls.length} candidate image(s) from already-open gallery view`);
        const wentBack = await clickBackToListing(page, addLog);
        if (wentBack) {
          await sleep(randomDelay(2000, 4000));
          const detailsFromListing = await extractListingDetails(page);
          const rooms = detailsFromListing.rooms ?? listingDetails.rooms;
          const sizeSqm = detailsFromListing.sizeSqm ?? listingDetails.sizeSqm;
          if (detailsFromListing.rooms != null || detailsFromListing.sizeSqm != null) {
            addLog(`Listing details after returning from gallery: ${rooms != null ? `${rooms} Zimmer` : ""}${rooms != null && sizeSqm != null ? ", " : ""}${sizeSqm != null ? `${sizeSqm} m²` : ""}`);
          }
          setExtractBeforeReturn();
          return { imageUrls: urls, logs, screenshots, error: null, rooms, sizeSqm, waitingDurationMs, extractDurationMs };
        }
        setExtractBeforeReturn();
        return { imageUrls: urls, logs, screenshots, error: null, rooms: listingDetails.rooms, sizeSqm: listingDetails.sizeSqm, waitingDurationMs, extractDurationMs };
      }
      addLog("Gallery view appeared open but returned 0 images; falling back to opening gallery explicitly.");
    }

    // PHASE 2: Click "Alle X Bilder ansehen" to open gallery, then extract from masonry/full gallery.
    const gallerySection = page.locator('section[data-testid="cdp-gallery"]').first();
    const alleButton = await findGalleryButton(page);
    if (alleButton) {
      addLog('Clicking "Alle ... Bilder ansehen" (human-like) to open gallery.');
      await humanLikeClick(page, alleButton);
      await captureAfterClick('Click: "Alle ... Bilder ansehen"');
      const afterClickMs = randomDelay(2500, 5000);
      addLog(`Waiting ${afterClickMs}ms after gallery button click.`);
      await sleep(afterClickMs);
      await handleConsentIfPresent(page, addLog, captureScreenshot, captureAfterClick);

      await captureScreenshot("2. Gallery opened via Alle Bilder ansehen");
      addLog("Collecting images from masonry/full gallery view after clicking Alle Bilder ansehen");
      setWaitingOnce();
      const urls = await collectOverlayOrGalleryImageUrls(page, addLog);
      if (urls.length > 0) {
        addLog(`Found ${urls.length} candidate image(s) from masonry/full gallery view`);
        const wentBack = await clickBackToListing(page, addLog);
        if (wentBack) {
          await sleep(randomDelay(2000, 4000));
          const detailsFromListing = await extractListingDetails(page);
          const rooms = detailsFromListing.rooms ?? listingDetails.rooms;
          const sizeSqm = detailsFromListing.sizeSqm ?? listingDetails.sizeSqm;
          if (detailsFromListing.rooms != null || detailsFromListing.sizeSqm != null) {
            addLog(`Listing details after returning from gallery: ${rooms != null ? `${rooms} Zimmer` : ""}${rooms != null && sizeSqm != null ? ", " : ""}${sizeSqm != null ? `${sizeSqm} m²` : ""}`);
          }
          setExtractBeforeReturn();
          return { imageUrls: urls, logs, screenshots, error: null, rooms, sizeSqm, waitingDurationMs, extractDurationMs };
        }
        setExtractBeforeReturn();
        return { imageUrls: urls, logs, screenshots, error: null, rooms: listingDetails.rooms, sizeSqm: listingDetails.sizeSqm, waitingDurationMs, extractDurationMs };
      }
      addLog('Clicking "Alle ... Bilder ansehen" did not yield any images; falling back to inline carousel.');
    }

    // PHASE 3: Fallback – use inline carousel and "Gehe zur nächsten Folie" until all slides are seen.
    const topCarousel = gallerySection.locator("[aria-roledescription='carousel']").first();
    const topCarouselVisible = await topCarousel.isVisible().catch(() => false);
    if (topCarouselVisible) {
      addLog('Top carousel detected (fallback); collecting images by clicking "Gehe zur nächsten Folie".');
      await sleep(randomDelay(400, 900));
      await captureScreenshot("2. Top carousel detected (fallback)");
      const expected = await detectCarouselTotalInGallery(page, gallerySection);
      if (expected) addLog(`Top carousel total (expected): ${expected}`);
      setWaitingOnce();
      const carouselUrls = await collectGalleryImageUrls(page, addLog);
      if (carouselUrls.length > 0) {
        addLog(`Found ${carouselUrls.length} candidate image(s) from fallback carousel view`);
        setExtractBeforeReturn();
        return { imageUrls: carouselUrls, logs, screenshots, error: null, rooms: listingDetails.rooms, sizeSqm: listingDetails.sizeSqm, waitingDurationMs, extractDurationMs };
      }
    }

    // If everything failed, return a clear error.
    return {
      imageUrls: [],
      logs,
      screenshots,
      error:
        'Could not extract any apartment photos from this listing. The gallery button/carousel structure may have changed.',
      rooms: listingDetails.rooms,
      sizeSqm: listingDetails.sizeSqm,
    };
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
      rooms: undefined,
      sizeSqm: undefined,
    };
  }
}

function normalizeButtonText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

async function isGalleryOpen(page: Page): Promise<boolean> {
  const overlaySelectors = [
    // Common overlay containers
    "[role='dialog']",
    "[class*='overlay']",
    "[class*='lightbox']",
    "[class*='modal']",
    // Carousel/gallery containers
    "[class*='carousel']",
    "[class*='gallery']",
    // React Aria carousel used by Immowelt
    "[aria-roledescription='carousel']",
  ];

  for (const sel of overlaySelectors) {
    const visible = await page.isVisible(sel).catch(() => false);
    if (visible) return true;
  }

  // Many immowelt galleries show a counter like "1/9" on the image.
  const counterVisible = await page
    .getByText(/\b\d+\s*\/\s*\d+\b/)
    .first()
    .isVisible()
    .catch(() => false);
  if (counterVisible) return true;

  // Some Immowelt gallery views show a dedicated "Vollbild-Modus" button and/or a "Zurück zur Anzeige" back button.
  const fullscreenVisible = await page.getByText(/Vollbild-Modus/i).first().isVisible().catch(() => false);
  if (fullscreenVisible) return true;

  const backToListingVisible = await page.getByText(/Zurück zur Anzeige/i).first().isVisible().catch(() => false);
  if (backToListingVisible) return true;

  // Slide labels like "1 von 9" are common in the carousel DOM.
  const vonCounterVisible = await page.getByText(/\b\d+\s+von\s+\d+\b/i).first().isVisible().catch(() => false);
  if (vonCounterVisible) return true;

  // If there are multiple large images in typical overlay containers, treat it as open.
  const overlayImageSelectors = [
    "[role='dialog'] img",
    "[class*='overlay'] img",
    "[class*='lightbox'] img",
    "[class*='modal'] img",
    "[class*='carousel'] img",
    "[class*='gallery'] img",
    "[aria-roledescription='carousel'] img",
  ];
  for (const sel of overlayImageSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count >= 1) return true;
  }

  return false;
}

async function waitForGalleryOpen(page: Page, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isGalleryOpen(page)) return true;
    await sleep(randomDelay(250, 450));
  }
  return false;
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
  const dataSrc = await img.getAttribute("data-src");
  const dataSrcset = await img.getAttribute("data-srcset");
  // Some sites lazy-load via data-src / data-srcset; prefer real src/srcset but fall back.
  const rawCandidate =
    src ??
    dataSrc ??
    (srcset ? srcset.split(",")[0].trim().split(/\s+/)[0] : null) ??
    (dataSrcset ? dataSrcset.split(",")[0].trim().split(/\s+/)[0] : null);
  let raw = rawCandidate;
  if (!raw) return null;
  const resolved = resolveSrc(raw, page.url());
  if (!looksLikePhotoUrl(resolved)) return null;
  const alt = (await img.getAttribute("alt").catch(() => null)) ?? "";
  if (alt && looksLikeNonPhotoByAlt(alt)) return null;
  const width = await img.getAttribute("width").then((w) => (w ? parseInt(w, 10) : undefined));
  const height = await img.getAttribute("height").then((h) => (h ? parseInt(h, 10) : undefined));
  if (!isReasonableImage(resolved, width, height)) return null;
  return resolved;
}

async function getSourceUrl(source: ElementHandle, page: Page): Promise<string | null> {
  const srcset = await source.getAttribute("srcset");
  const dataSrcset = await source.getAttribute("data-srcset");
  const raw = srcset ?? dataSrcset ?? null;
  if (!raw) return null;
  const first = raw.split(",")[0].trim().split(/\s+/)[0];
  if (!first) return null;
  const resolved = resolveSrc(first, page.url());
  return looksLikePhotoUrl(resolved) ? resolved : null;
}

async function collectOverlayOrGalleryImageUrls(page: Page, addLog: (msg: string) => void): Promise<string[]> {
  // In fullscreen gallery view, the listing-page gallery section may no longer be the right scope.
  // Prefer the masonry modal that holds exactly the listing images, otherwise fall back.
  const overlay = page
    .locator("[role='dialog'], [class*='overlay'], [class*='lightbox'], [class*='modal']")
    .filter({ has: page.locator("img") })
    .first();

  const overlayVisible = await overlay.isVisible().catch(() => false);
  if (!overlayVisible) {
    // Typical Immowelt case: the masonry gallery modal with exactly the N listing photos.
    const masonry = page.locator('main[data-testid="cdp-gallery.MasonryModal.Masonry"]').first();
    const masonryVisible = await masonry.isVisible().catch(() => false);
    if (!masonryVisible) {
      return collectGalleryImageUrls(page, addLog);
    }

    const buttons = masonry.locator('button[data-testid^="cdp-gallery.MasonryModal.Masonry.Image."]');
    const count = await buttons.count().catch(() => 0);
    const urls = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      const imgHandle = await btn.locator("img").first().elementHandle().catch(() => null);
      if (!imgHandle) continue;
      const resolved = await getImageUrl(imgHandle, page);
      if (resolved) urls.set(canonicalImageKey(resolved), resolved);
    }
    addLog(`Collected ${urls.size} unique image URL(s) from masonry gallery modal`);
    return Array.from(urls.values());
  }

  const urls = new Map<string, string>();
  const imgs = await overlay.locator("img").elementHandles().catch(() => []);
  for (const img of imgs) {
    const resolved = await getImageUrl(img, page);
    if (resolved) urls.set(canonicalImageKey(resolved), resolved);
  }
  const sources = await overlay.locator("source").elementHandles().catch(() => []);
  for (const s of sources) {
    const resolved = await getSourceUrl(s, page);
    if (resolved) urls.set(canonicalImageKey(resolved), resolved);
  }
  addLog(`Collected ${urls.size} unique image URL(s) from overlay/fullscreen view`);
  return Array.from(urls.values());
}

async function collectGalleryImageUrls(
  page: Page,
  addLog: (msg: string) => void
): Promise<string[]> {
  const urls = new Map<string, string>();
  const baseUrl = page.url();

  const findBestImageContainer = async (): Promise<import("playwright").Locator | null> => {
    // Hard scope to the MAIN listing gallery, so we don't pick up similar listings carousels.
    const gallerySection = page.locator('section[data-testid="cdp-gallery"]').first();
    const galleryVisible = await gallerySection.isVisible().catch(() => false);
    if (galleryVisible) {
      // Immowelt renders an outer "carousel" wrapper (tablist) and an inner carousel with an id (e.g. _R_...),
      // where the next/prev buttons reference aria-controls="<id>".
      const innerCarousel = gallerySection.locator("[aria-roledescription='carousel'][id]").first();
      if (await innerCarousel.isVisible().catch(() => false)) {
        const id = await innerCarousel.getAttribute("id").catch(() => null);
        addLog(`Using main gallery inner carousel as container${id ? ` (id=${id})` : ""}`);
        return innerCarousel;
      }

      // Fallback: any visible carousel inside the gallery section that actually contains images.
      const anyCarousel = gallerySection.locator("[aria-roledescription='carousel']").filter({ has: gallerySection.locator("img") }).first();
      if (await anyCarousel.isVisible().catch(() => false)) {
        addLog("Using main gallery carousel (fallback) as container");
        return anyCarousel;
      }
    }

    // Fallback: if the overlay/gallery opens as a dialog, use it (still prefer images only inside it).
    const dialog = page.locator("[role='dialog']").first();
    if (await dialog.isVisible().catch(() => false)) {
      addLog("Using dialog overlay as image container");
      return dialog;
    }

    return null;
  };

  const container = await findBestImageContainer();
  const galleryScope = page.locator('section[data-testid="cdp-gallery"]').first();

  const collectFrom = async (root: import("playwright").Locator, label: string) => {
    const before = urls.size;
    // Only search inside the chosen container.
    const imgs = await root.locator("img").elementHandles().catch(() => []);
    for (const img of imgs) {
      const resolved = await getImageUrl(img, page);
      if (resolved) urls.set(canonicalImageKey(resolved), resolved);
    }
    const sources = await root.locator("source").elementHandles().catch(() => []);
    for (const s of sources) {
      const resolved = await getSourceUrl(s, page);
      if (resolved) urls.set(canonicalImageKey(resolved), resolved);
    }
    const gained = urls.size - before;
    if (gained > 0) addLog(`+${gained} image(s) from ${label}`);
  };

  if (container) {
    // First pass: whatever is already visible in the media container.
    await collectFrom(container, "initial media container");

    // Immowelt often lazy-loads more images. Trigger lazy-loading by scrolling.
    const scrollAttempts = 6;
    for (let i = 0; i < scrollAttempts; i++) {
      try {
        await page.mouse.wheel(0, 900);
      } catch (_) {}
      await sleep(randomDelay(250, 450));
      await collectFrom(container, `scroll ${i + 1}/${scrollAttempts}`);
    }

    // Step through carousel slides if next button exists inside the container.
    const carouselId = await container.getAttribute("id").catch(() => null);
    const galleryScope = page.locator('section[data-testid="cdp-gallery"]').first();
    const nextBtn = carouselId
      ? // Buttons are frequently rendered as siblings; scope to main gallery section to avoid similar listings.
        galleryScope.locator(`button[aria-controls="${carouselId}"][aria-label="Gehe zur nächsten Folie"]`).first()
      : // Fallback: try inside container by accessible name.
        container.getByRole("button", { name: /Gehe zur nächsten Folie/i }).first();

    const hasNext = await nextBtn.isVisible().catch(() => false);
    if (hasNext) {
      const total = await detectCarouselTotalInGallery(page, galleryScope);
      if (total) addLog(`Detected carousel total: ${total}`);
      addLog(
        `Carousel next button detected${carouselId ? ` (aria-controls=${carouselId})` : ""}; stepping through slides to collect more images.`
      );
      const maxSteps = total ? Math.max(1, total - 1) : 25;
      const seenCurrent: string[] = [];
      let stagnant = 0;
      for (let step = 0; step < maxSteps; step++) {
        const before = urls.size;
        await nextBtn.click({ timeout: 2000 }).catch(() => null);
        // wait a bit longer; immowelt lazy-loads the image element for the next slide
        await sleep(randomDelay(350, 700));
        await collectFrom(container, `carousel step ${step + 1}`);
        // Stop if we appear to loop (current slide aria-label repeats a few times).
        const currentLabel = await galleryScope
          .locator("[aria-roledescription='slide'][aria-current='true']")
          .first()
          .getAttribute("aria-label")
          .catch(() => null);
        if (currentLabel) {
          seenCurrent.push(currentLabel);
          if (seenCurrent.length > 6) seenCurrent.shift();
          const repeats = seenCurrent.filter((x) => x === currentLabel).length;
          if (repeats >= 3) {
            addLog(`Detected carousel loop at "${currentLabel}", stopping.`);
            break;
          }
        }
        if (urls.size === before) stagnant++;
        else stagnant = 0;
        if (stagnant >= 3) break;
      }
    }
  }

  if (urls.size === 0) {
    addLog("No images found inside scoped container; skipping full-page fallback to avoid similar listings images.");
  }

  addLog(`Collected ${urls.size} unique image URL(s) from page`);
  return Array.from(urls.values());
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
