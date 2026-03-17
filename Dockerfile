# Multi-stage build for Apartments Generator (listing image processor)
# Final image runs Node + Playwright Chromium; backend serves frontend static build.

# --- Stage 1: Build frontend ---
FROM node:20-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install
COPY frontend/ ./
# Same-origin when served by backend; set VITE_API_URL if backend is on another host
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- Stage 2: Build backend ---
FROM node:20-bookworm-slim AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --ignore-scripts
COPY backend/ ./
RUN npm run build

# --- Stage 3: Runtime (Node + Playwright Chromium) ---
FROM node:20-bookworm AS runtime
WORKDIR /app

# Playwright Chromium dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    fonts-liberation libappindicator3-1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json* ./backend/
COPY --from=backend /app/backend/dist ./backend/dist
RUN cd backend && npm ci --omit=dev 2>/dev/null || npm install --omit=dev && npx playwright install chromium

COPY --from=frontend /app/frontend/build ./frontend/build

ENV NODE_ENV=production
EXPOSE 3001

# Run from project root so backend can resolve frontend path
CMD ["node", "backend/dist/index.js"]
