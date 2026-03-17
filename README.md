# Listing Image Processor

Full-stack web app: scrape listing galleries (e.g. immowelt.at), select up to 10 photos per listing, process them with Google Gemini for TikTok/phone-style output, and upload results to Google Drive.

- **Frontend:** React (TypeScript) + Vite
- **Backend:** Node.js + Express + TypeScript
- **Headless browser:** Playwright
- **Auth:** Admin and user roles; passwords are hardcoded in `backend/src/auth.ts` (ADMIN_PASSWORD, USER_PASSWORD). Token in localStorage until logout.

## Environment variables

Create a `.env` file in the project root (see `.env.example`). Required:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key. |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Drive folder ID under which listing subfolders are created. |

**Google Drive** – use *one* of these:

- **Option A (service account):** set `GOOGLE_DRIVE_CREDENTIALS_PATH` to the path of your service account JSON file.
- **Option B (OAuth):** set all three of `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and `GOOGLE_DRIVE_REFRESH_TOKEN`. Run `node backend/scripts/get-drive-refresh-token.js` once to obtain the refresh token.

Optional:

- `PORT` – Server port (default `3000`).
- `NODE_ENV` – `development` or `production`.

## Google Drive setup

1. Create a Google Cloud project and enable the **Drive API**.
2. **Either** use a **service account** (Option A) **or** OAuth (Option B).

   **Option A – Service account**  
   Create a service account, download its JSON key, save it (e.g. `./credentials/drive-service-account.json`), and set `GOOGLE_DRIVE_CREDENTIALS_PATH`. Create a folder in Drive, copy its folder ID from the URL, set `GOOGLE_DRIVE_ROOT_FOLDER_ID`, and share that folder with the service account email as **Editor**.

   **Option B – OAuth (client ID + secret)**  
   Create **OAuth 2.0 credentials** (Desktop app or Web application) in the Cloud console. Set `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` in `.env`. Run:

   ```bash
   node backend/scripts/get-drive-refresh-token.js
   ```

   Open the printed URL, sign in with the Google account that owns the Drive folder, allow access, then paste the code you get back into the script. Copy the printed `GOOGLE_DRIVE_REFRESH_TOKEN` into your `.env`. Create a folder in Drive, copy its folder ID from the URL, and set `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

## Running locally

### One-time setup

```bash
npm run install:all
```

**Playwright Chromium** (required for scraping) is installed automatically when you run `npm install` in the backend (postinstall) and again at server startup if missing. No manual step needed.

### Development

- **Backend only:** `npm run dev:backend` (runs on port 3000 by default).
- **Frontend only:** `npm run dev:frontend` (Vite dev server on port 5173; API requests are proxied to `http://localhost:3000`).
- **Both:** `npm run dev` (backend on 3000 + frontend on 5173 concurrently).

Open **http://localhost:5173** for the app when using `npm run dev`. The backend runs on port 3000; the frontend proxies `/api` and `/health` to it.

### Production build and run

```bash
npm run build
npm start
```

This builds the backend, builds the React app into `frontend/build`, and starts the Node server. The server serves the built frontend and all API routes.

## Deployment (e.g. Hostinger)

1. **Node version:** Use Node 18+ (set in Hostinger’s Node version if available).

2. **Playwright on Linux:**  
   Chromium is installed automatically at startup. On minimal Linux hosts you may need system dependencies first; run in the **backend** directory:
   ```bash
   npx playwright install chromium --with-deps
   ```
   If that fails, see [Playwright Linux](https://playwright.dev/docs/intro#installing-system-dependencies).

3. **Single deployment:**  
   Deploy the whole repo. Run:
   - `npm run install:all` (or install root + backend + frontend).
   - On Linux, if Chromium fails to run, try `cd backend && npx playwright install chromium --with-deps`.
   - `npm run build`.
   - Start with `npm start` (runs `node backend/dist/index.js`). Set `PORT` if the host expects a different port.

4. **Environment:** Set all required env vars on the host (password, Gemini key, Drive credentials path, Drive root folder ID).

## API

- `GET /health` – `{ "status": "ok" }`
- `POST /api/login` – Body: `{ "password": "…" }` → `{ "token": "…" }`
- `POST /api/process-listings` – Header: `Authorization: Bearer <token>`, Body: `{ "urls": ["url1", …], "prompt": "…" }` (max 5 URLs). Returns `{ "results": [ … ] }` per listing (folderUrl, imagesFound, imagesUsed, generatedFiles, logs, error).
- `GET /api/admin/jobs` – Protected. Returns recent jobs and logs (e.g. `?limit=20`).

## Gemini image output

The app calls the Gemini API with the image and prompt and expects image data in the response. If your Gemini model does not return inline image data, you will see an error like “Gemini did not return an image.” In that case you may need to switch to a model or API that supports image generation/editing output (e.g. Imagen or a dedicated image-capable Gemini endpoint) and adapt `backend/src/services/gemini.ts` accordingly.

## Project structure

- `frontend/` – React SPA (login, URL/prompt form, results).
- `backend/` – Express server, auth, scraper (Playwright), photo selection, Gemini, Drive, jobs store.
