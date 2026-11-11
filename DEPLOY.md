# Streamgrabber deploy notes

Layout: browser -> nginx `/streamgrabber/*` -> bridge on 127.0.0.1:7789 -> `streamgrabber` CLI / CDN.

## 1. One service per port
The old `streamgrabber-bridge.service` (runs `streamgrabber-server.js`) and
`stremio-web-streamgrabber-bridge.service` both want port 7789, which is why the log shows
`EADDRINUSE` and 40+ restarts. Keep only the second:

    sudo systemctl disable --now streamgrabber-bridge.service

## 2. Install the bridge unit
    sudo cp deploy/systemd/stremio-web-streamgrabber-bridge.service /etc/systemd/system/
    sudo cp deploy/systemd/streamgrabber-bridge.env.example /etc/streamgrabber-bridge.env
    sudo chmod 600 /etc/streamgrabber-bridge.env
    # edit it: set BRIDGE_SECRET (openssl rand -hex 32), PUBLIC_BASE, ALLOW_ORIGIN
    sudo systemctl daemon-reload
    sudo systemctl enable --now stremio-web-streamgrabber-bridge
    curl -s http://127.0.0.1:7789/health

In production (`NODE_ENV=production`) the bridge refuses to start without `BRIDGE_SECRET`.
Changing the secret invalidates previously issued stream URLs (they expire after 6h anyway).

## 3. nginx
    sudo cp deploy/nginx/00-streamgrabber-zones.conf /etc/nginx/conf.d/
    # in the server block for server.mewayz.com, replace the old `location /streamgrabber/ {...}`
    # with:  include /path/to/deploy/nginx/streamgrabber-locations.conf;
    sudo nginx -t && sudo systemctl reload nginx

Rate limits are keyed on `CF-Connecting-IP` (falls back to `$remote_addr`), because behind Cloudflare
`$remote_addr` is an edge IP shared by many visitors. If you set up `ngx_http_realip_module` instead, point the
map in `00-streamgrabber-zones.conf` at `$remote_addr`.

Not tested against a real nginx in my sandbox - run `nginx -t` and try one playback with seeking.

## 4. Build the web app
    pnpm i --frozen-lockfile && pnpm build

Client switches are at the top of `src/routes/Player/streamGrabber.js`:
`STRICT_STREAMGRABBER` (error instead of addon fallback) and `STREAMGRABBER_BASE`
(absolute bridge origin, needed for native/WebView wrappers).

## 5. Retire sg-service (port 3999, /sg and /vidfind)
The client no longer uses it. Once nothing else does, stop it and delete the two nginx locations.
`sg-service/server.js` is a patched copy if you need to keep it a while.

## Tests
    node tools/test/bridge-selftest.js     # bridge, 16 checks, no dependencies
    pnpm test                              # repo tests + tests/streamGrabber.spec.js
