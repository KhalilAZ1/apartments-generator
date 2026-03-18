/**
 * POST /api/process-listings: returns 202 + jobId, runs scrape/Gemini/Drive in background.
 * GET /api/jobs/:jobId: returns current job status and results (for polling).
 */

import { Request, Response } from "express";
import type { Page } from "playwright";
import { scrapeListingGallery, applyHumanLikePage, IMMOWELT_USER_AGENT, SCRAPERAPI_NO_CREDITS_ERROR } from "../scraper/immowelt";
import { getOrCreateSession } from "../scraper-session";
import { downloadImage, processImageWithGemini, GEMINI_IMAGE_MODELS, type GeminiImageModelId } from "../services/gemini";
import { createListingFolder, uploadImageToDrive, uploadTextFileToDrive } from "../services/drive";
import { addJob, updateJob, getJob, isJobCancelled } from "../jobs/store";
import { saveScreenshot, scheduleDeleteScreenshotsForJob } from "../screenshots";
import { saveGeneratedImage, scheduleDeleteGeneratedForJob } from "../generated-images";
import { getConfig } from "../config/env";
import { v4 as uuidv4 } from "uuid";
import { getProxyForSession, markScraperApiCreditsExhausted } from "../proxy-config";
import { ensurePortrait916 } from "../image/format";
import { getSettings } from "../settings";
import type { AuthRole } from "../auth";
import { pickRandomCityAndZip } from "../data/german-cities";
import { recordTiming, getTimingAverages, type SelectionMode as TimingSelectionMode } from "../data/timing-history";

export { getProxyForSession };

/** Serializes "Process listings" scrape runs so one job uses the shared browser at a time (safe concurrency). */
let scraperRunLock: Promise<void> = Promise.resolve();

export interface ListingResult {
  url: string;
  folderUrl?: string;
  imagesFound?: number;
  imagesUsed?: number;
  generatedFiles?: { originalUrl: string; driveFileUrl: string }[];
  screenshots?: { step: string; url: string }[];
  logs: string[];
  error: string | null;
  costUsd?: number;
}

function deriveListingId(url: string): string {
  try {
    const u = new URL(url);
    const pathSegments = u.pathname.split("/").filter(Boolean);
    const last = pathSegments[pathSegments.length - 1];
    if (last && /^[\w-]+$/.test(last)) return last;
    return url.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  } catch {
    return url.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80);
  }
}

function parseModel(value: unknown): GeminiImageModelId {
  if (typeof value === "string" && (GEMINI_IMAGE_MODELS as readonly string[]).includes(value)) {
    return value as GeminiImageModelId;
  }
  return "gemini-2.5-flash-image";
}

