/**
 * In-memory store of recent jobs for admin/debug route.
 */

export interface ListingJobEntry {
  url: string;
  status: string;
  logs: string[];
  error: string | null;
  startedAt: string;
  finishedAt?: string;
  folderUrl?: string;
  generatedFiles?: { originalUrl: string; driveFileUrl: string; previewUrl?: string }[];
  imagesFound?: number;
  imagesUsed?: number;
  /** Scraped image URLs; when set, user selects which to use before Gemini (status "Select images"). */
  imageUrls?: string[];
  screenshots?: { step: string; url: string }[];
  costUsd?: number;
}

export interface JobRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  /** Stored when job starts so process-selected can use the same prompt/model. */
  promptStr?: string;
  modelId?: string;
  listings: ListingJobEntry[];
}

const recentJobs: JobRecord[] = [];
const cancelledJobIds = new Set<string>();
const MAX_JOBS = 50;

export function cancelJob(id: string): void {
  cancelledJobIds.add(id);
}

export function isJobCancelled(id: string): boolean {
  return cancelledJobIds.has(id);
}

export function addJob(id: string): JobRecord {
  const job: JobRecord = {
    id,
    startedAt: new Date().toISOString(),
    listings: [],
  };
  recentJobs.unshift(job);
  if (recentJobs.length > MAX_JOBS) recentJobs.pop();
  return job;
}

export function updateJob(
  id: string,
  update:
    | Partial<Pick<JobRecord, "finishedAt" | "promptStr" | "modelId">>
    | { addListing: ListingJobEntry }
    | { updateListing: { index: number; update: Partial<ListingJobEntry> } }
): void {
  const job = recentJobs.find((j) => j.id === id);
  if (!job) return;
  if ("addListing" in update) {
    job.listings.push(update.addListing);
    return;
  }
  if ("updateListing" in update) {
    const entry = job.listings[update.updateListing.index];
    if (entry) Object.assign(entry, update.updateListing.update);
    return;
  }
  if (update.finishedAt !== undefined) job.finishedAt = update.finishedAt;
  if (update.promptStr !== undefined) job.promptStr = update.promptStr;
  if (update.modelId !== undefined) job.modelId = update.modelId;
}

export function getRecentJobs(limit = 20): JobRecord[] {
  return recentJobs.slice(0, limit);
}

export function getJob(id: string): JobRecord | undefined {
  return recentJobs.find((j) => j.id === id);
}
