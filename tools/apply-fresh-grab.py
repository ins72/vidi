#!/usr/bin/env python3
"""Patch tools/streamgrabber-bridge.js in place:
  1. /grab?fresh=1 skips the in-memory CLI result (used by the client's one-shot retry)
  2. cap the url->grab-key eviction map at 2000 entries
Idempotent, checks every anchor, writes a .bak first. Usage: python3 tools/apply-fresh-grab.py [path]"""
import sys, shutil, time
p = sys.argv[1] if len(sys.argv) > 1 else 'tools/streamgrabber-bridge.js'
s = open(p).read()
if 'fresh = false' in s:
    print('already patched'); sys.exit(0)
edits = [
 ("const grab = ({ imdb, type, season, episode }) => {\n    const key = [imdb, type, season, episode].join('|');\n    const hit = cache.get(key);\n    if (hit && Date.now() - hit.at < cfg.cacheMs) return Promise.resolve(hit.data);",
  "// fresh=true skips the in-memory result (the client retries with it after a playback failure).\nconst grab = ({ imdb, type, season, episode, fresh = false }) => {\n    const key = [imdb, type, season, episode].join('|');\n    const hit = cache.get(key);\n    if (!fresh && hit && Date.now() - hit.at < cfg.cacheMs) return Promise.resolve(hit.data);"),
 ("        const data = await grab({ imdb, type, season, episode });",
  "        const data = await grab({ imdb, type, season, episode, fresh: url.searchParams.get('fresh') === '1' });"),
]
optional = [  # only present if the eviction map exists (it does on the current server file)
 ("        for (const u of urls) urlToGrabKey.set(u, key);\n",
  "        for (const u of urls) urlToGrabKey.set(u, key);\n        while (urlToGrabKey.size > 2000) urlToGrabKey.delete(urlToGrabKey.keys().next().value);\n"),
]
for old, new in edits:
    if s.count(old) != 1: sys.exit('ANCHOR NOT FOUND (file differs from expected), nothing written:\n' + old[:80])
    s = s.replace(old, new)
for old, new in optional:
    if s.count(old) == 1: s = s.replace(old, new)
shutil.copy(p, f'{p}.bak.{int(time.time())}')
open(p, 'w').write(s)
print('patched', p)
