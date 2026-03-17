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
3. Create the folder and clone (replace with your repo URL if different):

```bash
mkdir -p /root/apartments-generator
cd /root/apartments-generator
git clone https://github.com/KhalilAZ1/apartments-generator.git .
```

Or use `/var/www/apartments-generator` if you prefer to keep web apps in `/var/www`. The project is now in that folder. Do **not** commit `.env` to Git; create it on the server (see below).

### Hostinger VPS – steps right after clone

Once the repo is cloned, do the following **on the VPS** in the project folder (e.g. `/root/apartments-generator`):

**1. Create `.env`** in the same folder as `docker-compose.yml`:

```bash
nano .env
```

Paste and edit (use either **Drive service account** or **OAuth**; for Docker, use `PORT=3001`):

```env
# Required
GEMINI_API_KEY=your_gemini_api_key
GOOGLE_DRIVE_ROOT_FOLDER_ID=your_drive_folder_id

# Drive – Option A: service account (path inside container; mount JSON via docker-compose volume)
# GOOGLE_DRIVE_CREDENTIALS_PATH=/app/backend/credentials/drive-service-account.json

# Drive – Option B: OAuth
GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
GOOGLE_DRIVE_REFRESH_TOKEN=your-refresh-token

# Docker app port (must match docker-compose ports)
PORT=3001
NODE_ENV=production

# Optional: proxy for scraping
# SCRAPING_PROXY_API_KEY=
# SCRAPING_PROXY_URL=
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

**2. (Optional) Service account:** If you use a **Google Drive service account** JSON file, put it in a folder on the VPS (e.g. `./credentials/drive-service-account.json`), then in `docker-compose.yml` uncomment the credentials volume:

```yaml
volumes:
  - ./credentials/drive-service-account.json:/app/backend/credentials/drive-service-account.json:ro
```

And in `.env` set:

```env
GOOGLE_DRIVE_CREDENTIALS_PATH=/app/backend/credentials/drive-service-account.json
```

(Leave the OAuth variables empty or commented.)

**3. Install Docker** (if not already installed, e.g. fresh VPS):

```bash
apt update && apt install -y docker.io docker-compose-v2
# or: snap install docker
```

**4. Build and run:**

```bash
cd /root/apartments-generator   # or your path
docker compose up -d --build
```

**5. Check:** The app listens on **port 3001**. Open `http://YOUR_VPS_IP:3001` in a browser, or in Hostinger Docker Manager use “Open” for the **apartments-generator** project. **6. HTTPS (Nginx + Let's Encrypt):** To serve the app at `https://yourdomain.com`:

- **Prerequisite:** Your domain's A record must point to the VPS IP.
- **Install Nginx and Certbot:** `apt update && apt install -y nginx certbot python3-certbot-nginx`
- **Create site config:** `nano /etc/nginx/sites-available/apartments-generator` and paste the server block below (replace `yourdomain.com`, port is **3001**):

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
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

- **Enable and reload:** `ln -s /etc/nginx/sites-available/apartments-generator /etc/nginx/sites-enabled/` then `nginx -t` and `systemctl reload nginx`
- **Get SSL:** `certbot --nginx -d yourdomain.com -d www.yourdomain.com` — then the app is at **https://yourdomain.com**

For more detail, see Option B, section 6.

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

## Notes

- These instructions assume Docker deployment, which is the recommended and supported way to run this app in production.
- If you prefer a bare‑metal Node/PM2 setup, you can derive the steps from the Docker configuration (`Dockerfile`, `docker-compose.yml`) and the `.env.example` file, but that path is no longer documented here to keep things simple.