async function runInBackground(
  jobId: string,
  trimmed: string[],
  promptStr: string,
  modelId: GeminiImageModelId
): Promise<void> {
  const results: ListingResult[] = [];
  let sessionPage: Page;
  try {
    const { page } = await getOrCreateSession();
    sessionPage = page;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const url of trimmed) {
      updateJob(jobId, {
        addListing: {
          url,
          status: "Failed",
          logs: [`Browser launch failed: ${message}`],
          error: "Could not start browser. Please try again later.",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      });
      results.push({ url, logs: [`Browser launch failed: ${message}`], error: "Could not start browser. Please try again later." });
    }
    updateJob(jobId, { finishedAt: new Date().toISOString() });
    return;
  }

  let page = sessionPage;
  const browser = page.context().browser();
  if (!browser) {
    updateJob(jobId, { finishedAt: new Date().toISOString() });
    return;
  }

  const logTs = () => new Date().toISOString();

  for (let listingIndex = 0; listingIndex < trimmed.length; listingIndex++) {
    if (isJobCancelled(jobId)) {
      updateJob(jobId, { finishedAt: new Date().toISOString() });
      return;
    }
    if (listingIndex > 0) {
      const pauseMs = 4000 + Math.floor(Math.random() * 5000);
      await new Promise((r) => setTimeout(r, pauseMs));
    }

    const url = trimmed[listingIndex];
    const listingLogs: string[] = [];
    const listingId = deriveListingId(url);
    const result: ListingResult = { url, logs: listingLogs, error: null };

    try {
      listingLogs.push(`[${logTs()}] Starting workflow: open URL → handle consent & gallery → select photos → Drive.`);
      updateJob(jobId, {
        addListing: { url, status: "Opening URL…", logs: [...listingLogs], error: null, startedAt: new Date().toISOString() },
      });

      const scrapeStartMs = Date.now();
      let scrapeResult = await scrapeListingGallery(page, url, listingLogs);
      if (isJobCancelled(jobId)) {
        updateJob(jobId, { finishedAt: new Date().toISOString() });
        return;
      }
      // Merge scraper logs into listing log (scraper uses a copy, so we must copy back)
      listingLogs.length = 0;
      listingLogs.push(...scrapeResult.logs);
      const entryAfterScrapeFirst = getJob(jobId)?.listings.find((l) => l.url === url);
      if (entryAfterScrapeFirst) entryAfterScrapeFirst.logs = listingLogs;
      if (scrapeResult.error === SCRAPERAPI_NO_CREDITS_ERROR) {
        markScraperApiCreditsExhausted();
        listingLogs.push("ScraperAPI credits exhausted; proxy disabled and retrying without proxy.");
        try {
          const oldContext = page.context();
          const contextNoProxy = await browser.newContext({
            userAgent: IMMOWELT_USER_AGENT,
            locale: "de-DE",
            viewport: { width: 1920, height: 1080 },
            timezoneId: "Europe/Berlin",
          });
          await oldContext.close();
          page = await contextNoProxy.newPage();
          await applyHumanLikePage(page);
          scrapeResult = await scrapeListingGallery(page, url, listingLogs);
          if (isJobCancelled(jobId)) {
            updateJob(jobId, { finishedAt: new Date().toISOString() });
            return;
          }
          listingLogs.length = 0;
          listingLogs.push(...scrapeResult.logs);
        } catch (retryErr) {
          const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          listingLogs.push(`Retry without proxy failed: ${msg}`);
          result.error = "Proxy credits exhausted and retry without proxy failed.";
          const entry = getJob(jobId)?.listings.find((l) => l.url === url);
          if (entry) {
            entry.status = "Failed";
            entry.logs = listingLogs;
            entry.error = result.error;
            entry.finishedAt = new Date().toISOString();
          }
          results.push(result);
          continue;
        }
      }
      if (scrapeResult.screenshots && scrapeResult.screenshots.length > 0) {
        result.screenshots = scrapeResult.screenshots.map((s) => {
          const filename = saveScreenshot(jobId, listingIndex, s.step, s.base64);
          return { step: s.step, url: `/api/screenshots/${jobId}/${filename}` };
        });
      }
      result.imagesFound = scrapeResult.imageUrls.length;
      const entryAfterScrape = getJob(jobId)?.listings.find((l) => l.url === url);
      if (entryAfterScrape) {
        entryAfterScrape.status = scrapeResult.imageUrls.length > 0 ? `Scraped: found ${scrapeResult.imageUrls.length} images` : "Scraped: no images";
        entryAfterScrape.screenshots = result.screenshots;
      }

      if (scrapeResult.error || scrapeResult.imageUrls.length === 0) {
        result.error = scrapeResult.error ?? "No images found.";
        if (entryAfterScrape) {
          entryAfterScrape.status = "Failed";
          entryAfterScrape.logs = listingLogs;
          entryAfterScrape.error = result.error;
          entryAfterScrape.finishedAt = new Date().toISOString();
        }
        results.push(result);
        continue;
      }

      // Pause for user to select images in the UI; Gemini/Drive run after process-selected.
      const scrapeDurationMs = Date.now() - scrapeStartMs;
      listingLogs.push(`[${logTs()}] Scraped ${scrapeResult.imageUrls.length} images. Select images in the UI, then click "Process with selected".`);
      updateJob(jobId, {
        updateListing: {
          index: listingIndex,
          update: {
            imageUrls: scrapeResult.imageUrls,
            status: "Select images",
            logs: listingLogs,
            rooms: scrapeResult.rooms,
            sizeSqm: scrapeResult.sizeSqm,
            scrapeDurationMs,
            waitingDurationMs: scrapeResult.waitingDurationMs,
            extractDurationMs: scrapeResult.extractDurationMs,
            imagesExtracted: scrapeResult.imageUrls.length,
          },
        },
      });
      results.push(result);
      continue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      listingLogs.push(`Unexpected error: ${message}`);
      result.error = "An unexpected error occurred while processing this listing.";
      const entry = getJob(jobId)?.listings.find((l) => l.url === url);
      if (entry) {
        entry.status = "Failed";
        entry.logs = listingLogs;
        entry.error = result.error;
        entry.finishedAt = new Date().toISOString();
      }
    }
    results.push(result);
  }

  updateJob(jobId, { finishedAt: new Date().toISOString() });
  scheduleDeleteScreenshotsForJob(jobId);
  scheduleDeleteGeneratedForJob(jobId);
}

