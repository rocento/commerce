"""Generate display-sized derivatives; keep approved artwork unchanged.

Run with Python and Pillow when the brand or default hero source changes.
The checked-in derivatives need no image tooling during deployment.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]


def derivative(source, destination, width, quality=85):
    with Image.open(ROOT / source) as image:
        size = (width, round(image.height * width / image.width))
        image = image.resize(size, Image.Resampling.LANCZOS)
        target = ROOT / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, 'WEBP', quality=quality, method=6)
        print(f'{destination}: {target.stat().st_size:,} bytes')


if __name__ == '__main__':
    for width in (320, 640):
        derivative('commerce-assets/brand/recento/rocento-logo.png',
                   f'commerce-web/packages/ui/src/brand/rocento-logo-{width}.webp', width)
    derivative('commerce-assets/brand/recento/recento-icon.png',
               'commerce-web/packages/ui/src/brand/rocento-icon-96.webp', 96)
    for width in (480, 800):
        derivative('commerce-web/apps/storefront/src/theme-default.webp',
                   f'commerce-web/apps/storefront/src/theme-default-{width}.webp', width, quality=75)
