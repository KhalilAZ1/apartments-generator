import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function nowMs(): number {
  return Date.now();
}

export function rateLimit(opts: { windowMs: number; max: number; keyPrefix: string }) {
  const { windowMs, max, keyPrefix } = opts;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    const key = `${keyPrefix}:${ip}`;
    const now = nowMs();
    const b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    b.count += 1;
    if (b.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }

    next();
  };
}

