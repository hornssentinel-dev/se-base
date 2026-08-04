#!/bin/bash
# Push local app code to the EC2 instance and restart the service.
# Usage: scripts/deploy.sh <elastic-ip-or-hostname>
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <elastic-ip-or-hostname>" >&2
  exit 1
fi

HOST="$1"
REMOTE_DIR="/opt/se-tracker"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  "$SCRIPT_DIR"/ "ec2-user@${HOST}:${REMOTE_DIR}/"

ssh "ec2-user@${HOST}" "cd ${REMOTE_DIR} && npm install --omit=dev && sudo systemctl restart se-tracker"

echo "Deployed. Tail logs with: ssh ec2-user@${HOST} 'sudo journalctl -u se-tracker -f'"
