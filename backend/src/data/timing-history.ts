/**
 * In-memory timing history from completed listing process-selected runs.
 * Three-step estimate: waiting + (extractPerImage × N) + (processPerImage × N).
 * Averages are filtered by selectionMode and optionally by maxImages for precision.
 */

export type SelectionMode = "manual" | "auto";

export interface TimingRecord {
  waitingDurationMs: number;
  extractDurationMs: number;
  imagesExtracted: number;
  processDurationMs: number;
  imagesProcessed: number;
  selectionMode: SelectionMode;
  maxImages: number;
}

const MAX_RECORDS = 50;
const memory: TimingRecord[] = [];

export function recordTiming(record: TimingRecord): void {
  memory.unshift(record);
  if (memory.length > MAX_RECORDS) memory.pop();
}

/** Defaults when no history (seconds). */
const DEFAULT_WAITING_SEC = 25;
const DEFAULT_EXTRACT_PER_IMAGE_SEC = 2;
const DEFAULT_PROCESS_PER_IMAGE_SEC = 10;

export interface TimingAverages {
  avgWaitingMs: number;
  avgExtractPerImageMs: number;
  avgProcessPerImageMs: number;
}

function filterByModeAndMax(
  records: TimingRecord[],
  selectionMode?: SelectionMode,
  maxImages?: number
): TimingRecord[] {
  let filtered = records;
  if (selectionMode) {
    filtered = filtered.filter((r) => r.selectionMode === selectionMode);
  }
  if (maxImages != null && maxImages > 0) {
    const bucket = Math.min(10, maxImages);
    filtered = filtered.filter((r) => Math.min(10, r.maxImages) === bucket);
  }
  return filtered;
}

export function getTimingAverages(
  selectionMode?: SelectionMode,
  maxImages?: number
): TimingAverages {
  let filtered = filterByModeAndMax(memory, selectionMode, maxImages);
  if (filtered.length === 0) {
    filtered = filterByModeAndMax(memory, selectionMode);
  }
  if (filtered.length === 0) {
    filtered = memory;
  }
  if (filtered.length === 0) {
    return {
      avgWaitingMs: DEFAULT_WAITING_SEC * 1000,
      avgExtractPerImageMs: DEFAULT_EXTRACT_PER_IMAGE_SEC * 1000,
      avgProcessPerImageMs: DEFAULT_PROCESS_PER_IMAGE_SEC * 1000,
    };
  }
  const totalWaiting = filtered.reduce((s, r) => s + r.waitingDurationMs, 0);
  const totalExtract = filtered.reduce((s, r) => s + r.extractDurationMs, 0);
  const totalExtractImages = filtered.reduce((s, r) => s + r.imagesExtracted, 0);
  const totalProcess = filtered.reduce((s, r) => s + r.processDurationMs, 0);
  const totalProcessImages = filtered.reduce((s, r) => s + r.imagesProcessed, 0);
  return {
    avgWaitingMs: Math.round(totalWaiting / filtered.length),
    avgExtractPerImageMs:
      totalExtractImages > 0 ? Math.round(totalExtract / totalExtractImages) : DEFAULT_EXTRACT_PER_IMAGE_SEC * 1000,
    avgProcessPerImageMs:
      totalProcessImages > 0 ? Math.round(totalProcess / totalProcessImages) : DEFAULT_PROCESS_PER_IMAGE_SEC * 1000,
  };
}

export interface ListingForEstimate {
  status: string;
  scrapeDurationMs?: number;
  waitingDurationMs?: number;
  extractDurationMs?: number;
  imagesExtracted?: number;
  finishedAt?: string;
  error?: string | null;
  imageUrls?: string[];
}

export type EstimatePhase = "scrape" | "process" | "full";

/**
 * Estimate remaining time (ms).
 * - full: waiting + (extractPerImage × N) + (processPerImage × N) for whole pipeline.
 * - scrape: only waiting + (extractPerImage × N) for listings not yet scraped (manual step 1).
 * - process: only (processPerImage × N) for process step (manual step 2, or for auto not used alone).
 * @param imagesToProcessOverride When phase is "process", use for listings in "Select images" / "Scraped" state so the estimate uses history per image precisely.
 */
export function estimateRemainingMs(
  listings: ListingForEstimate[],
  selectionMode: SelectionMode,
  maxImages: number,
  phase: EstimatePhase = "full",
  imagesToProcessOverride?: number
): number | undefined {
  const { avgWaitingMs, avgExtractPerImageMs, avgProcessPerImageMs } = getTimingAverages(
    selectionMode,
    maxImages
  );
  let remaining = 0;
  for (const listing of listings) {
    if (listing.finishedAt || listing.error) continue;
    const n = Math.min(maxImages, listing.imageUrls?.length ?? maxImages);
    const processN = phase === "process" && imagesToProcessOverride != null ? imagesToProcessOverride : n;
    let added = 0;
    if (listing.scrapeDurationMs == null) {
      if (phase === "scrape") {
        added = avgWaitingMs + n * avgExtractPerImageMs;
      } else if (phase === "process") {
        added = processN * avgProcessPerImageMs;
      } else {
        added = avgWaitingMs + n * avgExtractPerImageMs + n * avgProcessPerImageMs;
      }
      remaining += added;
      continue;
    }
    const status = listing.status || "";
    const processingMatch = status.match(/Processing image (\d+)\/(\d+)/i)
      || status.match(/Uploading image (\d+)\/(\d+)/i);
    if (processingMatch) {
      const current = parseInt(processingMatch[1], 10);
      const total = parseInt(processingMatch[2], 10);
      const left = Math.max(0, total - current);
      if (phase !== "scrape") {
        added = left * avgProcessPerImageMs;
        remaining += added;
      }
      continue;
    }
    if (status === "Creating Drive folder…" || /^Uploading\s/i.test(status)) {
      if (phase !== "scrape") {
        added = processN * avgProcessPerImageMs;
        remaining += added;
      }
      continue;
    }
    if (status === "Select images" || /^Scraped:/i.test(status)) {
      if (phase !== "scrape") {
        added = processN * avgProcessPerImageMs;
        remaining += added;
      }
    }
  }
  if (remaining > 0) return remaining;
  if (phase === "process") {
    const hasUnfinished = listings.some((l) => !l.finishedAt && !l.error);
    if (hasUnfinished) {
      const count = imagesToProcessOverride ?? maxImages;
      return count * avgProcessPerImageMs;
    }
  }
  return undefined;
}
