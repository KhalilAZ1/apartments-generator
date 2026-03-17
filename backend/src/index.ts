/**
 * Express app: auth, API routes, static frontend, health check.
 */
import dotenv from "dotenv";
import path from "path";
// Load .env from project root so it works for both "npm start" (cwd=root) and "npm run dev" (cwd=backend)
const projectRootEnv = path.resolve(__dirname, "..", "..", ".env");
const cwdEnv = path.resolve(process.cwd(), ".env");
const cwdParentEnv = path.resolve(process.cwd(), "..", ".env");
[projectRootEnv, cwdEnv, cwdParentEnv].forEach((p) => dotenv.config({ path: p }));
import express from "express";
import cors from "cors";
import { loadEnv, getConfig } from "./config/env";
import { loginHandler, authMiddleware, adminOnlyMiddleware, revokeToken } from "./auth";
import { processListingsHandler, processSelectedHandler } from "./routes/processListings";
import { getSettings, updateSettings } from "./settings";
import { getCredentials as getCredentialsData, getRoleNames, updateCredentials } from "./credentials";
import { closeSession } from "./scraper-session";
import { getProxyForSession, enableProxyForSession, disableProxyForSession, isProxyManuallyEnabled } from "./proxy-config";
import { getRecentJobs, getJob, cancelJob } from "./jobs/store";
import { getScreenshotPath, cleanupOldScreenshots, deleteAllScreenshots } from "./screenshots";
import { getGeneratedImagePath, scheduleDeleteGeneratedForJob, deleteAllGenerated, cleanupOldGenerated } from "./generated-images";
import { ensurePlaywrightChromium } from "./playwright-ensure";

loadEnv();
ensurePlaywrightChromium();
cleanupOldScreenshots();
cleanupOldGenerated();
// Run 30-min cleanup every 30 minutes (screenshots + generated images)
setInterval(cleanupOldScreenshots, 30 * 60 * 1000);
setInterval(cleanupOldGenerated, 30 * 60 * 1000);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Login (no auth)
app.post("/api/login", loginHandler);

// Logout: revoke token, close scraper session, delete screenshots + generated images (protected).
app.post("/api/logout", authMiddleware, async (req, res) => {
  const token = (req as express.Request & { authToken?: string }).authToken;
  if (token) revokeToken(token);
  await closeSession();
  deleteAllScreenshots();
  deleteAllGenerated();
  res.json({ ok: true });
});

// Activate proxy for scraping (admin only). Next session will use the proxy.
app.post("/api/proxy/activate", authMiddleware, adminOnlyMiddleware, async (_req, res) => {
  enableProxyForSession();
  // Close current session so the next one picks up the proxy setting.
  await closeSession();
  res.json({ proxyEnabled: true });
});

// Deactivate proxy (admin only). Persisted; applies to all users.
app.post("/api/proxy/deactivate", authMiddleware, adminOnlyMiddleware, async (_req, res) => {
  disableProxyForSession();
  await closeSession();
  res.json({ proxyEnabled: false });
});

// Proxy status (used by UI if needed).
app.get("/api/proxy/status", authMiddleware, (_req, res) => {
  res.json({ proxyEnabled: isProxyManuallyEnabled() });
});

// Protected API
app.post("/api/process-listings", authMiddleware, processListingsHandler);

// Settings (persistent). GET: any authenticated user. POST: admin only.
app.get("/api/settings", authMiddleware, (_req, res) => {
  res.json(getSettings());
});
app.post("/api/settings", authMiddleware, adminOnlyMiddleware, (req, res) => {
  const body = req.body as { maxImagesToSelect?: number; selectionModeAdmin?: string; selectionModeUser?: string };
  const update: Parameters<typeof updateSettings>[0] = {};
  if (typeof body.maxImagesToSelect === "number") update.maxImagesToSelect = body.maxImagesToSelect;
  if (body.selectionModeAdmin === "manual" || body.selectionModeAdmin === "auto") update.selectionModeAdmin = body.selectionModeAdmin;
  if (body.selectionModeUser === "manual" || body.selectionModeUser === "auto") update.selectionModeUser = body.selectionModeUser;
  const next = updateSettings(update);
  res.json(next);
});