/** Process a single listing with user-selected image URLs (Gemini + Drive). Called after user selects images. */
export async function processSelectedHandler(req: Request, res: Response): Promise<void> {
  const jobId = req.params.jobId;
  const listingIndex = parseInt(req.params.listingIndex, 10);
  const { selectedUrls, selectionMode, maxImages } = (req.body as {
    selectedUrls?: string[];
    selectionMode?: string;
    maxImages?: number;
  }) || {};
  const job = getJob(jobId);
  if (!job || !Array.isArray(selectedUrls) || selectedUrls.length === 0) {
    res.status(400).json({ error: "Job not found or selectedUrls must be a non-empty array" });
    return;
  }
  if (isJobCancelled(jobId)) {
    res.status(409).json({ error: "Job was cancelled" });
    return;
  }
  const listing = job.listings[listingIndex];
  if (!listing || !listing.imageUrls) {
    res.status(400).json({ error: "Listing not found or not in selection state" });
    return;
  }
  const url = listing.url;
  const set = new Set(listing.imageUrls);
  const valid = selectedUrls.every((u) => set.has(u));
  if (!valid) {
    res.status(400).json({ error: "selectedUrls must be a subset of the scraped image URLs" });
    return;
  }
  const mode: TimingSelectionMode = selectionMode === "auto" ? "auto" : "manual";
  const promptStr = job.promptStr ?? "Make this real estate photo more appealing for social media, vertical format.";
  const modelId = (job.modelId as GeminiImageModelId) ?? "gemini-2.5-flash-image";
  const listingId = deriveListingId(url);
  const listingLogs = [...(listing.logs || [])];
  const logTs = () => new Date().toISOString();
  const processStartMs = Date.now();

  listingLogs.push(`[${logTs()}] User selected ${selectedUrls.length} images. Creating Drive folder…`);
  updateJob(jobId, {
    updateListing: {
      index: listingIndex,
      update: {
        status: "Creating Drive folder…",
        logs: listingLogs,
        processStartedAt: new Date().toISOString(),
      },
    },
  });

  const folderResult = await createListingFolder(listingId, listingLogs);
  if (!folderResult) {
    updateJob(jobId, {
      updateListing: {
        index: listingIndex,
        update: {
          status: "Failed",
          error: "Could not create Google Drive folder.",
          logs: listingLogs,
          finishedAt: new Date().toISOString(),
        },
      },
    });
    res.status(500).json({ error: "Could not create Google Drive folder." });
    return;
  }
  if (isJobCancelled(jobId)) {
    listingLogs.push(`[${logTs()}] Workflow was stopped by user.`);
    updateJob(jobId, {
      updateListing: {
        index: listingIndex,
        update: {
          status: "Stopped",
          logs: listingLogs,
          error: "Workflow was stopped.",
          finishedAt: new Date().toISOString(),
        },
      },
    });
    res.json({ ok: true, cancelled: true });
    return;
  }

  const generatedFiles: { originalUrl: string; driveFileUrl: string; previewUrl?: string }[] = [];
  let apartmentInfoFileUrl: string | undefined;
  let successCount = 0;
  let listingCostUsd = 0;
  const totalImages = selectedUrls.length;
  let styleRef: { buffer: Buffer; mimeType: string } | undefined = undefined;

  for (let i = 0; i < selectedUrls.length; i++) {
    if (isJobCancelled(jobId)) {
      listingLogs.push(`[${logTs()}] Workflow was stopped by user.`);
      updateJob(jobId, {
        updateListing: {
          index: listingIndex,
          update: {
            status: "Stopped",
            logs: listingLogs,
            error: "Workflow was stopped.",
            finishedAt: new Date().toISOString(),
          },
        },
      });
      res.json({ ok: true, cancelled: true });
      return;
    }
    const entryImg = getJob(jobId)?.listings[listingIndex];
    listingLogs.push(`[${logTs()}] Processing image ${i + 1}/${totalImages} with Gemini…`);
    if (entryImg) {
      entryImg.status = `Processing image ${i + 1}/${totalImages} with Gemini…`;
      entryImg.logs = listingLogs;
    }

    const originalUrl = selectedUrls[i];
    const downloaded = await downloadImage(originalUrl, listingLogs);
    if (!downloaded) {
      listingLogs.push(`[${logTs()}] Image ${i + 1}/${totalImages}: download failed, skipping.`);
      continue;
    }

    if (!styleRef) styleRef = { buffer: downloaded.buffer, mimeType: downloaded.mimeType };

    const geminiResult = await processImageWithGemini(
      downloaded.buffer,
      downloaded.mimeType,
      promptStr,
      listingLogs,
      modelId,
      i === 0 ? undefined : styleRef
    );
    if (!geminiResult.success || !geminiResult.imageBuffer) {
      listingLogs.push(`[${logTs()}] Image ${i + 1}/${totalImages}: Gemini did not return an image, skipping.`);
      continue;
    }

    if (typeof geminiResult.costUsd === "number") listingCostUsd += geminiResult.costUsd;

    const finalBuffer = await ensurePortrait916(geminiResult.imageBuffer);
    const finalMimeType = "image/jpeg";

    listingLogs.push(`[${logTs()}] Uploading image ${i + 1}/${totalImages} to Google Drive…`);
    const uploadEntry = getJob(jobId)?.listings[listingIndex];
    if (uploadEntry) {
      uploadEntry.status = `Uploading image ${i + 1}/${totalImages} to Drive…`;
      uploadEntry.logs = listingLogs;
    }

    const uploadResult = await uploadImageToDrive(
      folderResult.folderId,
      finalBuffer,
      successCount + 1,
      listingLogs
    );
    if (!uploadResult) {
      listingLogs.push(`[${logTs()}] Image ${i + 1}/${totalImages}: Drive upload failed, skipping.`);
    }
    if (uploadResult) {
      successCount++;
      const previewFilename = saveGeneratedImage(
        jobId,
        listingIndex,
        successCount,
        finalBuffer,
        finalMimeType
      );
      const previewUrl = `/api/generated/${jobId}/${previewFilename}`;
      generatedFiles.push({ originalUrl, driveFileUrl: uploadResult.webViewLink, previewUrl });
      const entryGen = getJob(jobId)?.listings[listingIndex];
      if (entryGen) entryGen.generatedFiles = [...generatedFiles];
    }
  }

  // Build and upload apartment info (rooms, size, city, zip, approximate rent) to the same Drive folder.
  try {
    const rooms = listing.rooms;
    const sizeSqm = listing.sizeSqm ?? 70;
    const { cityName, zipCode, rentPerSqm } = pickRandomCityAndZip();
    const warmFactor = 1.2;
    // Smaller apartments (fewer rooms) typically have higher €/m²; apply room-based factor.
    const roomFactor =
      rooms == null ? 1
      : rooms <= 1 ? 1.12
      : rooms <= 2 ? 1.05
      : rooms <= 3 ? 1
      : rooms <= 4 ? 0.97
      : 0.93;
    const approximateRentEur = Math.round(rentPerSqm * sizeSqm * warmFactor * roomFactor);
    const lines: string[] = [
      "Apartment information",
      "-------------------",
      rooms != null ? `Rooms: ${rooms}` : "",
      `Size: ${sizeSqm} m²`,
      `City: ${cityName}`,
      `Zip code: ${zipCode}`,
      `Approximate rent (warm): ~${approximateRentEur} €`,
    ].filter(Boolean);
    const content = lines.join("\n");
    let infoFileResult = await uploadTextFileToDrive(
      folderResult.folderId,
      "apartment-info.txt",
      content,
      listingLogs
    );
    if (!infoFileResult && !isJobCancelled(jobId)) {
      listingLogs.push(`[${logTs()}] Retrying apartment-info.txt upload...`);
      await new Promise((r) => setTimeout(r, 2000));
      infoFileResult = await uploadTextFileToDrive(
        folderResult.folderId,
        "apartment-info.txt",
        content,
        listingLogs
      );
    }
    apartmentInfoFileUrl = infoFileResult?.webViewLink ?? undefined;
  } catch (infoErr) {
    const msg = infoErr instanceof Error ? infoErr.message : String(infoErr);
    listingLogs.push(`[${logTs()}] Could not create apartment info file: ${msg}`);
  }

  const finalError =
    successCount === 0
      ? "No images could be generated or uploaded. Expand the listing logs below for details (e.g. download, Gemini, or Drive failure)."
      : undefined;
  const processDurationMs = Date.now() - processStartMs;
  updateJob(jobId, {
    updateListing: {
      index: listingIndex,
      update: {
        status: finalError ? "Completed with errors" : "Done",
        logs: listingLogs,
        error: finalError ?? null,
        finishedAt: new Date().toISOString(),
        folderUrl: folderResult.folderUrl,
        apartmentInfoFileUrl,
        generatedFiles,
        imagesFound: listing.imageUrls?.length,
        imagesUsed: selectedUrls.length,
        screenshots: listing.screenshots,
        costUsd:
          listingCostUsd > 0 ? Math.round(listingCostUsd * 1e4) / 1e4 : undefined,
        imageUrls: undefined,
        processDurationMs,
        imagesProcessed: selectedUrls.length,
      },
    },
  });

  const maxImagesNum = typeof maxImages === "number" && maxImages > 0 ? maxImages : selectedUrls.length;
  if (
    listing.waitingDurationMs != null &&
    listing.extractDurationMs != null &&
    listing.imagesExtracted != null
  ) {
    recordTiming({
      waitingDurationMs: listing.waitingDurationMs,
      extractDurationMs: listing.extractDurationMs,
      imagesExtracted: listing.imagesExtracted,
      processDurationMs,
      imagesProcessed: selectedUrls.length,
      selectionMode: mode,
      maxImages: maxImagesNum,
    });
  }

  res.json({ ok: true });
}

