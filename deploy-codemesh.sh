#!/bin/bash
# Deploy CodeMesh to VPS (codemesh.org)
# Usage: ./deploy-codemesh.sh [VPS_HOST]
# Example: ./deploy-codemesh.sh 72.61.151.199
#
# Prerequisites on VPS:
#   - Repo at DEST (default /var/www/codemesh), origin = GitHub, branch main
#   - Node + pm2; app name "codemesh" in pm2
#   - Production .env at ${DEST}/.env (NOT in git) — add Gemini keys there (see below)
#   - Nginx: merge deploy/nginx-codemesh.conf server_name into your site, then: nginx -t && systemctl reload nginx
#
# Gemini API keys (you edit on the VPS only):
#   File:  /var/www/codemesh/.env   (same directory as server.js if you cloned differently, use that path)
#   Add:
#     GEMINI_API_KEY=your_key_here
#     GEMINI_MODEL_FLASH=gemini-3-flash-preview
#     GEMINI_MODEL_PRO=gemini-3.1-pro-preview
#   Then: pm2 restart codemesh

set -e
VPS="${1:-72.61.151.199}"
REMOTE="root@${VPS}"
DEST="/var/www/codemesh"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Deploying CodeMesh to ${REMOTE}:${DEST}"
echo "Domain: https://codemesh.org/"
echo ""

ssh "${REMOTE}" "set -e; cd '${DEST}' && git pull origin main && npm install --production && pm2 restart codemesh && pm2 save && pm2 status codemesh"

echo ""
echo "Done. If Clash is new on this server, edit Gemini keys on the VPS:"
echo "  nano ${DEST}/.env"
echo "  # add GEMINI_API_KEY=...  (and optional GEMINI_MODEL_FLASH / GEMINI_MODEL_PRO)"
echo "  pm2 restart codemesh"
echo ""
echo "Optional: sync nginx snippet from repo (review before apply):"
echo "  scp ${REPO_ROOT}/deploy/nginx-codemesh.conf ${REMOTE}:/tmp/nginx-codemesh-snippet.conf"
echo "  # merge server_name / location into your real vhost, then: nginx -t && systemctl reload nginx"
