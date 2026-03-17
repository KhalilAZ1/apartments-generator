import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  login,
  logout,
  startProcessListings,
  getJobStatus,
  cancelJob,
  jobListingToResult,
  checkScraperIp,
  activateProxy,
  deactivateProxy,
  validateToken,
  getSettings,
  updateSettings,
  getCredentials,
  updateCredentials,
  processSelected,
  type ListingResult,
  type JobStatus,
  type JobListingEntry,
  type AppSettings,
  type SelectionMode,
  GEMINI_MODEL_IDS,
  type GeminiModelId,
  AUTH_EXPIRED_EVENT,
} from "./api";
import { getStoredToken, setStoredToken, clearStoredToken, getStoredRole, setStoredRole, clearStoredRole } from "./auth";

const DEFAULT_PROMPT = `Edit this photo realistically. Keep the exact same room, same layout, same lighting conditions, and same overall atmosphere. Shift the camera angle to give a fresh perspective of the same space — for example a few degrees to the left or right, or slightly higher or lower viewpoint. Replace some decorative elements such as furniture, wall art, picture frames, throw pillows, vases, candles, small plants. All new decor should feel realistic, cozy, and consistent with the style and color palette already in the room. Do not add or remove rooms or architectural elements. Keep the same natural or artificial lighting as in the reference photo. The result should look like a real interior photograph taken by a real estate photographer or Airbnb host in Germany, not a render or illustration. Photorealistic, high quality, sharp, no people, no text, no watermarks.

Output: single image, vertical (portrait) 9:16 aspect ratio, suitable for TikTok and mobile. Change the viewing/camera angle (e.g. a few degrees left/right or slightly higher/lower) for a fresh perspective.

Avoid: new room, different floor, architectural changes, text, watermark, logo, cartoon, 3D render, CGI, painting, illustration, blurry, overexposed, underexposed, fish-eye distortion, people, faces.`;

const PROMPT_STORAGE_KEY = "listing_processor_gemini_prompt";

function loadSavedPrompt(): string {
  try {
    const s = localStorage.getItem(PROMPT_STORAGE_KEY);
    return s ?? DEFAULT_PROMPT;
  } catch {
    return DEFAULT_PROMPT;
  }
}

function savePrompt(prompt: string): void {
  try {
    localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
  } catch (_) {}
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { token, role } = await login(password);
      setStoredToken(token);
      setStoredRole(role);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.loginScreen}>
      <h1 style={styles.title}>Apartments Generator</h1>
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.passwordRow}>
          <input
            type={showPassword ? "text" : "password"}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={styles.input}
            autoFocus
            disabled={loading}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            style={styles.passwordToggle}
            disabled={loading}
            title={showPassword ? "Hide password" : "Show password"}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "…" : "Enter"}
        </button>
        {error && <p style={styles.error}>{error}</p>}
      </form>
    </div>
  );
}

