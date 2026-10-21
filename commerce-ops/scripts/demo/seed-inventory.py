"""Initialize stock for existing demo SKUs once; preserve all administrator adjustments."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from catalog_support import Client
client=Client()
quantities={
    'DEMO-BRD-001':40,
    'DEMO-RCE-001':35,
    'DEMO-FUL-001':28,
    'DEMO-MOL-001':24,
    'DEMO-ROM-001':18,
    'DEMO-DAT-001':20,
    'DEMO-TAH-001':22,
    'DEMO-GHE-001':16,
    'DEMO-KRK-001':26,
    'DEMO-CUC-001':30,
    'DEMO-TOM-001':32,
    'DEMO-LEM-001':25,
    'DEMO-MNT-001':30,
    'DEMO-SGR-001':40,
    'DEMO-LEN-001':30,
    'DEMO-SOP-001':18,
    'DEMO-BAN-001':20,
    'DEMO-APL-001':12,
    'DEMO-MLK-001':0,
}
offset=0
while True:
    rows=client.call('GET',f'/v1/admin/inventory?offset={offset}')
    for row in rows:
        if row['sku'] not in quantities:
            continue
        detail=client.call('GET','/v1/admin/inventory/'+row['product_id'])
        if detail['adjustments']:
            print('Kept existing stock for '+row['name'])
            continue
        client.call('PUT','/v1/admin/inventory/'+row['product_id'],{'on_hand':quantities[row['sku']],'reason':'Initial M3 demo stock'})
        print('Initialized stock for '+row['name'])
    if len(rows)<50:
        break
    offset+=50
client.call('POST','/v1/admin/auth/logout')
