"""Build the bundled delivery directory from an unmodified GeoNames EG.zip export.

Usage: python3 scripts/import-egypt-locations.py /path/to/EG.zip
Download: https://download.geonames.org/export/dump/EG.zip
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[3]
# Friendly display names for the GeoNames ADM1 codes, checked against:
# https://www.geonames.org/EG/administrative-division-egypt.html
NAMES = {
    '01': ('Dakahlia', 'الدقهلية'), '02': ('Red Sea', 'البحر الأحمر'),
    '03': ('Beheira', 'البحيرة'), '04': ('Fayoum', 'الفيوم'),
    '05': ('Gharbia', 'الغربية'), '06': ('Alexandria', 'الإسكندرية'),
    '07': ('Ismailia', 'الإسماعيلية'), '08': ('Giza', 'الجيزة'),
    '09': ('Monufia', 'المنوفية'), '10': ('Minya', 'المنيا'),
    '11': ('Cairo', 'القاهرة'), '12': ('Qalyubia', 'القليوبية'),
    '13': ('New Valley', 'الوادي الجديد'), '14': ('Sharqia', 'الشرقية'),
    '15': ('Suez', 'السويس'), '16': ('Aswan', 'أسوان'),
    '17': ('Assiut', 'أسيوط'), '18': ('Beni Suef', 'بني سويف'),
    '19': ('Port Said', 'بورسعيد'), '20': ('Damietta', 'دمياط'),
    '21': ('Kafr El Sheikh', 'كفر الشيخ'), '22': ('Matrouh', 'مطروح'),
    '23': ('Qena', 'قنا'), '24': ('Sohag', 'سوهاج'),
    '26': ('South Sinai', 'جنوب سيناء'), '27': ('North Sinai', 'شمال سيناء'),
    '28': ('Luxor', 'الأقصر'),
}
# Current populated places and city neighborhoods; exclude abandoned,
# historical, destroyed, farm-only and aggregate-place records.
FEATURES = {'PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLX', 'PPLL'}


def build(archive, output):
    raw = archive.read_bytes()
    with zipfile.ZipFile(archive) as source:
        rows = [line.split('\t') for line in source.read('EG.txt').decode('utf-8').splitlines()]
    governors = {r[10]: r for r in rows if r[8] == 'EG' and r[7] == 'ADM1'}
    assert set(governors) == set(NAMES), 'Governorate codes changed; review before importing.'
    output.mkdir(parents=True, exist_ok=True)
    states, total, excluded = [], 0, 0
    for code, (name, arabic) in sorted(NAMES.items(), key=lambda item: item[1][0]):
        places = []
        for r in rows:
            if r[8] != 'EG' or r[7] not in FEATURES or r[10] != code:
                continue
            lat, lon = float(r[4]), float(r[5])
            assert 21 <= lat <= 32 and 24 <= lon <= 37
            places.append(dict(id=r[0], name=r[2] or r[1], aliases=r[3].split(',') if r[3] else [],
                               latitude=lat, longitude=lon, population=int(r[14] or 0)))
        assert places, f'No populated places for {name}'
        assert len({p['id'] for p in places}) == len(places)
        places.sort(key=lambda p: (-p['population'], p['name'].casefold(), p['id']))
        states.append(dict(code=code, name=name, name_ar=arabic, city_count=len(places)))
        total += len(places)
        (output / f'{code}.json').write_text(json.dumps(places, ensure_ascii=False, separators=(',', ':')) + '\n')
    excluded = sum(r[8] == 'EG' and r[7] in FEATURES and r[10] not in NAMES for r in rows)
    manifest = dict(country=dict(code='EG', name='Egypt', name_ar='مصر'), states=states,
                    source='https://download.geonames.org/export/dump/EG.zip',
                    attribution='GeoNames', license='https://creativecommons.org/licenses/by/4.0/',
                    source_sha256=hashlib.sha256(raw).hexdigest(),
                    source_latest_record_date=max(r[18] for r in rows),
                    feature_codes=sorted(FEATURES), city_count=total,
                    excluded_without_valid_governorate=excluded)
    (output / 'index.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Built {len(states)} governorates and {total} cities, towns, villages and neighborhoods; excluded {excluded} unassigned places.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'commerce-web/apps/storefront/public/data/delivery/eg')
    args = parser.parse_args()
    build(args.archive, args.output)
