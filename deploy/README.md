# CodeMesh Deployment (Hostinger VPS)

## Prerequisites

- Ubuntu 22.04 LTS
- SSH access: `ssh root@72.61.151.199`
- Domain: codemesh.org (A record → VPS IP)

## Deploy Steps

### 1. On VPS: Install Node.js 18+, Nginx, PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs nginx
npm i -g pm2
```

### 2. Clone and Install

```bash
cd /var/www
git clone https://github.com/barramee27/codemesh.git
cd codemesh
npm install --production
```

### 3. Create .env (in project root)

```bash
cp .env.example .env
# Edit .env with your values:
# MONGODB_URI, JWT_SECRET, RESEND_API_KEY, ADMIN_EMAILS
```

### 4. Add Nginx Site (do NOT edit existing sites)

```bash
cp /var/www/codemesh/deploy/nginx-codemesh.conf /etc/nginx/sites-available/codemesh
ln -s /etc/nginx/sites-available/codemesh /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 5. SSL with Certbot

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d codemesh.org -d www.codemesh.org
```

### 6. Start App with PM2

```bash
cd /var/www/codemesh
pm2 start server.js --name codemesh
pm2 save
pm2 startup
```

### 7. Resend Domain Verification

In Resend dashboard: add codemesh.org, add DNS records (SPF, DKIM), verify.

## Updates

From your machine (after pushing to GitHub):

```bash
./deploy-codemesh.sh
# or: ./deploy-codemesh.sh 72.61.151.199
```

Or manually on VPS:

```bash
cd /var/www/codemesh
git pull
npm install --production
pm2 restart codemesh
```

## Admin File Uploader

Uploads are stored in `uploads/` (created automatically). Ensure the app has write permission. Files are served at `https://codemesh.org/uploads/<filename>`.
