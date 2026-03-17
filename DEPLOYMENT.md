# Deploying to Hostinger (VPS)

This app needs **Node.js 18+** and **Playwright (Chromium)**. Hostinger **shared hosting** does not support long-running Node apps or browser automation, so you need a **VPS** (or any plan where you can run Node and install Chromium).

---

# Option A: Deploy with Docker (recommended if you use Docker Manager)

Use this if you run the app via **Docker** or **Hostinger Docker Manager**.

## 1. Prepare the project

### How to get the project on the VPS

**Option 1 – Clone with Git (recommended if the code is in a repo)**

1. SSH into the VPS (or open **Terminal** in Hostinger).
2. Install Git if needed: `apt update && apt install -y git`
3. Create the folder and clone (replace `YOUR_REPO_URL` with your actual URL, e.g. `https://github.com/youruser/your-repo.git`):

```bash
mkdir -p /root/apartments-generator
cd /root/apartments-generator
git clone YOUR_REPO_URL .
```

Or use `/var/www/apartments-generator` if you prefer to keep web apps in `/var/www`. The project is now in that folder. Do **not** commit `.env` to Git; create it on the server (see below).

**Option 2 – Upload with SFTP or File Manager**

1. On your **local machine**, open the project folder (the one that contains `backend/`, `frontend/`, `Dockerfile`, `docker-compose.yml`, `package.json`).
2. **Using an SFTP client (FileZilla, WinSCP, etc.):**
   - Connect to the VPS (host: your VPS IP, user: root or your SSH user, password or key).
   - On the **remote** side, go to `/root` (or `/var/www`) and create a folder `apartments-generator`.
   - Upload **everything** from your local project into that folder (e.g. `/root/apartments-generator/`): the root files (`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `package.json`) and the full `backend/` and `frontend/` folders (with their contents). Do **not** upload `node_modules` or `.env` from your PC; create `.env` on the server.
3. **Using Hostinger File Manager:** Upload a **ZIP** of the project (excluding `node_modules` and `.env`), then in the VPS Terminal run: `mkdir -p /root/apartments-generator && cd /root && unzip -o your-uploaded.zip -d apartments-generator` (adjust the ZIP name as needed; if the ZIP contains a top-level folder, you may need to move contents up).

**What must be on the server**

The folder (e.g. `/root/apartments-generator` or `/var/www/apartments-generator`) must contain:

- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`
- `package.json`
- `backend/` (with `package.json`, `src/`, `tsconfig.json`, etc.)
- `frontend/` (with `package.json`, `src/`, `index.html`, `vite.config.ts`, etc.)

Do **not** upload `.env` from your computer. Create `.env` on the server in the same folder as `docker-compose.yml` (see “Environment variables” in Option B for the list of variables).

- If you use a **service account** for Google Drive, upload the JSON file and in `docker-compose.yml` uncomment the `volumes` section that mounts it into the container.

## 2. Build and run

```bash
cd /path/to/apartments-generator   # folder with Dockerfile + docker-compose.yml
docker compose up -d --build
```

The Docker project will appear as **apartments-generator** in Docker Manager. The app listens on **port 3001** (set `PORT=3001` in `.env`). Use “Open” to access the app or map the port to your domain.

## 3. Docker Manager (Hostinger)

- In Docker Manager, create a new project (or use “Compose”).
- Point it at the folder that contains `docker-compose.yml`.
- Set environment variables in the UI if you prefer not to use a `.env` file.
- Build and start the project. Use “Open” to access the app (or configure your domain to the exposed port).

## 4. Useful commands

```bash
docker compose up -d --build   # Build and start in background
docker compose logs -f app     # Follow logs
docker compose ps              # Status
docker compose down            # Stop and remove containers
```

**To remove the project:** From the project folder run `docker compose down`, then delete the folder (e.g. `rm -rf /root/apartments-generator`).

**Hostinger VPS:** Install Docker first (or use Hostinger’s Docker Manager). Put the project in a folder (e.g. `/root/apartments-generator`), add `.env` with `PORT=3001`, then run `docker compose up -d --build`. The project will show as **apartments-generator** in Docker Manager. For HTTPS, put Nginx in front and use `proxy_pass http://127.0.0.1:3001`.

---

# Option B: Deploy without Docker (manual on VPS)

## 1. Hostinger: get a VPS

- In Hostinger, order a **VPS** (e.g. KVM).
- Note the server IP, SSH user, and password (or use SSH keys).
- Point your domain’s A record to the VPS IP (e.g. `yourdomain.com` → server IP).

---

## 2. Server setup (SSH into the VPS)

```bash
# Update system (Ubuntu/Debian)
sudo apt update && sudo apt upgrade -y

# Node.js 18+ (using NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Chromium dependencies (required for Playwright)
sudo apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2

# Optional: Nginx (reverse proxy + SSL)
sudo apt install -y nginx
```

---

## 3. Upload and build the app

**Option A: Git (recommended)**

```bash
cd /var/www   # or any directory you use
sudo git clone https://github.com/YOUR_USER/listing-image-processor.git
cd listing-image-processor
```

**Option B: Upload via SFTP/FTP**

Upload the whole project (including `backend/`, `frontend/`, root `package.json`). Then:

```bash
cd /path/to/listing-image-processor
```

**Build and install:**

```bash
# Install root + backend + frontend deps
npm run install:all

# Build backend (TypeScript) and frontend (Vite/React)
npm run build

# Install Playwright Chromium (required for scraping)
cd backend && npx playwright install chromium --with-deps
cd ..
```

---

## 4. Environment variables

Create a `.env` file in the **project root** (same folder as root `package.json`):

```bash
nano .env
```

Add (replace with your real values):

```env
# Required
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_drive_folder_id

# Drive: either service account path OR OAuth trio
# Option 1 – service account (path on server)
GOOGLE_DRIVE_CREDENTIALS_PATH=/var/www/listing-image-processor/backend/credentials.json

# Option 2 – OAuth (client ID, secret, refresh token)
# GOOGLE_DRIVE_CLIENT_ID=...
# GOOGLE_DRIVE_CLIENT_SECRET=...
# GOOGLE_DRIVE_REFRESH_TOKEN=...

# Server
PORT=3000
NODE_ENV=production

# Optional: proxy for scraping
# SCRAPING_PROXY_URL=
# SCRAPING_PROXY_API_KEY=
```

If you use a service account, upload `credentials.json` to the path you set in `GOOGLE_DRIVE_CREDENTIALS_PATH`.

---

## 5. Run with PM2 (keeps app running and restarts on reboot)

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the app (run from project root)
cd /var/www/listing-image-processor
pm2 start npm --name "listing-processor" -- start

# Save process list so it restarts after reboot
pm2 save
pm2 startup   # run the command it prints (usually with sudo)
```

Useful commands:

- `pm2 status` – see status  
- `pm2 logs listing-processor` – logs  
- `pm2 restart listing-processor` – restart after code/env changes  

---

## 6. Reverse proxy and SSL (Nginx)

So the app is reachable at `https://yourdomain.com` and runs on a private port (e.g. 3000):

```bash
sudo nano /etc/nginx/sites-available/listing-processor
```

Paste (replace `yourdomain.com` and adjust `PORT` if you changed it):

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/listing-processor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

**SSL with Let’s Encrypt:**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot will add HTTPS and redirect HTTP to HTTPS.

---

## 7. Frontend API URL (if you use a different domain/port)

The frontend calls the backend at the same origin by default. If you serve the app from a different domain or port, set when building:

```bash
cd frontend
VITE_API_URL=https://yourdomain.com npm run build
cd ..
```

Then rebuild and restart:

```bash
npm run build
pm2 restart listing-processor
```

---

## 8. Checklist

- [ ] VPS has Node 18+ and Chromium dependencies installed  
- [ ] Repo uploaded and `npm run install:all` + `npm run build` run from project root  
- [ ] `npx playwright install chromium --with-deps` run in `backend/`  
- [ ] `.env` in project root with `GEMINI_API_KEY`, Drive config, `PORT`, `NODE_ENV`  
- [ ] App runs with `pm2 start npm --name "listing-processor" -- start` and `pm2 save` + `pm2 startup`  
- [ ] Nginx proxies to `http://127.0.0.1:PORT` and SSL is set (e.g. certbot)  
- [ ] Domain A record points to the VPS IP  

---

## Troubleshooting

- **“Cannot find module”** – Run `npm run install:all` and `npm run build` from the **project root**.  
- **Playwright / browser errors** – Run `cd backend && npx playwright install chromium --with-deps`.  
- **Drive / Gemini errors** – Check `.env` and that paths (e.g. `GOOGLE_DRIVE_CREDENTIALS_PATH`) exist on the server.  
- **502 Bad Gateway** – Backend not running or wrong port. Check `pm2 status` and `PORT` in `.env` and Nginx `proxy_pass`.