function ListingResultCard({ result, isAdmin }: { result: ListingResult; isAdmin: boolean }) {
  const [showDebug, setShowDebug] = useState(false);
  return (
    <div style={{ ...styles.resultCard, borderColor: result.error ? "#c00" : "#2e7d32" }}>
      <div style={styles.cardHeader}>
        <a href={result.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
          {result.url}
        </a>
        <span style={styles.badge}>{result.error ? "Error" : "Done"}</span>
      </div>
      {result.error && (
        <p style={styles.errorText} title={result.error}>
          {result.error}
        </p>
      )}
      {result.folderUrl && (
        <div style={styles.driveFolderBlock}>
          <div style={styles.driveFolderHeader}>
            <span style={styles.driveFolderTitle}>Google Drive folder</span>
            {isAdmin && typeof result.costUsd === "number" && result.costUsd > 0 && (
              <span style={styles.driveFolderCost}>Cost: ${result.costUsd.toFixed(4)}</span>
            )}
          </div>
          <p style={styles.driveFolderDesc}>
            Your generated images are in this folder. Open it to view or download.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <a
              href={result.folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.driveFolderButton}
            >
              Open folder in new tab
            </a>
            {(result.generatedFiles?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={async () => {
                  const base = window.location.origin;
                  for (let i = 0; i < (result.generatedFiles?.length ?? 0); i++) {
                    const f = result.generatedFiles![i];
                    if (!f.previewUrl) continue;
                    const url = f.previewUrl.startsWith("http") ? f.previewUrl : base + f.previewUrl;
                    try {
                      const res = await fetch(url);
                      const blob = await res.blob();
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = `image-${i + 1}.jpg`;
                      a.click();
                      URL.revokeObjectURL(a.href);
                    } catch (_) {}
                    if (i < (result.generatedFiles?.length ?? 0) - 1) {
                      await new Promise((r) => setTimeout(r, 300));
                    }
                  }
                }}
                style={{ ...styles.driveFolderButton, background: "#e0e0e0", color: "#1a1a1a" }}
              >
                Download images
              </button>
            )}
          </div>
        </div>
      )}
      {isAdmin && !result.folderUrl && result.error && typeof result.costUsd === "number" && result.costUsd > 0 && (
        <p style={styles.meta}>Cost: ${result.costUsd.toFixed(4)}</p>
      )}

      {isAdmin && (
        <div style={styles.debugWrap}>
          <button type="button" style={styles.debugToggle} onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? "Hide debug logs" : "Show debug logs"}
          </button>
          {showDebug && (
            <div style={styles.debugPanel}>
              {result.error && <p style={styles.debugError}>Error: {result.error}</p>}
              {(result.screenshots?.length ?? 0) > 0 && (
                <div style={styles.debugSection}>
                  <div style={styles.debugTitle}>Screenshots</div>
                  <ul style={styles.debugList}>
                    {result.screenshots!.map((s, i) => (
                      <li key={i}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.step}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(result.logs?.length ?? 0) > 0 && (
                <div style={styles.debugSection}>
                  <div style={styles.debugTitle}>Action log</div>
                  <pre style={styles.debugPre}>{result.logs.join("\n")}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImageSelectionCard({
  jobId,
  listingIndex,
  listing,
  maxImages,
  onProcessComplete,
}: {
  jobId: string;
  listingIndex: number;
  listing: JobListingEntry;
  maxImages: number;
  onProcessComplete: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState("");
  const imageUrls = listing.imageUrls ?? [];
  const toggle = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < maxImages) next.add(url);
      return next;
    });
  };
  const handleProcess = async () => {
    if (selected.size === 0) {
      setErr("Select at least one image.");
      return;
    }
    setErr("");
    setProcessing(true);
    try {
      await processSelected(jobId, listingIndex, Array.from(selected));
      const poll = async () => {
        const status = await getJobStatus(jobId);
        onProcessComplete();
        const entry = status.listings[listingIndex];
        if (entry?.folderUrl ?? entry?.finishedAt) {
          setProcessing(false);
          return;
        }
        setTimeout(poll, 2000);
      };
      await poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to process");
      setProcessing(false);
    }
  };
  return (
    <div style={{ ...styles.resultCard, borderColor: "#1565c0" }}>
      <div style={styles.cardHeader}>
        <a href={listing.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
          {listing.url}
        </a>
        <span style={{ ...styles.badge, background: "#e3f2fd", color: "#1565c0" }}>
          Select images (max {maxImages})
        </span>
      </div>
      <p style={styles.selectionHint}>
        Click images to select them for Gemini. Selected: {selected.size} / {maxImages}
      </p>
      <div style={styles.selectionGrid}>
        {imageUrls.map((url) => (
          <div
            key={url}
            className="selection-thumb"
            role={processing ? undefined : "button"}
            tabIndex={processing ? -1 : 0}
            onClick={processing ? undefined : (e) => {
              toggle(url);
              (e.currentTarget as HTMLElement).blur();
            }}
            onKeyDown={
              processing
                ? undefined
                : (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(url);
                      (e.currentTarget as HTMLElement).blur();
                    }
                  }
            }
            style={{
              ...styles.selectionThumb,
              ...(selected.has(url) ? styles.selectionThumbSelected : {}),
              ...(processing ? { pointerEvents: "none", cursor: "default", opacity: 0.85 } : {}),
            }}
          >
            <img src={url} alt="" style={styles.selectionThumbImg} referrerPolicy="no-referrer" />
          </div>
        ))}
      </div>
      {err && <p style={styles.errorText}>{err}</p>}
      <button
        type="button"
        onClick={handleProcess}
        disabled={processing || selected.size === 0}
        style={styles.driveFolderButton}
      >
        {processing ? "Processing…" : "Process with selected"}
      </button>
    </div>
  );
}

function AutoFirstNCard({
  jobId,
  listingIndex,
  listing,
  maxImages,
  onProcessComplete,
  autoStart = false,
}: {
  jobId: string;
  listingIndex: number;
  listing: JobListingEntry;
  maxImages: number;
  onProcessComplete: () => void;
  autoStart?: boolean;
}) {
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState("");
  const startedRef = useRef(false);
  const imageUrls = listing.imageUrls ?? [];
  const firstN = imageUrls.slice(0, maxImages);

  const handleProcess = useCallback(async () => {
    if (firstN.length === 0) {
      setErr("No images to process.");
      return;
    }
    setErr("");
    setProcessing(true);
    try {
      await processSelected(jobId, listingIndex, firstN);
      const poll = async () => {
        const status = await getJobStatus(jobId);
        onProcessComplete();
        const entry = status.listings[listingIndex];
        if (entry?.folderUrl ?? entry?.finishedAt) {
          setProcessing(false);
          return;
        }
        setTimeout(poll, 2000);
      };
      await poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to process");
      setProcessing(false);
    }
  }, [jobId, listingIndex, firstN, onProcessComplete]);

  useEffect(() => {
    if (autoStart && firstN.length > 0 && !startedRef.current) {
      startedRef.current = true;
      handleProcess();
    }
  }, [autoStart, firstN.length, handleProcess]);

  return (
    <div style={{ ...styles.resultCard, borderColor: "#1565c0" }}>
      <div style={styles.cardHeader}>
        <a href={listing.url} target="_blank" rel="noopener noreferrer" style={styles.link}>
          {listing.url}
        </a>
        <span style={{ ...styles.badge, background: "#e8f5e9", color: "#2e7d32" }}>
          Auto: first {maxImages} image{maxImages !== 1 ? "s" : ""}
        </span>
      </div>
      <p style={styles.selectionHint}>
        {autoStart
          ? (processing ? "Processing first " + firstN.length + " image(s)…" : "Using the first " + firstN.length + " image(s) (max " + maxImages + ").")
          : "Using the first " + firstN.length + " image(s) (max " + maxImages + "). Click to process."}
      </p>
      {err && <p style={styles.errorText}>{err}</p>}
      {!autoStart && (
        <button
          type="button"
          onClick={handleProcess}
          disabled={processing || firstN.length === 0}
          style={styles.driveFolderButton}
        >
          {processing ? "Processing…" : `Process with first ${firstN.length}`}
        </button>
      )}
    </div>
  );
}

const MODEL_LABELS: Record<GeminiModelId, string> = {
  "gemini-2.5-flash-image": "Nano Banana",
  "gemini-3.1-flash-image-preview": "Nano Banana 2",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};

const MODEL_DESCRIPTIONS: Record<GeminiModelId, string> = {
  "gemini-2.5-flash-image": "Gemini 2.5 Flash Image — speed & efficiency, high-volume, low-latency.",
  "gemini-3.1-flash-image-preview": "Gemini 3.1 Flash Image Preview — efficient, fast, high-volume.",
  "gemini-3-pro-image-preview": "Gemini 3 Pro Image — professional quality, advanced reasoning, high-quality text.",
};

function shortenUrl(url: string, maxLen = 50): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "") || u.hostname;
    if (path.length <= maxLen) return path;
    return path.slice(-maxLen).replace(/^[^/]*\//, "…/");
  } catch {
    return url.length <= maxLen ? url : "…" + url.slice(-maxLen);
  }
}

function MainScreen() {
  const [urlText, setUrlText] = useState("");
  const [prompt, setPrompt] = useState(() => loadSavedPrompt());
  const [model, setModel] = useState<GeminiModelId>("gemini-2.5-flash-image");
  const [results, setResults] = useState<ListingResult[] | null>(null);
  const [totalCostUsd, setTotalCostUsd] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [ipCheckLoading, setIpCheckLoading] = useState(false);
  const [ipCheckResult, setIpCheckResult] = useState<{ ip: string; usingProxy: boolean; proxyFailedMessage?: string } | null>(null);
  const [ipCheckError, setIpCheckError] = useState("");
  const isAdmin = getStoredRole() === "admin";
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saveLimitStatus, setSaveLimitStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showCredentialsModal, setShowCredentialsModal] = useState(false);
  const [credentialUpdates, setCredentialUpdates] = useState<Record<string, string>>({});
  const [credentialError, setCredentialError] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialSuccess, setCredentialSuccess] = useState(false);
  const [currentPasswords, setCurrentPasswords] = useState<Record<string, string>>({});
  const [showCurrentPassword, setShowCurrentPassword] = useState<Record<string, boolean>>({});
  const maxImagesToSelect = settings?.maxImagesToSelect ?? 10;
  const proxyEnabled = settings?.proxyEnabled ?? false;
  const selectionModeAdmin = settings?.selectionModeAdmin ?? "manual";
  const selectionModeUser = settings?.selectionModeUser ?? "manual";
  const rawAllowedHostsUser = settings?.allowedHostsUser ?? ["immowelt.at"];
  const allowedHostsUser = Array.from(
    new Set(
      rawAllowedHostsUser.map((h) => {
        const lower = h.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        return lower.startsWith("www.") ? lower.slice(4) : lower;
      })
    )
  );
  const useAutoSelect = isAdmin ? selectionModeAdmin === "auto" : selectionModeUser === "auto";
  const [settingsTab, setSettingsTab] = useState<"allowedHosts" | "passwords" | "limits">("allowedHosts");
  const [newHost, setNewHost] = useState("");
  const [allowedHostsSaving, setAllowedHostsSaving] = useState(false);
  const [allowedHostsError, setAllowedHostsError] = useState("");
  const [editRole, setEditRole] = useState<"admin" | "user" | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPrompt(loadSavedPrompt());
  }, []);

  const handlePromptChange = (value: string) => {
    setPrompt(value);
    savePrompt(value);
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const lines = urlText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) {
        setError("Enter at least one URL.");
        return;
      }
      if (lines.length > 5) {
        setError("Maximum 5 URLs per run.");
        return;
      }
      setError("");
      setResults(null);
      setTotalCostUsd(undefined);
      setJobStatus(null);
      setLoading(true);
      try {
        const { jobId } = await startProcessListings(lines, prompt, model);
        const first = await getJobStatus(jobId);
        setJobStatus(first);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
        setLoading(false);
      }
    },
    [urlText, prompt, model]
  );

  useEffect(() => {
    if (!loading || !jobStatus || jobStatus.finishedAt) return;
    const interval = setInterval(() => {
      getJobStatus(jobStatus.id)
        .then((next) => {
          setJobStatus(next);
          if (next.finishedAt) {
            setResults(next.listings.map(jobListingToResult));
            setTotalCostUsd(
              next.listings.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) || undefined
            );
            setLoading(false);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(interval);
  }, [loading, jobStatus?.id, jobStatus?.finishedAt]);

  const handleLogout = async () => {
    await logout();
    clearStoredToken();
    clearStoredRole();
    window.location.reload();
  };

  const headerBtnSec = { ...styles.headerBtnSecondary };
  const headerBtnActive = { ...styles.modelBtnActive };

  return (
    <div style={styles.mainScreen}>
      <header style={styles.header}>
        <div style={styles.headerTop}>
          <h1 style={styles.title}>Apartments Generator</h1>
          <div style={styles.headerButtons}>
            {isAdmin && (
              <button
                type="button"
                onClick={async () => {
                  setShowCredentialsModal(true);
                  setSettingsTab("allowedHosts");
                  setAllowedHostsError("");
                  setNewHost("");
                  setEditRole(null);
                  setCredentialError("");
                  setCredentialSuccess(false);
                  setCredentialUpdates({});
                  setShowCurrentPassword({});
                  try {
                    const freshSettings = await getSettings();
                    setSettings(freshSettings);
                    const { passwords } = await getCredentials();
                    setCurrentPasswords(passwords ?? {});
                  } catch {
                    setCredentialError("Could not load accounts");
                  }
                }}
                style={headerBtnSec}
                title="Change admin and user passwords"
              >
                ⚙ Settings
              </button>
            )}
            <button type="button" onClick={handleLogout} style={styles.headerBtn}>
              Logout
            </button>
          </div>
        </div>
        <div style={styles.headerGroups}>
          <div style={styles.headerGroup}>
            <span style={styles.headerGroupLabel}>Network</span>
            <button
              type="button"
              onClick={async () => {
                setIpCheckError("");
                setIpCheckResult(null);
                setIpCheckLoading(true);
                try {
                  const r = await checkScraperIp();
                  setIpCheckResult(r);
                } catch (e) {
                  setIpCheckError(e instanceof Error ? e.message : "Could not check IP");
                } finally {
                  setIpCheckLoading(false);
                }
              }}
              style={headerBtnSec}
              disabled={loading || ipCheckLoading}
            >
              {ipCheckLoading ? "Checking…" : "Check IP"}
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={async () => {
                  setIpCheckError("");
                  try {
                    if (proxyEnabled) {
                      const res = await deactivateProxy();
                      setSettings((s) => (s ? { ...s, proxyEnabled: res.proxyEnabled } : { maxImagesToSelect: 10, proxyEnabled: false, selectionModeAdmin: "manual", selectionModeUser: "manual" }));
                    } else {
                      const res = await activateProxy();
                      setSettings((s) => (s ? { ...s, proxyEnabled: res.proxyEnabled } : { maxImagesToSelect: 10, proxyEnabled: true, selectionModeAdmin: "manual", selectionModeUser: "manual" }));
                    }
                    setIpCheckResult(null);
                  } catch (e) {
                    setIpCheckError(e instanceof Error ? e.message : "Failed to change proxy");
                  }
                }}
                style={headerBtnSec}
                disabled={loading}
              >
                {proxyEnabled ? "Proxy on (click off)" : "Activate proxy"}
              </button>
            )}
          </div>
          {/* Admin settings moved into Settings modal */}
        </div>
      </header>

      {showCredentialsModal && (
        <div style={styles.modalOverlay} onClick={() => setShowCredentialsModal(false)} role="dialog" aria-modal="true" aria-label="Settings">
          <div style={{ ...styles.modalPanel, maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Settings</h2>
            </div>
            <div style={styles.settingsModalBody}>
              <div style={styles.settingsTabs}>
                <button type="button" style={{ ...styles.settingsTabBtn, ...(settingsTab === "allowedHosts" ? styles.settingsTabBtnActive : {}) }} onClick={() => setSettingsTab("allowedHosts")}>
                  Allowed hosts
                </button>
                <button type="button" style={{ ...styles.settingsTabBtn, ...(settingsTab === "passwords" ? styles.settingsTabBtnActive : {}) }} onClick={() => setSettingsTab("passwords")}>
                  Passwords
                </button>
                <button type="button" style={{ ...styles.settingsTabBtn, ...(settingsTab === "limits" ? styles.settingsTabBtnActive : {}) }} onClick={() => setSettingsTab("limits")}>
                  Max images & Selection
                </button>
              </div>

              <div style={styles.settingsPanel}>
                {settingsTab === "allowedHosts" && (
                  <>
                    <div style={styles.settingsPanelTitle}>Allowed hosts (users)</div>
                    <div style={styles.settingsPanelDesc}>Users can only process URLs from these hosts. Admins can process any host. Changes are saved automatically.</div>
                    {allowedHostsError && <p style={styles.credentialError}>{allowedHostsError}</p>}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
                      <input value={newHost} onChange={(e) => setNewHost(e.target.value)} placeholder="e.g. www.immowelt.de" style={styles.credentialInput} spellCheck={false} />
                      <button
                        type="button"
                        style={styles.headerBtn}
                        disabled={allowedHostsSaving}
                        onClick={async () => {
                          const host = newHost.trim().toLowerCase();
                          if (!host) return;
                          const normalized = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
                          const nextList = Array.from(new Set([...allowedHostsUser, normalized])).filter(Boolean);
                          setAllowedHostsSaving(true);
                          setAllowedHostsError("");
                          try {
                            const next = await updateSettings({ allowedHostsUser: nextList } as any);
                            setSettings(next);
                            setNewHost("");
                          } catch (e) {
                            setAllowedHostsError(e instanceof Error ? e.message : "Failed to save");
                          } finally {
                            setAllowedHostsSaving(false);
                          }
                        }}
                      >
                        Add
                      </button>
                    </div>
                    <div style={styles.hostList}>
                      {allowedHostsUser.map((h) => (
                        <div key={h} style={styles.hostRow}>
                          <span style={styles.hostValue}>{h}</span>
                          <button
                            type="button"
                            style={styles.iconBtn}
                            aria-label={`Remove ${h}`}
                            title={`Remove ${h}`}
                            onClick={async () => {
                              const nextList = allowedHostsUser.filter((x) => x !== h);
                              setAllowedHostsSaving(true);
                              setAllowedHostsError("");
                              try {
                                const next = await updateSettings({ allowedHostsUser: nextList } as any);
                                setSettings(next);
                              } catch (e) {
                                setAllowedHostsError(e instanceof Error ? e.message : "Failed to save");
                              } finally {
                                setAllowedHostsSaving(false);
                              }
                            }}
                          >
                            <XIcon />
                          </button>
                        </div>
                      ))}
                      {allowedHostsUser.length === 0 && <div style={styles.settingsPanelDesc}>No hosts configured.</div>}
                    </div>
                  </>
                )}

                {settingsTab === "passwords" && (
                  <>
                    <div style={styles.settingsPanelTitle}>Passwords</div>
                    <div style={styles.settingsPanelDesc}>View and update the shared admin/user passwords. Changes are saved automatically.</div>
                    {credentialError && <p style={styles.credentialError}>{credentialError}</p>}
                    {credentialSuccess && <p style={styles.credentialSuccess}>Saved. Changes are persistent.</p>}

                    <div style={styles.hostList}>
                      {(["admin", "user"] as const).map((role) => {
                        const isEditing = editRole === role;
                        const inputValue = credentialUpdates[role] ?? "";
                        return (
                          <div key={role} style={styles.hostRow}>
                            <span style={styles.hostValue}>{role}</span>
                            {isEditing ? (
                              <>
                                <input
                                  type="text"
                                  placeholder={showCurrentPassword[role] ? currentPasswords[role] ?? "" : "New password"}
                                  value={inputValue}
                                  onChange={(e) => setCredentialUpdates((u) => ({ ...u, [role]: e.target.value }))}
                                  style={{ ...styles.credentialInput, flex: 1, fontFamily: "monospace" }}
                                  autoComplete="new-password"
                                />
                                <button
                                  type="button"
                                  disabled={credentialSaving}
                                  style={styles.headerBtn}
                                  onClick={async () => {
                                    const v = (credentialUpdates[role] ?? "").trim();
                                    if (!v || v === (currentPasswords[role] ?? "")) {
                                      setEditRole(null);
                                      return;
                                    }
                                    setCredentialSaving(true);
                                    setCredentialError("");
                                    setCredentialSuccess(false);
                                    try {
                                      await updateCredentials({ updates: { [role]: v } });
                                      setCredentialUpdates((u) => ({ ...u, [role]: "" }));
                                      setCredentialSuccess(true);
                                      setTimeout(() => setCredentialSuccess(false), 3000);
                                      setEditRole(null);
                                      try {
                                        const { passwords } = await getCredentials();
                                        setCurrentPasswords(passwords ?? {});
                                      } catch {
                                        // ignore
                                      }
                                    } catch (err) {
                                      setCredentialError(err instanceof Error ? err.message : "Failed to save");
                                    } finally {
                                      setCredentialSaving(false);
                                    }
                                  }}
                                >
                                  Save
                                </button>
                              </>
                            ) : (
                              <>
                                <span style={{ flex: 1, fontFamily: "monospace" }}>{showCurrentPassword[role] ? (currentPasswords[role] ?? "—") : "••••••••"}</span>
                            <button
                              type="button"
                              onClick={() => setShowCurrentPassword((s) => ({ ...s, [role]: !s[role] }))}
                              style={styles.iconBtn}
                              title={showCurrentPassword[role] ? "Hide password" : "Show password"}
                              aria-label={showCurrentPassword[role] ? "Hide password" : "Show password"}
                            >
                                  {showCurrentPassword[role] ? <EyeOffIcon /> : <EyeIcon />}
                                </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditRole((r) => (r === role ? null : role));
                                setCredentialUpdates((u) => ({ ...u, [role]: currentPasswords[role] ?? "" }));
                              }}
                              style={styles.iconBtn}
                              title={isEditing ? "Stop editing" : "Edit"}
                              aria-label={isEditing ? "Stop editing" : "Edit"}
                            >
                                  <PenIcon />
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {settingsTab === "limits" && (
                  <>
                    <div style={styles.settingsPanelTitle}>Max images & Selection</div>
                    <div style={styles.settingsPanelDesc}>These settings affect how many images can be selected and how selection behaves.</div>

                    <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10 }}>
                      <span style={{ width: 160, color: "#444", fontSize: 13 }}>Max images to select</span>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={maxImagesToSelect}
                        onChange={async (e) => {
                          const n = parseInt(e.target.value, 10);
                          if (!isNaN(n) && n >= 1 && n <= 30) {
                            setSettings((s) => (s ? { ...s, maxImagesToSelect: n } : null));
                            try {
                              const next = await updateSettings({ maxImagesToSelect: n });
                              setSettings(next);
                            } catch {
                              // ignore
                            }
                          }
                        }}
                        style={{ ...styles.settingsInput, width: 72 }}
                      />
                    </div>

                    <div style={{ marginTop: 18 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Selection mode</div>
                      <div style={{ ...styles.selectionRow, flexWrap: "wrap", rowGap: 8 }}>
                        <span style={styles.selectionWho}>Admin</span>
                        <button
                          type="button"
                          style={{ ...headerBtnSec, ...(selectionModeAdmin === "manual" ? headerBtnActive : {}) }}
                          onClick={async () => {
                            setSettings((s) => (s ? { ...s, selectionModeAdmin: "manual" as SelectionMode } : null));
                            try {
                              const next = await updateSettings({ selectionModeAdmin: "manual" as SelectionMode });
                              setSettings(next);
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          style={{ ...headerBtnSec, ...(selectionModeAdmin === "auto" ? headerBtnActive : {}) }}
                          onClick={async () => {
                            setSettings((s) => (s ? { ...s, selectionModeAdmin: "auto" as SelectionMode } : null));
                            try {
                              const next = await updateSettings({ selectionModeAdmin: "auto" as SelectionMode });
                              setSettings(next);
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          Auto
                        </button>
                        <span style={{ ...styles.selectionWho, marginLeft: 24 }}>User</span>
                        <button
                          type="button"
                          style={{ ...headerBtnSec, ...(selectionModeUser === "manual" ? headerBtnActive : {}) }}
                          onClick={async () => {
                            setSettings((s) => (s ? { ...s, selectionModeUser: "manual" as SelectionMode } : null));
                            try {
                              const next = await updateSettings({ selectionModeUser: "manual" as SelectionMode });
                              setSettings(next);
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          style={{ ...headerBtnSec, ...(selectionModeUser === "auto" ? headerBtnActive : {}) }}
                          onClick={async () => {
                            setSettings((s) => (s ? { ...s, selectionModeUser: "auto" as SelectionMode } : null));
                            try {
                              const next = await updateSettings({ selectionModeUser: "auto" as SelectionMode });
                              setSettings(next);
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          Auto
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div style={{ ...styles.modalActions, justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setShowCredentialsModal(false);
                }}
                style={headerBtnSec}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {(ipCheckError || ipCheckResult) && (
        <div style={styles.ipCheckBar}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1 }}>
              {ipCheckError && <p style={styles.ipCheckError}>{ipCheckError}</p>}
              {ipCheckResult && (
                <div style={styles.ipCheckResult}>
                  <p style={styles.ipCheckResultText}>
                    Scraper IP: <strong>{ipCheckResult.ip}</strong>
                    {ipCheckResult.usingProxy && " (via proxy)"}
                  </p>
                  <p style={styles.ipCheckHint}>
                    This IP is used when you run Process listings. Assigned when you logged in; changes when you log out.
                  </p>
                  {ipCheckResult.proxyFailedMessage && (
                    <p style={styles.ipCheckProxyFailed}>
                      Proxy failed; showing direct IP. {ipCheckResult.proxyFailedMessage}
                    </p>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setIpCheckResult(null);
                setIpCheckError("");
              }}
              style={styles.ipCheckCloseBtn}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
      )}
      <form onSubmit={handleSubmit} style={styles.form}>
        <div style={styles.modelSection}>
          <span style={styles.modelSectionTitle}>1. Choose Gemini model</span>
          <div style={styles.modelButtons}>
            {GEMINI_MODEL_IDS.map((id) => (
              <button
                key={id}
                type="button"
                title={MODEL_DESCRIPTIONS[id]}
                style={{
                  ...styles.modelBtn,
                  ...(model === id ? styles.modelBtnActive : {}),
                }}
                onClick={() => setModel(id)}
                disabled={loading}
              >
                {MODEL_LABELS[id]}
              </button>
            ))}
          </div>
          <p style={styles.modelDescription}>{MODEL_DESCRIPTIONS[model]}</p>
        </div>
        <label style={styles.label}>
          2. Immowelt URLs (max 5 URLs)
          <textarea
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            rows={5}
            placeholder="https://www.immowelt.at/..."
            style={styles.textarea}
            disabled={loading}
          />
        </label>
        <label style={styles.label}>
          3. Gemini image prompt
          <textarea
            value={prompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            rows={4}
            style={styles.textarea}
            disabled={loading}
          />
        </label>
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? "Processing…" : "Process listings"}
        </button>
        {error && <p style={styles.error}>{error}</p>}
      </form>

      {loading && jobStatus && (
        <section style={styles.progressSection}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <h2 style={styles.progressTitle}>Progress</h2>
            {getStoredRole() !== "user" && !jobStatus.finishedAt && (
              <button
                type="button"
                onClick={async () => {
                  if (!jobStatus?.id) return;
                  try {
                    await cancelJob(jobStatus.id);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Failed to stop");
                  }
                }}
                style={{ ...styles.headerBtn, background: "#c62828", color: "#fff" }}
              >
                Stop workflow
              </button>
            )}
          </div>
          <p style={styles.progressHint}>
            Screenshots of the page and generated photos appear below as they are created.
          </p>
          {jobStatus.listings.length === 0 && (
            <p style={styles.status}>Starting… (opening browser)</p>
          )}
          {jobStatus.listings.map((listing, i) => (
            <div key={i} style={styles.progressCard}>
              <div style={styles.progressCardHeader}>
                <span style={styles.progressCardUrl} title={listing.url}>
                  {shortenUrl(listing.url)}
                </span>
                <span
                  style={{
                    ...styles.progressBadge,
                    ...(listing.error
                      ? { background: "#ffebee", color: "#c62828" }
                      : listing.finishedAt
                        ? { background: "#e8f5e9", color: "#2e7d32" }
                        : { background: "#e3f2fd", color: "#1565c0" }),
                  }}
                >
                  {listing.status}
                </span>
              </div>
              {isAdmin && (listing.screenshots?.length ?? 0) > 0 && (
                <div style={styles.progressMediaBlock}>
                  <span style={styles.progressMediaLabel}>Screenshots of the page</span>
                  <div style={styles.progressThumbGrid}>
                    {listing.screenshots!.map((s, j) => (
                      <figure key={j} style={styles.progressThumbFigure}>
                        <img src={s.url} alt={s.step} style={styles.progressThumbImg} loading="lazy" />
                        <figcaption style={styles.progressThumbCaption}>{s.step}</figcaption>
                      </figure>
                    ))}
                  </div>
                </div>
              )}
              {(listing.generatedFiles?.length ?? 0) > 0 && (
                <div style={styles.progressMediaBlock}>
                  <span style={styles.progressMediaLabel}>Generated photos</span>
                  <div style={styles.progressThumbGrid}>
                    {listing.generatedFiles!.map((f, j) =>
                      f.previewUrl ? (
                        <figure key={j} style={styles.progressThumbFigure}>
                          <img src={f.previewUrl} alt={`Generated ${j + 1}`} style={styles.progressThumbImg} loading="lazy" />
                          <figcaption style={styles.progressThumbCaption}>Image {j + 1}</figcaption>
                        </figure>
                      ) : null
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {(results || (jobStatus?.finishedAt && jobStatus.listings.length > 0)) && jobStatus && (
        <section style={styles.results}>
          <h2>Results</h2>
          {isAdmin && typeof totalCostUsd === "number" && totalCostUsd > 0 && (
            <p style={styles.totalCost}>Total cost: ${totalCostUsd.toFixed(4)}</p>
          )}
          {jobStatus.listings.map((listing, i) =>
            listing.imageUrls && listing.imageUrls.length > 0 && !listing.folderUrl ? (
              useAutoSelect ? (
                <AutoFirstNCard
                  key={i}
                  jobId={jobStatus.id}
                  listingIndex={i}
                  listing={listing}
                  maxImages={maxImagesToSelect}
                  onProcessComplete={() => getJobStatus(jobStatus.id).then(setJobStatus)}
                  autoStart
                />
              ) : (
                <ImageSelectionCard
                  key={i}
                  jobId={jobStatus.id}
                  listingIndex={i}
                  listing={listing}
                  maxImages={maxImagesToSelect}
                  onProcessComplete={() => getJobStatus(jobStatus.id).then(setJobStatus)}
                />
              )
            ) : (
              <ListingResultCard
                key={i}
                result={jobListingToResult(listing)}
                isAdmin={isAdmin}
              />
            )
          )}
        </section>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loginScreen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: "system-ui, sans-serif",
  },
  mainScreen: {
    minHeight: "100vh",
    padding: 24,
    fontFamily: "system-ui, sans-serif",
    maxWidth: 720,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginBottom: 24,
  },
  headerTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: "1.5rem",
    margin: 0,
  },
  headerGroups: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "flex-start",
  },
  headerGroup: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 8,
    background: "#f5f5f5",
    border: "1px solid #e0e0e0",
  },
  headerGroupLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    marginRight: 4,
  },
  selectionRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  selectionWho: {
    fontSize: 12,
    fontWeight: 600,
    color: "#333",
    minWidth: 40,
    marginLeft: 6,
    marginRight: -1,
    textAlign: "right",
  },
  headerButtons: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  headerBtn: {
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    minWidth: 88,
    border: "2px solid #1976d2",
    borderRadius: 6,
    cursor: "pointer",
    background: "#1976d2",
    color: "#fff",
  },
  /** Matches modelBtn (Nano Banana style): white bg, no visible border. Use with modelBtnActive for selected state. */
  headerBtnSecondary: {
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    background: "#fff",
    color: "#333",
    border: "1px solid #d0d0d0",
    borderColor: "#d0d0d0",
    borderRadius: 6,
    cursor: "pointer",
    boxShadow: "none",
  },
  ipCheckBar: {
    marginBottom: 16,
    padding: "10px 12px",
    background: "#f5f5f5",
    borderRadius: 6,
    border: "1px solid #e0e0e0",
  },
  ipCheckCloseBtn: {
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#fff",
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    color: "#666",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontWeight: 600,
  },
  labelText: {
    fontWeight: 600,
    display: "block",
    marginBottom: 8,
  },
  modelSectionTitle: {
    display: "block",
    fontWeight: 700,
    fontSize: 15,
    marginBottom: 10,
    color: "#1a1a1a",
  },
  modelSection: {
    padding: "14px 16px",
    background: "#e8f4fc",
    border: "2px solid #1976d2",
    borderRadius: 8,
    marginBottom: 16,
  },
  modelDescription: {
    margin: "10px 0 0",
    fontSize: 13,
    color: "#555",
    lineHeight: 1.4,
  },
  ipCheckError: {
    margin: "8px 0 0",
    fontSize: 13,
    color: "#c62828",
  },
  ipCheckResult: {
    margin: "8px 0 0",
  },
  ipCheckResultText: {
    margin: 0,
    fontSize: 14,
    color: "#2e7d32",
  },
  ipCheckHint: {
    margin: "4px 0 0",
    fontSize: 12,
    color: "#666",
  },
  ipCheckProxyFailed: {
    margin: "4px 0 0",
    fontSize: 12,
    color: "#e65100",
  },
  modelButtons: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
  },
  modelBtn: {
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 500,
    background: "#fff",
    color: "#333",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 6,
    cursor: "pointer",
    outline: "none",
    boxShadow: "none",
  },
  modelBtnActive: {
    background: "#1976d2",
    color: "#fff",
    borderColor: "#1976d2",
    outline: "none",
    boxShadow: "none",
  },
  totalCost: {
    marginBottom: 16,
    fontSize: 16,
    fontWeight: 600,
    color: "#333",
  },
  passwordRow: {
    display: "flex",
    alignItems: "stretch",
    gap: 0,
    maxWidth: 320,
  },
  input: {
    padding: 12,
    fontSize: 16,
    border: "1px solid #ccc",
    borderRadius: "6px 0 0 6px",
    flex: 1,
    minWidth: 0,
  },
  passwordToggle: {
    width: 44,
    background: "#e0e0e0",
    color: "#333",
    border: "1px solid #ccc",
    borderLeft: "none",
    borderRadius: "0 6px 6px 0",
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    padding: 0,
  },
  textarea: {
    padding: 12,
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 6,
    resize: "vertical",
  },
  button: {
    padding: "12px 24px",
    fontSize: 16,
    background: "#1976d2",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  error: {
    color: "#c00",
    margin: 0,
  },
  errorText: {
    color: "#c00",
    margin: "8px 0",
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  },
  status: {
    color: "#666",
    marginTop: 16,
  },
  progressSection: {
    marginTop: 24,
    padding: 16,
    background: "#f5f5f5",
    borderRadius: 8,
    border: "1px solid #e0e0e0",
  },
  progressTitle: {
    margin: "0 0 8px",
    fontSize: 18,
  },
  progressHint: {
    margin: "0 0 16px",
    fontSize: 13,
    color: "#666",
  },
  progressCard: {
    marginBottom: 12,
    padding: 12,
    background: "#fff",
    borderRadius: 6,
    border: "1px solid #e0e0e0",
  },
  progressCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  progressCardUrl: {
    fontSize: 13,
    color: "#333",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1 1 200px",
    minWidth: 0,
  },
  progressBadge: {
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 4,
    flexShrink: 0,
  },
  progressLogs: {
    margin: "8px 0 0",
    paddingLeft: 18,
    fontSize: 12,
    color: "#555",
    lineHeight: 1.4,
  },
  progressLogItem: {
    marginBottom: 2,
    wordBreak: "break-word",
  },
  progressMediaBlock: {
    marginTop: 12,
  },
  progressMediaLabel: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#555",
    marginBottom: 6,
  },
  progressThumbGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  progressThumbFigure: {
    margin: 0,
    flex: "1 1 120px",
    maxWidth: 180,
  },
  progressThumbImg: {
    width: "100%",
    height: "auto",
    border: "1px solid #ddd",
    borderRadius: 6,
    display: "block",
    background: "#f0f0f0",
  },
  progressThumbCaption: {
    marginTop: 4,
    fontSize: 11,
    color: "#666",
  },
  results: {
    marginTop: 32,
  },
  resultCard: {
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
    background: "#fafafa",
  },
  card: {
    border: "2px solid",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
  driveFolderBlock: {
    marginTop: 16,
    padding: 20,
    background: "linear-gradient(135deg, #f0f7ff 0%, #e8f4fd 100%)",
    borderRadius: 12,
    border: "1px solid #bbdefb",
  },
  driveFolderHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  driveFolderTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1565c0",
  },
  driveFolderCost: {
    fontSize: 14,
    color: "#555",
  },
  driveFolderDesc: {
    margin: "0 0 16px",
    fontSize: 15,
    color: "#333",
    lineHeight: 1.5,
  },
  driveFolderButton: {
    display: "inline-block",
    padding: "12px 24px",
    fontSize: 16,
    fontWeight: 500,
    color: "#fff",
    background: "#1976d2",
    border: "2px solid #1976d2",
    borderRadius: 6,
    textDecoration: "none",
    cursor: "pointer",
  },
  selectionHint: {
    margin: "8px 0 12px",
    fontSize: 14,
    color: "#555",
  },
  selectionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
    gap: 10,
    marginBottom: 16,
  },
  selectionThumb: {
    padding: 0,
    borderWidth: 3,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 8,
    cursor: "pointer",
    background: "#eee",
    overflow: "hidden",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
  },
  selectionThumbSelected: {
    borderColor: "#1a73e8",
    boxShadow: "0 0 0 2px #1a73e8",
  },
  selectionThumbImg: {
    width: "100%",
    height: 100,
    objectFit: "cover",
    display: "block",
  },
  settingsRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  settingsLabel: {
    fontSize: 14,
    fontWeight: 600,
  },
  settingsInput: {
    width: 56,
    padding: "6px 8px",
    marginLeft: 4,
    fontSize: 14,
    borderRadius: 4,
    border: "1px solid #ccc",
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  debugWrap: {
    marginTop: 14,
  },
  debugToggle: {
    padding: "8px 12px",
    fontSize: 13,
    background: "#f5f5f5",
    border: "1px solid #ddd",
    borderRadius: 6,
    cursor: "pointer",
  },
  debugPanel: {
    marginTop: 10,
    padding: 12,
    background: "#fff",
    border: "1px solid #eee",
    borderRadius: 8,
  },
  debugError: {
    margin: "0 0 10px",
    color: "#c62828",
    fontSize: 13,
  },
  debugSection: {
    marginTop: 10,
  },
  debugTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#333",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  debugList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 13,
  },
  debugPre: {
    margin: 0,
    padding: 10,
    background: "#0b1020",
    color: "#e6e6e6",
    borderRadius: 6,
    fontSize: 12,
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.4,
  },
  link: {
    color: "#1976d2",
    wordBreak: "break-all",
  },
  badge: {
    flexShrink: 0,
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 12,
    background: "#eee",
  },
  meta: {
    margin: "8px 0",
    color: "#666",
    fontSize: 14,
  },
  fileList: {
    margin: "8px 0 0",
    paddingLeft: 20,
  },
  stepLogSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid #eee",
  },
  stepLogToggle: {
    background: "none",
    border: "none",
    color: "#1976d2",
    cursor: "pointer",
    padding: "4px 0",
    fontSize: 14,
    fontFamily: "inherit",
  },
  stepLog: {
    margin: "8px 0 0",
    paddingLeft: 20,
    fontSize: 13,
    color: "#444",
    lineHeight: 1.5,
    maxHeight: 280,
    overflowY: "auto",
  },
  stepLogItem: {
    marginBottom: 4,
    wordBreak: "break-word",
  },
  screenshotsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid #eee",
  },
  screenshotsGrid: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 8,
  },
  screenshotFigure: {
    margin: 0,
    flex: "1 1 280px",
    maxWidth: 400,
  },
  screenshotImg: {
    width: "100%",
    height: "auto",
    border: "1px solid #ddd",
    borderRadius: 6,
    display: "block",
  },
  screenshotCaption: {
    marginTop: 4,
    fontSize: 12,
    color: "#666",
  },
  noScreenshotNote: {
    margin: 0,
    fontSize: 14,
    color: "#666",
    fontStyle: "italic",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: 24,
  },
  modalPanel: {
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
    maxWidth: 420,
    width: "100%",
    maxHeight: "90vh",
    overflowY: "auto",
    padding: 20,
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    padding: 0,
    border: "none",
    background: "none",
    fontSize: 24,
    lineHeight: 1,
    cursor: "pointer",
    color: "#666",
  },
  modalActions: {
    display: "flex",
    gap: 10,
    marginTop: 20,
    paddingTop: 16,
    borderTop: "1px solid #eee",
  },
  settingsModalBody: {
    display: "flex",
    gap: 14,
    marginTop: 12,
  },
  settingsTabs: {
    width: 200,
    borderRight: "1px solid #e6e6e6",
    paddingRight: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  settingsTabBtn: {
    textAlign: "left",
    padding: "10px 10px",
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#e0e0e0",
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 700,
    color: "#333",
  },
  settingsTabBtnActive: {
    background: "#1976d2",
    borderColor: "#1976d2",
    color: "#fff",
  },
  settingsPanel: {
    flex: 1,
    minWidth: 0,
    paddingLeft: 4,
  },
  settingsPanelTitle: {
    fontSize: 16,
    fontWeight: 800,
    marginBottom: 6,
  },
  settingsPanelDesc: {
    fontSize: 13,
    color: "#555",
    marginBottom: 12,
    lineHeight: 1.35,
  },
  hostList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  hostRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 10px",
    border: "1px solid #eee",
    borderRadius: 10,
    background: "#fff",
  },
  hostValue: {
    width: 160,
    fontWeight: 800,
    fontSize: 13,
    color: "#333",
    wordBreak: "break-all",
  },
  iconBtn: {
    width: 36,
    height: 32,
    border: "1px solid #ddd",
    borderRadius: 8,
    background: "#fff",
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
    padding: 0,
  },
  credentialError: {
    margin: "0 0 12px",
    color: "#c62828",
    fontSize: 14,
  },
  credentialSuccess: {
    margin: "0 0 12px",
    color: "#2e7d32",
    fontSize: 14,
  },
  credentialSection: {
    marginBottom: 20,
  },
  credentialSectionLabel: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "#666",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },
  credentialRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  credentialRoleName: {
    fontSize: 14,
    fontWeight: 500,
    minWidth: 64,
  },
  credentialCurrentValue: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    fontSize: 14,
    background: "#f5f5f5",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    fontFamily: "monospace",
  },
  credentialInput: {
    flex: 1,
    minWidth: 0,
    padding: "8px 10px",
    fontSize: 14,
    border: "1px solid #ccc",
    borderRadius: 6,
  },
  credentialRemoveBtn: {
    padding: "8px 12px",
    fontSize: 13,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: 6,
    cursor: "pointer",
    color: "#666",
  },
};

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 5c5.5 0 9.5 4.1 10.9 6.1.2.3.2.7 0 1C21.5 14 17.5 18 12 18S2.5 14 1.1 12.1c-.2-.3-.2-.7 0-1C2.5 9.1 6.5 5 12 5Zm0 2C7.9 7 4.6 10 3.2 11.6 4.6 13.2 7.9 16 12 16s7.4-2.8 8.8-4.4C19.4 10 16.1 7 12 7Zm0 1.5A3.5 3.5 0 1 1 12 15a3.5 3.5 0 0 1 0-7Zm0 2A1.5 1.5 0 1 0 12 13a1.5 1.5 0 0 0 0-3Z"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4.3 3 3 4.3l3 3C3.2 8.9 1.6 10.8 1.1 11.6c-.2.3-.2.7 0 1C2.5 14.5 6.5 18.5 12 18.5c1.7 0 3.2-.4 4.6-1l3.1 3.1L21 19.3 4.3 3ZM8 9.3l1.6 1.6a2.6 2.6 0 0 0-.1.6A2.5 2.5 0 0 0 12 14c.2 0 .4 0 .6-.1l1.6 1.6c-.7.3-1.4.5-2.2.5-2.5 0-4.6-1.7-5.9-3.4.7-.9 1.9-2.2 3.5-3.3Zm4.6 1.1 2.7 2.7a2.5 2.5 0 0 0-2.7-2.7Zm-.6-4.4c5.5 0 9.5 4.1 10.9 6.1.2.3.2.7 0 1-.7 1-2.2 2.8-4.5 4.2l-1.5-1.5c1.7-1 3-2.3 3.6-3.1C19.4 10.9 16.1 8 12 8c-.7 0-1.4.1-2 .3L8.6 6.9c1-.4 2.1-.6 3.4-.6Z"
      />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.3V21h3.7l10.9-10.9-3.7-3.7L3 17.3Zm2.2 2.5v-1.6l8.5-8.5 1.6 1.6-8.5 8.5H5.2ZM20.7 7.1c.4-.4.4-1 0-1.4l-2.4-2.4c-.4-.4-1-.4-1.4 0l-1.9 1.9 3.7 3.7 2-1.8Z"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7A1 1 0 0 0 5.7 7.1l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z"
      />
    </svg>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthenticated(false);
      setChecking(false);
      return;
    }
    // Validate token immediately so expired sessions go back to login without user interaction.
    validateToken()
      .then((ok) => setAuthenticated(ok))
      .catch(() => setAuthenticated(true))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    const onAuthExpired = () => setAuthenticated(false);
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, []);

  if (checking) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!authenticated) return <LoginScreen onSuccess={() => setAuthenticated(true)} />;
  return <MainScreen />;
}
