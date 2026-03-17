/**
 * Temporary screenshot storage: save per job, serve by URL, delete when job is done.
 */

import * as fs from "fs";
import * as path from "path";

const SCREENSHOTS_DIR = path.join(__dirname, "..", ".screenshots");
const DELETE_DELAY_MS = 30 * 60 * 1000; // 30 minutes after job finishes so UI can load/review images
const JOB_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Allow optional timestamp segment to avoid overwriting screenshots with same step slug.
const SAFE_FILENAME_REGEX = /^[0-9]+_(?:[0-9]+_)?[a-zA-Z0-9._-]+\.png$/;

function getJobDir(jobId: string): string {
  return path.join(SCREENSHOTS_DIR, jobId);
}

export function ensureJobDir(jobId: string): string {
  if (!JOB_ID_REGEX.test(jobId)) throw new Error("Invalid jobId");
  const dir = getJobDir(jobId);
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveScreenshot(
  jobId: string,
  listingIndex: number,
  step: string,
  base64: string
): string {
  const dir = ensureJobDir(jobId);
  const slug = step.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 40) || "screenshot";
  const ts = Date.now();
  const filename = `${listingIndex}_${ts}_${slug}.png`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filename;
}

export function getScreenshotPath(jobId: string, filename: string): string | null {
  if (!JOB_ID_REGEX.test(jobId) || !SAFE_FILENAME_REGEX.test(filename)) return null;
  const filePath = path.resolve(getJobDir(jobId), filename);
  const base = path.resolve(SCREENSHOTS_DIR);
  const rel = path.relative(base, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

export function deleteScreenshotsForJob(jobId: string): void {
  try {
    const dir = getJobDir(jobId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch (_) {}
}

export function scheduleDeleteScreenshotsForJob(jobId: string, delayMs: number = DELETE_DELAY_MS): void {
  setTimeout(() => deleteScreenshotsForJob(jobId), delayMs);
}

/** Delete all screenshots (e.g. on logout). */
export function deleteAllScreenshots(): void {
  try {
    if (fs.existsSync(SCREENSHOTS_DIR)) fs.rmSync(SCREENSHOTS_DIR, { recursive: true });
  } catch (_) {}
}

const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes: delete job folders older than this when cleanup runs

export function cleanupOldScreenshots(): void {
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) return;
    const now = Date.now();
    const entries = fs.readdirSync(SCREENSHOTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirPath = path.join(SCREENSHOTS_DIR, e.name);
      const stat = fs.statSync(dirPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.rmSync(dirPath, { recursive: true });
      }
    }
  } catch (_) {}
}
