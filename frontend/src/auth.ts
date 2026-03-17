/**
 * Session storage for token and role (shared-password auth, admin vs user).
 * Uses sessionStorage so the token is cleared when the tab/window is closed.
 */

const TOKEN_KEY = "listing_processor_token";
const ROLE_KEY = "listing_processor_role";

const storage = typeof sessionStorage !== "undefined" ? sessionStorage : null;

export type AuthRole = "admin" | "user";

export function getStoredToken(): string | null {
  return storage ? storage.getItem(TOKEN_KEY) : null;
}

export function setStoredToken(token: string): void {
  storage?.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  storage?.removeItem(TOKEN_KEY);
}

export function getStoredRole(): AuthRole {
  const r = storage ? storage.getItem(ROLE_KEY) : null;
  return r === "admin" ? "admin" : "user";
}

export function setStoredRole(role: AuthRole): void {
  storage?.setItem(ROLE_KEY, role);
}

export function clearStoredRole(): void {
  storage?.removeItem(ROLE_KEY);
}

export function isAuthenticated(): boolean {
  return !!getStoredToken();
}
