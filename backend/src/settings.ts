/**
 * Persistent settings (survives restart). Stored in a JSON file.
 */

import * as fs from "fs";
import * as path from "path";

const SETTINGS_DIR = path.join(__dirname, "..");
const SETTINGS_FILE = path.join(SETTINGS_DIR, ".settings.json");

const DEFAULT_MAX_IMAGES = 10;

export type SelectionMode = "manual" | "auto";

export interface AppSettings {
  maxImagesToSelect: number;
  /** Persistent proxy on/off for all users until admin changes it. */
  proxyEnabled: boolean;
  /** Selection mode for admin: manual = pick images; auto = use first N. */
  selectionModeAdmin: SelectionMode;
  /** Selection mode for user: manual = pick images; auto = use first N. */
  selectionModeUser: SelectionMode;
  /**
   * Allowed hosts for non-admin users (lowercase). Admins can process any host.
   * Examples: "immowelt.at", "immowelt.de" (variants like "www.immowelt.at" are auto-included).
   */
  allowedHostsUser: string[];
}

const VALID_SELECTION_MODES: SelectionMode[] = ["manual", "auto"];

function normalizeAndExpandHosts(rawHosts: unknown[]): string[] {
  const set = new Set<string>();
  for (const x of rawHosts) {
    if (typeof x !== "string") continue;
    const trimmed = x.trim().toLowerCase();
    if (!trimmed) continue;
    const withoutScheme = trimmed.replace(/^https?:\/\//, "");
    const hostOnly = withoutScheme.replace(/\/.*$/, "");
    if (!hostOnly) continue;
    const base = hostOnly.startsWith("www.") ? hostOnly.slice(4) : hostOnly;
    if (!base) continue;
    set.add(base);
    set.add(`www.${base}`);
  }
  return Array.from(set).slice(0, 50);
}

function readSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const data = JSON.parse(raw) as Partial<AppSettings>;
    const rawHosts = Array.isArray((data as any).allowedHostsUser) ? ((data as any).allowedHostsUser as unknown[]) : [];
    const allowedHostsUser = normalizeAndExpandHosts(rawHosts);
    return {
      maxImagesToSelect:
        typeof data.maxImagesToSelect === "number" && data.maxImagesToSelect >= 1 && data.maxImagesToSelect <= 30
          ? data.maxImagesToSelect
          : DEFAULT_MAX_IMAGES,
      proxyEnabled: typeof data.proxyEnabled === "boolean" ? data.proxyEnabled : false,
      selectionModeAdmin: VALID_SELECTION_MODES.includes(data.selectionModeAdmin as SelectionMode) ? (data.selectionModeAdmin as SelectionMode) : "manual",
      selectionModeUser: VALID_SELECTION_MODES.includes(data.selectionModeUser as SelectionMode) ? (data.selectionModeUser as SelectionMode) : "manual",
      allowedHostsUser: allowedHostsUser.length > 0 ? allowedHostsUser : normalizeAndExpandHosts(["immowelt.at"]),
    };
  } catch {
    return {
      maxImagesToSelect: DEFAULT_MAX_IMAGES,
      proxyEnabled: false,
      selectionModeAdmin: "manual",
      selectionModeUser: "manual",
      allowedHostsUser: normalizeAndExpandHosts(["immowelt.at"]),
    };
  }
}

let cached: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cached) return cached;
  cached = readSettings();
  return cached;
}

export function updateSettings(update: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const nextAllowedHostsUser = Array.isArray((update as any).allowedHostsUser)
    ? normalizeAndExpandHosts((update as any).allowedHostsUser as unknown[])
    : current.allowedHostsUser;
  const next: AppSettings = {
    maxImagesToSelect:
      typeof update.maxImagesToSelect === "number" && update.maxImagesToSelect >= 1 && update.maxImagesToSelect <= 30
        ? update.maxImagesToSelect
        : current.maxImagesToSelect,
    proxyEnabled: typeof update.proxyEnabled === "boolean" ? update.proxyEnabled : current.proxyEnabled,
    selectionModeAdmin: VALID_SELECTION_MODES.includes(update.selectionModeAdmin as SelectionMode) ? (update.selectionModeAdmin as SelectionMode) : current.selectionModeAdmin,
    selectionModeUser: VALID_SELECTION_MODES.includes(update.selectionModeUser as SelectionMode) ? (update.selectionModeUser as SelectionMode) : current.selectionModeUser,
    allowedHostsUser: nextAllowedHostsUser,
  };
  cached = next;
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8");
  } catch (e) {
    console.error("[settings] Failed to write .settings.json:", e);
  }
  return next;
}
