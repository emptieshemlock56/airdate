# AIRDATE — Server Setup Guide

## What You Need

A very modest server. This app is mostly a frontend that queries archive.org — the backend is just a caching proxy. Requirements:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| RAM | 512 MB | 1 GB |
| CPU | 1 vCPU | 1–2 vCPU |
| Disk | 5 GB | 10 GB |
| Bandwidth | 100 GB/mo | 500 GB/mo |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

**Cost estimate:** A $6/mo DigitalOcean Droplet or $5/mo Linode/Akamai instance is more than enough to start.

**Why so small?** The server is only proxying API metadata — the actual video streams come directly from archive.org's CDN to the viewer's browser. You're not hosting or transcoding any video.

---

## Recommended Providers (for a domain you already own)

1. **DigitalOcean** — Easiest UI, $6/mo basic droplet, good DNS management
2. **Linode / Akamai** — Slightly cheaper, very reliable
3. **Hetzner** — Cheapest in EU, excellent for a poc
4. **Fly.io** — Free tier available, deploys via CLI, great for testing

---

## Quick Setup (Ubuntu 22.04)

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version  # should be v20.x
```

### 2. Upload your files

From your local machine (or just clone your repo):

```bash
scp -r ./airdate/ user@your-server-ip:/var/www/airdate
```

Or if you're using git:

```bash
git clone https://github.com/you/airdate.git /var/www/airdate
```

### 3. Install dependencies

```bash
cd /var/www/airdate
npm install
```

### 4. Move the frontend into the public folder

```bash
mkdir -p public
cp index.html public/
```

### 5. Run it

```bash
node server.js
# Visit http://your-server-ip:3000
```

---

## Running in Production (with PM2 + Nginx)

### Install PM2 (process manager — keeps the server alive)

```bash
sudo npm install -g pm2
pm2 start server.js --name airdate
pm2 startup   # auto-restart on reboot
pm2 save
```

### Install Nginx (handles SSL + your domain)

```bash
sudo apt install nginx
```

Create `/etc/nginx/sites-available/airdate`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/airdate /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Add SSL (free, via Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

That's it — your site will be live at `https://yourdomain.com` with auto-renewing SSL.

---

## DNS Setup

In your domain registrar (wherever your domain lives):

| Type | Name | Value |
|------|------|-------|
| A | @ | your-server-ip |
| A | www | your-server-ip |

DNS propagation takes 5–30 minutes typically.

---

## Environment Variables

Create a `.env` file in the project root (optional):

```
PORT=3000
NODE_ENV=production
```

---

## API Endpoints Your Frontend Uses

| Endpoint | Description |
|----------|-------------|
| `GET /api/today` | News + commercials for today's M/D across all years |
| `GET /api/search?q=...&rows=12` | Proxied Archive.org search |
| `GET /api/item/:id` | Full metadata for one Archive item |

All results are cached in memory for 1 hour to avoid hammering archive.org.

---

## Folder Structure

```
airdate/
├── server.js          ← Node backend / proxy
├── package.json
├── .env               ← (optional)
└── public/
    └── index.html     ← Frontend (drop it here)
```

---

## Next Steps (when you're ready to scale)

- **Redis** instead of in-memory cache — survives restarts, shareable across instances
- **Nightly cron** — pre-fetch tomorrow's content at midnight so page loads are instant
- **Roku / TV app** — the same `/api/today` endpoint can power a Roku Direct Publisher feed (they accept JSON playlist format)
- **Custom collections** — build a curation layer so you can hand-pick the best Archive footage and override the auto-search
