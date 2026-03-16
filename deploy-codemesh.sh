#!/bin/bash
# Deploy CodeMesh to VPS (codemesh.org)
# Usage: ./deploy-codemesh.sh [VPS_HOST]
# Example: ./deploy-codemesh.sh
#          ./deploy-codemesh.sh 72.61.151.199

set -e
VPS="${1:-72.61.151.199}"
REMOTE="root@${VPS}"
DEST="/var/www/codemesh"

echo "Deploying CodeMesh to ${REMOTE}:${DEST}"
echo "Domain: https://codemesh.org/"
echo ""

ssh "${REMOTE}" "cd ${DEST} && git pull && npm install --production && pm2 restart codemesh && pm2 status codemesh"

echo ""
echo "Done. CodeMesh deployed at https://codemesh.org/"
