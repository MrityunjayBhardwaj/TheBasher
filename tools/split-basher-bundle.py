#!/usr/bin/env python3
# Split a .basher scene bundle into pieces each under V8's longest string (0x1fffffe8 characters),
# for tests/e2e/perf-frame-attribution.spec.ts (PERF_ATTR_SCENE). A bundle past that length cannot
# be read into one string by the browser (`file.text()`, `response.text()`): the 595 MB alley file.
#
#   python3 tools/split-basher-bundle.py <scene.basher> <out-dir>
#
# Writes <out-dir>/bundle.json (the bundle without `assets`), <out-dir>/manifest.json
# ([bundle path, file, length] per asset) and <out-dir>/assets/<i>.txt (one asset's text each).
import json, sys, os
os.makedirs(os.path.join(sys.argv[2], 'assets'), exist_ok=True)
src, out = sys.argv[1], sys.argv[2]
b = json.load(open(src))
assets = b.pop('assets', {}) or {}
manifest = []
for i, (k, v) in enumerate(assets.items()):
    fn = f'{i}.txt'
    open(os.path.join(out, 'assets', fn), 'w').write(v)
    manifest.append([k, fn, len(v)])
json.dump(b, open(os.path.join(out, 'bundle.json'), 'w'))
json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'))
print('keys', list(b.keys()), 'nodes', len(b['state']['nodes']), 'assets', len(manifest), 'largest', max((m[2] for m in manifest), default=0), 'graph bytes', os.path.getsize(os.path.join(out,'bundle.json')))
