"""Synchronize approved Rocento artwork across demos, App Studio, and rengine."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from base64 import b64encode
from pathlib import Path
from shutil import copy2

root = Path(__file__).resolve().parents[3]
source = root / 'commerce-assets/brand/recento'
public_dirs = [root / 'commerce-web/apps' / app / 'public'
               for app in ('admin', 'storefront')]
public_dirs.extend((root / 'commerce-corporate-site/public',
                    root / 'commerce-web/apps/mobile-studio/public'))
rengine_public = root / 'commerce-web/apps/rengine/public'
public_dirs.append(rengine_public)
# Preserve legacy SVG URLs using the approved raster artwork, not a redrawn mark.
icon = b64encode((source / 'icon-192.png').read_bytes()).decode('ascii')
svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">'
       f'<image width="192" height="192" href="data:image/png;base64,{icon}"/></svg>\n')
for public in public_dirs:
    destination = public / 'brand'
    destination.mkdir(parents=True, exist_ok=True)
    # rengine serves an explicit asset allowlist instead of the full brand folder.
    assets = [source / 'rocento-logo.png'] if public == rengine_public else source.iterdir()
    for asset in assets:
        if asset.suffix in ('.png', '.ico') and asset.name != 'approved-original.png':
            # Old public wordmark URLs must also resolve to the corrected artwork.
            approved = source / 'rocento-logo.png' if asset.name == 'recento-logo.png' else asset
            copy2(approved, destination / asset.name)
    copy2(source / 'favicon.ico', public / 'favicon.ico')
    (public / 'favicon.svg').write_text(svg)
copy2(root / 'commerce-web/packages/ui/src/brand/rocento-icon-96.webp',
      root / 'commerce-web/apps/rengine/public/brand/rocento-icon-96.webp')
print('Rocento artwork synchronized to all four frontend apps and rengine.')