export async function processListingsHandler(req: Request, res: Response): Promise<void> {
  const { urls, prompt, model } = req.body as { urls?: string[]; prompt?: string; model?: string };
  const modelId = parseModel(model);

  if (!Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "urls must be a non-empty array" });
    return;
  }
  if (urls.length > 5) {
    res.status(400).json({ error: "Maximum 5 URLs per request" });
    return;
  }
  const trimmed = (urls as string[]).map((u: string) => String(u).trim()).filter(Boolean);
  if (trimmed.length === 0) {
    res.status(400).json({ error: "No valid URLs provided" });
    return;
  }

  // Host allowlist for non-admin users: only specific domains are permitted.
  const role = (req as Request & { authRole?: AuthRole }).authRole ?? "user";
  if (role !== "admin") {
    const { allowedHostsUser } = getSettings();
    const allowedSet = new Set(allowedHostsUser.map((h) => h.toLowerCase()));
    const invalid = new Set<string>();
    for (const u of trimmed) {
      try {
        const parsed = new URL(u);
        const host = parsed.hostname.toLowerCase();
        if (!allowedSet.has(host)) invalid.add(host);
      } catch {
        // ignore parse errors here; they'll be rejected later by scraper if needed
      }
    }
    if (invalid.size > 0) {
      const allowedBases = Array.from(allowedSet).map((h) => (h.startsWith("www.") ? h.slice(4) : h));
      const uniqueBases = Array.from(new Set(allowedBases));
      const allowedList = uniqueBases.join(", ");
      res.status(400).json({
        error: `Use only these hosts: ${allowedList}`,
        invalidHosts: Array.from(invalid),
      });
      return;
    }
  }
  // Same default as frontend (App.tsx DEFAULT_PROMPT) so unedited prompt is sent to Gemini as-is.
  const DEFAULT_PROMPT = `Edit this photo realistically. Keep the exact same room, same layout, same lighting conditions, and same overall atmosphere. Shift the camera angle to give a fresh perspective of the same space — for example a few degrees to the left or right, or slightly higher or lower viewpoint. Replace some decorative elements such as furniture, wall art, picture frames, throw pillows, vases, candles, small plants. All new decor should feel realistic, cozy, and consistent with the style and color palette already in the room. Do not add or remove rooms or architectural elements. Keep the same natural or artificial lighting as in the reference photo. The result should look like a real interior photograph taken by a real estate photographer or Airbnb host in Germany, not a render or illustration. Photorealistic, high quality, sharp, no people, no text, no watermarks.

Output: single image, vertical (portrait) 9:16 aspect ratio, suitable for TikTok and mobile. Change the viewing/camera angle (e.g. a few degrees left/right or slightly higher/lower) for a fresh perspective.

Avoid: new room, different floor, architectural changes, text, watermark, logo, cartoon, 3D render, CGI, painting, illustration, blurry, overexposed, underexposed, fish-eye distortion, people, faces.`;
  const promptStr =
    typeof prompt === "string" && prompt.trim() ? prompt.trim() : DEFAULT_PROMPT;

  const jobId = uuidv4();
  addJob(jobId);
  updateJob(jobId, { promptStr, modelId });

  res.status(202).json({ jobId });

  // Serialize scraper runs so concurrent users don't share the same browser page.
  scraperRunLock = scraperRunLock.then(() =>
    runInBackground(jobId, trimmed, promptStr, modelId)
  ).catch((err) => {
    console.error("[process-listings] Background job failed:", err);
    const job = getJob(jobId);
    if (job && !job.finishedAt) updateJob(jobId, { finishedAt: new Date().toISOString() });
  });
}
