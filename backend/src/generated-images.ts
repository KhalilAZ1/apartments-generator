/**
 * Temporary generated-image storage: save per job for UI preview, delete when job is done.
 */

import * as fs from "fs";
import * as path from "path";

const GENERATED_DIR = path.join(__dirname, "..", ".generated");
const DELETE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const JOB_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_FILENAME_REGEX = /^[0-9]+_[0-9]+\.(png|jpg|jpeg|webp)$/i;

function getJobDir(jobId: string): string {
  return path.join(GENERATED_DIR, jobId);
}

export function saveGeneratedImage(
  jobId: string,
  listingIndex: number,
  imageIndex: number,
  buffer: Buffer,
  mimeType: string
): string {
  if (!JOB_ID_REGEX.test(jobId)) throw new Error("Invalid jobId");
  const dir = getJobDir(jobId);
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const filename = `${listingIndex}_${imageIndex}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return filename;
}

export function getGeneratedImagePath(jobId: string, filename: string): string | null {
  if (!JOB_ID_REGEX.test(jobId) || !SAFE_FILENAME_REGEX.test(filename)) return null;
  const filePath = path.resolve(getJobDir(jobId), filename);
  const base = path.resolve(GENERATED_DIR);
  const rel = path.relative(base, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return fs.existsSync(filePath) ? filePath : null;
}

export function deleteGeneratedForJob(jobId: string): void {
  try {
    const dir = getJobDir(jobId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  } catch (_) {}
}

export function scheduleDeleteGeneratedForJob(jobId: string, delayMs: number = DELETE_DELAY_MS): void {
  setTimeout(() => deleteGeneratedForJob(jobId), delayMs);
}

/** Delete all generated images (e.g. on logout). */
export function deleteAllGenerated(): void {
  try {
    if (fs.existsSync(GENERATED_DIR)) fs.rmSync(GENERATED_DIR, { recursive: true });
  } catch (_) {}
}

const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes: delete job folders older than this when cleanup runs

/** Delete job folders in .generated older than 30 minutes (run periodically, like screenshots). */
export function cleanupOldGenerated(): void {
  try {
    if (!fs.existsSync(GENERATED_DIR)) return;
    const now = Date.now();
    const entries = fs.readdirSync(GENERATED_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirPath = path.join(GENERATED_DIR, e.name);
      const stat = fs.statSync(dirPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.rmSync(dirPath, { recursive: true });
      }
    }
  } catch (_) {}
}
