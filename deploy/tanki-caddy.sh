#!/bin/sh
# The LSH portal's auto-update regenerates /etc/caddy/Caddyfile; re-add the Tanki site if it is missing.
grep -q 'tankigeldi.lsh-portal.de' /etc/caddy/Caddyfile && exit 0
printf '\ntankigeldi.lsh-portal.de {\n    reverse_proxy localhost:8081\n}\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy
