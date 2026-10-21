"""Build reviewed, reproducible country directories from original GeoNames exports.

Usage: python3 scripts/import-delivery-locations.py SA /path/to/SA.zip
Country ADM1 codes are GeoNames codes (not universally ISO subdivision codes).
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import hashlib
import io
import json
import math
import re
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COUNTRIES = {
    'SA': ('Saudi Arabia', 'المملكة العربية السعودية', 'Region', 13),
    'KW': ('Kuwait', 'الكويت', 'Governorate', 6),
    'US': ('United States', 'الولايات المتحدة', 'State / District', 51),
    'NL': ('Netherlands', 'هولندا', 'Province', 12),
    'GB': ('United Kingdom', 'المملكة المتحدة', 'Constituent country', 4),
}
FEATURES = {'PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLX', 'PPLL'}


def build(country, archive, output):
    name, arabic, label, expected_states = COUNTRIES[country]
    states, places, seen = {}, [], set()
    districts = {}
    excluded = Counter()
    latest = ''
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    with zipfile.ZipFile(archive) as source:
        info = source.getinfo(f'{country}.txt')
        if info.file_size > 2_000_000_000:
            raise ValueError('Country export exceeds the importer size limit')
        for line in io.TextIOWrapper(source.open(info), encoding='utf-8'):
            row = line.rstrip('\n').split('\t')
            if len(row) != 19:
                raise ValueError('Invalid GeoNames row; expected 19 fields')
            if row[8] != country:
                excluded['different_country'] += 1
                continue
            latest = max(latest, row[18])
            if row[7] == 'ADM2' and row[10] and row[11]:
                districts[(row[10], row[11])] = row[2] or row[1]
            if row[7] == 'ADM1':
                code = row[10]
                if not re.fullmatch(r'[A-Z0-9]{1,12}', code) or code in states:
                    raise ValueError(f'Invalid or duplicate ADM1 code: {code}')
                local = next((v for v in [row[1], *row[3].split(',')] if re.search(r'[\u0600-\u06ff]', v)), '') if country in {'SA', 'KW'} else ''
                states[code] = dict(code=code, name=row[2] or row[1], name_ar=local, geonames_id=row[0])
            if row[7] not in FEATURES:
                continue
            if not row[0].isdigit() or row[0] in seen:
                raise ValueError('Invalid or duplicate place ID')
            seen.add(row[0])
            lat, lon = float(row[4]), float(row[5])
            if not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                raise ValueError(f'Invalid coordinates for {row[0]}')
            place_name = row[2] or row[1]
            if not place_name or len(place_name.encode()) > 200:
                raise ValueError(f'Invalid place name for {row[0]}')
            places.append((row[10], row[11], dict(id=row[0], name=place_name,
                aliases=sorted(set(filter(None, [row[1], *row[3].split(',')])) - {place_name}),
                latitude=lat, longitude=lon, population=max(0, int(row[14] or 0)))))
    if len(states) != expected_states:
        raise ValueError(f'{country}: expected {expected_states} ADM1 divisions, got {len(states)}; review the source')
    grouped = {code: [] for code in states}
    for code, district_code, place in places:
        if district := districts.get((code, district_code)):
            place["district"] = district
        if code not in grouped:
            excluded['unassigned_adm1'] += 1
        else:
            grouped[code].append(place)
    # Validate the complete export before publishing any of its files.
    payloads = {}
    for code, state in states.items():
        records = sorted(grouped[code], key=lambda p: (-p['population'], p['name'].casefold(), int(p['id'])))
        if not records:
            raise ValueError(f'{country}.{code} has no populated places')
        payload = json.dumps(records, ensure_ascii=False, separators=(',', ':')) + '\n'
        payloads[f'{code}.json'] = payload
        state.update(city_count=len(records), sha256=hashlib.sha256(payload.encode()).hexdigest())
    manifest = dict(schema_version=1, country=dict(code=country, name=name, name_ar=arabic),
        state_label=label, states=sorted(states.values(), key=lambda state: state['name']),
        source=f'https://download.geonames.org/export/dump/{country}.zip',
        attribution='GeoNames', license='https://creativecommons.org/licenses/by/4.0/',
        source_sha256=digest, source_latest_record_date=latest, feature_codes=sorted(FEATURES),
        city_count=sum(len(v) for v in grouped.values()), excluded=dict(sorted(excluded.items())))
    payloads['index.json'] = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    output.mkdir(parents=True, exist_ok=True)
    for filename, payload in payloads.items():
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output, delete=False) as target:
            target.write(payload)
        Path(target.name).replace(output / filename)
    print(f'{country}: {len(states)} divisions, {manifest["city_count"]} populated places, exclusions={dict(excluded)}', flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('country', choices=COUNTRIES)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    build(args.country, args.archive, args.output or ROOT / 'commerce-web/apps/storefront/public/data/delivery' / args.country.lower())
