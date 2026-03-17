/**
 * Shared-password auth: roles and passwords from persistent credentials store.
 * Token is stored in memory with role and expiry.
 */

import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { getCredentials } from "./credentials";

export type AuthRole = "admin" | "user";

/** Token lifetime: 24 hours. Expired tokens are rejected and removed. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface TokenEntry {
  role: AuthRole;
  createdAt: number;
}

const tokenStore = new Map<string, TokenEntry>();

function isExpired(entry: TokenEntry): boolean {
  return Date.now() - entry.createdAt > TOKEN_TTL_MS;
}

export function generateToken(role: AuthRole): string {
  const token = uuidv4();
  tokenStore.set(token, { role, createdAt: Date.now() });
  return token;
}

export function isValidToken(token: string): boolean {
  const entry = tokenStore.get(token);
  if (!entry) return false;
  if (isExpired(entry)) {
    tokenStore.delete(token);
    return false;
  }
  return true;
}

export function getRoleForToken(token: string): AuthRole | undefined {
  const entry = tokenStore.get(token);
  return entry && !isExpired(entry) ? entry.role : undefined;
}

export function revokeToken(token: string): void {
  tokenStore.delete(token);
}

export function loginHandler(req: Request, res: Response): void {
  const raw = (req.body as { password?: unknown }).password;
  const password = typeof raw === "string" ? raw.trim() : "";
  const credentials = getCredentials();
  let role: AuthRole | null = null;
  for (const [r, p] of Object.entries(credentials)) {
    if (password && p === password && (r === "admin" || r === "user")) {
      role = r;
      break;
    }
  }
  if (!role) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  const token = generateToken(role);
  res.json({ token, role });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!isValidToken(token)) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const reqAuth = req as Request & { authRole?: AuthRole; authToken?: string };
  reqAuth.authRole = getRoleForToken(token);
  reqAuth.authToken = token;
  next();
}

/** Use after authMiddleware. Returns 403 if the current user is not admin. */
export function adminOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const role = (req as Request & { authRole?: AuthRole }).authRole;
  if (role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  next();
}
