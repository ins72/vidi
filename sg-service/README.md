# sg-service (legacy)

Patched copy of the service running on port 3999 (`/sg/...`). It is superseded by
`tools/streamgrabber-bridge.js` (port 7789, `/streamgrabber/...`), which signs proxy URLs and
limits concurrency. The Stremio Web client no longer calls this service, so once nothing else uses
`/sg/` or `/vidfind`, retire it: stop the unit and remove the `/sg` and `/vidfind` nginx locations.

Fixes in this copy: malformed `%` in `/resolve/` returns 400 instead of throwing, listens on
127.0.0.1 (`SG_HOST` to override), playlist rewriter no longer emits a second `?` and now
rewrites `URI="..."` attributes, private/loopback upstream hosts are refused.
Not fixed here (another reason to retire it): `/proxy/stream` is still an unsigned proxy for any public URL.
