#!/bin/sh
# Pull new commits from GitHub and restart Tanki; run every 5 minutes by tankigeldi-update.timer.
set -e
cd "${TANKI_DIR:-/root/tankigeldi}"
git fetch -q origin main
old=$(git rev-parse HEAD)
[ "$old" = "$(git rev-parse origin/main)" ] && exit 0
git merge -q --ff-only origin/main
if git diff --name-only "$old" HEAD | grep -qE '^package(-lock)?\.json$'; then
  npm ci --omit=dev --no-audit --no-fund
fi
install -m 755 deploy/update.sh /usr/local/bin/tankigeldi-update
install -m 755 deploy/tanki-caddy.sh /usr/local/bin/tanki-caddy
systemctl restart tankigeldi
echo "Tanki aktualisiert: $(git rev-parse --short "$old") -> $(git rev-parse --short HEAD)"
