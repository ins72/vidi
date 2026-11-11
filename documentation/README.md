# Streamgrabber setup

Project root: /home/ubuntu/server/stremio-web-with-streamgrabber

## Components
- Web app: Stremio Web fork, built with pnpm, served from /home/ubuntu/mewayz-stremio-frontend/dist by serve.cjs on port 9112.
- Bridge: tools/streamgrabber-bridge.js (Node 20, no deps), service stremio-web-streamgrabber-bridge, port 7789.
- nginx: deploy/nginx/streamgrabber-locations.conf included in server.mewayz.com server block.
- CLI: streamgrabber (binary at /home/ubuntu/.local/bin/streamgrabber).

## Key files
- src/routes/Player/Player.js, src/routes/Player/streamGrabber.js
- tools/streamgrabber-bridge.js, tools/apply-fresh-grab.py, tools/measure-token-lifetime.sh
- deploy/nginx/streamgrabber-locations.conf
- /etc/streamgrabber-bridge.env (root-only)

## Services
- stremio-web-streamgrabber-bridge (real). Restart: sudo systemctl restart stremio-web-streamgrabber-bridge
- streamgrabber-bridge.service is masked/old; never start.
- Frontend: node /home/ubuntu/mewayz-stremio-frontend/serve.cjs (port 9112).

## Env
- BRIDGE_SECRET, PUBLIC_BASE, ALLOW_ORIGIN, NODE_ENV, PORT, PROXY_PUBLIC_PATH, CACHE_MS, SIGNATURE_TTL_MS.

## Tests
- node tools/test/bridge-selftest.js
- sudo nginx -t

## Deploy
- pnpm build, copy build/ to /home/ubuntu/mewayz-stremio-frontend/dist, restart serve.cjs.
