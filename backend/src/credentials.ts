/**
 * Persistent credentials for admin and user only. Stored in a JSON file.
 */

import * as fs from "fs";
import * as path from "path";

const CREDENTIALS_DIR = path.join(__dirname, "..");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, ".credentials.json");

export const CREDENTIAL_ROLES = ["admin", "user"] as const;
export type CredentialRole = (typeof CREDENTIAL_ROLES)[number];

const DEFAULT_CREDENTIALS: Record<CredentialRole, string> = {
  admin: "admin",
  user: "user",
};

function readCredentials(): Record<CredentialRole, string> {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<CredentialRole, string> = { ...DEFAULT_CREDENTIALS };
    for (const role of CREDENTIAL_ROLES) {
      const value = data[role];
      if (typeof value === "string" && value.length > 0) out[role] = value;
    }
    return out;
  } catch {
    return { ...DEFAULT_CREDENTIALS };
  }
}

let cached: Record<CredentialRole, string> | null = null;

export function getCredentials(): Record<CredentialRole, string> {
  if (cached) return cached;
  cached = readCredentials();
  return cached;
}

function invalidateCache(): void {
  cached = null;
}

export function getRoleNames(): CredentialRole[] {
  return [...CREDENTIAL_ROLES];
}

/**
 * Update admin and/or user password. Only "admin" and "user" are allowed.
 */
export function updateCredentials(updates: Partial<Record<CredentialRole, string>>): void {
  const current = { ...getCredentials() };
  for (const role of CREDENTIAL_ROLES) {
    const password = updates[role];
    if (typeof password === "string" && password.length > 0) {
      current[role] = password;
    }
  }
  for (const role of CREDENTIAL_ROLES) {
    if (!current[role] || current[role].length < 1) {
      throw new Error(`Password for "${role}" cannot be empty`);
    }
  }
  try {
    if (!fs.existsSync(CREDENTIALS_DIR)) fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    console.error("[credentials] Failed to write .credentials.json:", e);
    throw new Error("Failed to save credentials");
  }
  invalidateCache();
}