// Admin: list roles and current passwords (so admin can view them in Settings). Update passwords.
app.get("/api/admin/credentials", authMiddleware, adminOnlyMiddleware, (_req, res) => {
  res.json({ roles: getRoleNames(), passwords: getCredentialsData() });
});
app.post("/api/admin/credentials", authMiddleware, adminOnlyMiddleware, (req, res) => {
  const body = req.body as { updates?: Record<string, string> };
  const updates = body.updates && typeof body.updates === "object" ? body.updates : {};
  const allowed: Record<string, string> = {};
  if (typeof updates.admin === "string") allowed.admin = updates.admin;
  if (typeof updates.user === "string") allowed.user = updates.user;
  try {
    updateCredentials(allowed);
    res.json({ ok: true, roles: getRoleNames() });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to update credentials" });
  }
});

// Process one listing with user-selected image URLs (Gemini + Drive). Requires auth.
app.post(
  "/api/jobs/:jobId/listings/:listingIndex/process-selected",
  authMiddleware,
  processSelectedHandler
);

// Job status (no auth; jobId is UUID)
app.get("/api/jobs/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

// Cancel a running job (no auth; jobId is UUID)
app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  cancelJob(jobId);
  res.json({ cancelled: true });
});

// Serve temporary screenshots (no auth; jobId is UUID, files deleted after delay)
app.get("/api/screenshots/:jobId/:filename", (req, res) => {
  const { jobId, filename } = req.params;
  const filePath = getScreenshotPath(jobId, filename);
  if (!filePath) {
    res.status(404).send("Not found");
    return;
  }
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send("Not found");
  });
});

// Serve temporary generated images (no auth; jobId is UUID, files deleted after delay)
app.get("/api/generated/:jobId/:filename", (req, res) => {
  const { jobId, filename } = req.params;
  const filePath = getGeneratedImagePath(jobId, filename);
  if (!filePath) {
    res.status(404).send("Not found");
    return;
  }
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).send("Not found");
  });
});

const IPIFY_URL = "http://api.ipify.org?format=json";
const IP_CHECK_TIMEOUT_MS = 15000;

async function fetchIpifyBodyDirect(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IP_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(IPIFY_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const body = await response.text();
    if (!response.ok) throw new Error(`ipify returned ${response.status}`);
    return body;
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e && typeof e === "object" && "cause" in e && e.cause instanceof Error ? e.cause.message : "";
    throw new Error(cause ? `${msg}: ${cause}` : msg);
  }
}

function parseIpFromBody(body: string): string | null {
  try {
    const data = body ? (JSON.parse(body) as { ip?: string }) : {};
    return typeof data?.ip === "string" ? data.ip : null;
  } catch {
    return null;
  }
}

// Check which IP the scraper would use (all authenticated users).
app.get("/api/check-scraper-ip", authMiddleware, async (_req, res) => {
  const config = getConfig();
  const proxy = getProxyForSession(config);
  try {
    if (proxy) {
      const { getSessionIp } = await import("./scraper-session");
      const sessionResult = await getSessionIp();
      if (sessionResult) {
        res.json({ ip: sessionResult.ip, usingProxy: true });
        return;
      }
      const body = await fetchIpifyBodyDirect();
      const ip = parseIpFromBody(body);
      if (ip != null) {
        res.json({ ip, usingProxy: false, proxyFailedMessage: "Could not get session IP; showing direct IP." });
        return;
      }
    } else {
      const body = await fetchIpifyBodyDirect();
      const ip = parseIpFromBody(body);
      if (ip != null) {
        res.json({ ip, usingProxy: false });
        return;
      }
    }
    res.status(502).json({ error: "Could not read IP. Try again.", usingProxy: !!proxy });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not fetch IP";
    res.status(500).json({ error: message });
  }
});

// Admin/debug: recent jobs and logs (protected)
app.get("/api/admin/jobs", authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit), 10) || 20, 50);
  const jobs = getRecentJobs(limit);
  res.json({ jobs });
});

// Serve React build in production
const frontendPath = path.join(__dirname, "..", "..", "frontend", "build");
app.use(express.static(frontendPath));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/health") return next();
  res.sendFile(path.join(frontendPath, "index.html"), (err) => {
    if (err) res.status(404).send("Not found");
  });
});

const { PORT } = getConfig();
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process using that port, or set a different PORT in .env (e.g. PORT=3001).`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});
