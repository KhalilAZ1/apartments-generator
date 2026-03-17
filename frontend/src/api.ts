/**
 * API helpers: login and process-listings with Authorization header.
 */

import { getStoredToken, clearStoredToken, type AuthRole } from "./auth";

const getBaseUrl = (): string => {
  const url = import.meta.env?.VITE_API_URL;
  return url ? String(url).replace(/\/$/, "") : "";
};

/** Call when backend returns 401 so the app can show the login screen. */
export const AUTH_EXPIRED_EVENT = "listing-processor-auth-expired";

function handleAuthExpired(): void {
  clearStoredToken();
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/** Validate the stored token immediately (fast). If invalid, triggers AUTH_EXPIRED_EVENT. */
export async function validateToken(): Promise<boolean> {
  const token = getStoredToken();
  if (!token) return false;
  const res = await fetch(`${getBaseUrl()}/api/proxy/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    handleAuthExpired();
    return false;
  }
  // If server doesn't have this endpoint or any other error, don't force logout.
  return res.ok;
}

export async function login(password: string): Promise<{ token: string; role: AuthRole }> {
  const res = await fetch(`${getBaseUrl()}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}

/** Tell backend to close scraper session (new IP after next login). Call before clearing token. */
export async function logout(): Promise<void> {
  const token = getStoredToken();
  if (!token) return;
  try {
    await fetch(`${getBaseUrl()}/api/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (_) {}
}

export const GEMINI_MODEL_IDS = [
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
] as const;
export type GeminiModelId = (typeof GEMINI_MODEL_IDS)[number];

export interface ListingResult {
  url: string;
  folderUrl?: string;
  imagesFound?: number;
  imagesUsed?: number;
  generatedFiles?: { originalUrl: string; driveFileUrl: string; previewUrl?: string }[];
  screenshots?: { step: string; url: string }[];
  logs: string[];
  error: string | null;
  costUsd?: number;
}

export interface ProcessListingsResponse {
  results: ListingResult[];
  totalCostUsd?: number;
}

/** Start processing; returns jobId. Poll getJobStatus(jobId) for progress. */
export async function startProcessListings(
  urls: string[],
  prompt: string,
  model: GeminiModelId = "gemini-2.5-flash-image"
): Promise<{ jobId: string }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch(`${getBaseUrl()}/api/process-listings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ urls, prompt, model }),
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired. Please log in again.");
  }
  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Request failed");
  }
  const data = await res.json();
  if (!data.jobId) throw new Error("Server did not return jobId");
  return { jobId: data.jobId };
}

export interface JobListingEntry {
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
  /** Scraped image URLs; when set without folderUrl, user must select images then call process-selected. */
  imageUrls?: string[];
  screenshots?: { step: string; url: string }[];
  costUsd?: number;
}

export type SelectionMode = "manual" | "auto";

export interface AppSettings {
  maxImagesToSelect: number;
  proxyEnabled: boolean;
  selectionModeAdmin: SelectionMode;
  selectionModeUser: SelectionMode;
}

export async function getSettings(): Promise<AppSettings> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

export async function updateSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(settings),
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error("Failed to update settings");
  return res.json();
}

export async function processSelected(
  jobId: string,
  listingIndex: number,
  selectedUrls: string[]
): Promise<{ ok: boolean }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(
    `${getBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/listings/${listingIndex}/process-selected`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ selectedUrls }),
    }
  );
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to process selected images");
  }
  return res.json();
}

export interface JobStatus {
  id: string;
  startedAt: string;
  finishedAt?: string;
  listings: JobListingEntry[];
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) throw new Error("Job not found");
  if (!res.ok) throw new Error("Failed to load job status");
  return res.json();
}

/** Cancel a running job. The background run will stop and the job will be marked finished. */
export async function cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  if (res.status === 404) throw new Error("Job not found");
  if (!res.ok) throw new Error("Failed to cancel job");
  return res.json();
}

/** Returns the IP the scraper would use (same proxy as process-listings). Requires auth. */
export async function checkScraperIp(): Promise<{ ip: string; usingProxy: boolean; proxyFailedMessage?: string }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/check-scraper-ip`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired. Please log in again.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Could not check IP");
  }
  return res.json();
}

/** Manually enable the proxy on the backend (persistent for all users). */
export async function activateProxy(): Promise<{ proxyEnabled: boolean }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/proxy/activate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to activate proxy");
  }
  return res.json();
}

/** Turn off the proxy (admin only). Persistent for all users. */
export async function deactivateProxy(): Promise<{ proxyEnabled: boolean }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/proxy/deactivate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to deactivate proxy");
  }
  return res.json();
}

/** Get list of roles and current passwords (admin only). */
export async function getCredentials(): Promise<{ roles: string[]; passwords: Record<string, string> }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/admin/credentials`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired");
  }
  if (res.status === 403) throw new Error("Admin only");
  if (!res.ok) throw new Error("Failed to load credentials");
  return res.json();
}

/** Update admin and/or user password (admin only). */
export async function updateCredentials(payload: { updates?: Record<string, string> }): Promise<{ ok: boolean; roles: string[] }> {
  const token = getStoredToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${getBaseUrl()}/api/admin/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    handleAuthExpired();
    throw new Error("Session expired");
  }
  if (res.status === 403) throw new Error("Admin only");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update credentials");
  }
  return res.json();
}

/** Map job listing entry to ListingResult for the result cards. */
export function jobListingToResult(entry: JobListingEntry): ListingResult {
  return {
    url: entry.url,
    folderUrl: entry.folderUrl,
    imagesFound: entry.imagesFound,
    imagesUsed: entry.imagesUsed,
    generatedFiles: entry.generatedFiles,
    screenshots: entry.screenshots,
    logs: entry.logs,
    error: entry.error,
    costUsd: entry.costUsd,
  };
}
