#!/bin/bash
# Deploy portfolio-v1 to VPS at /var/www/app/portfolio-v1
# Usage: ./deploy-portfolio-v1.sh <VPS_HOST_OR_IP>
# Example: ./deploy-portfolio-v1.sh srv1385617.hostinger.com
#          ./deploy-portfolio-v1.sh 123.45.67.89

set -e
if [ -z "$1" ]; then
  echo "Usage: $0 <VPS_HOST_OR_IP>"
  echo "Example: $0 srv1385617.hostinger.com"
  exit 1
fi
VPS="$1"
REMOTE="root@${VPS}"
SRC="/home/barramee27/codemesh/portfolio-v1"
DEST="/var/www/app/portfolio-v1"

echo "Syncing portfolio-v1 to ${REMOTE}:${DEST}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .next \
  --exclude .git \
  "${SRC}/" "${REMOTE}:${DEST}/"

echo "Installing deps, building, and starting PM2 on VPS..."
ssh "${REMOTE}" "cd ${DEST} && pnpm install --omit=dev=false && pnpm run build && pnpm install --omit=dev=false && pm2 delete portfolio-v1 2>/dev/null || true && pm2 start pnpm --name portfolio-v1 -- start && pm2 save"

echo "Done. portfolio-v1 is running on PM2."
