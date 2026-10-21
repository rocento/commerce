
# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import subprocess,time,uuid,json
from pathlib import Path
name='m10-migration-'+uuid.uuid4().hex[:8]
def sql(body):
 p=subprocess.run(['docker','exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-At'],input=body,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr)
 return p.stdout
try:
 subprocess.run(['docker','run','-d','--name',name,'-e','POSTGRES_PASSWORD=m10-isolated-only','pgvector/pgvector:pg16'],check=True,capture_output=True)
 for _ in range(60):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],capture_output=True).returncode==0:break
  time.sleep(.5)
 migration=Path('commerce-api/rocento-api/migrations/20260922150000_market_commerce.sql')
 for p in sorted(Path('commerce-api/rocento-api/migrations').glob('*.sql')):
  if p!=migration:sql(p.read_text())
 sql("INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency) VALUES('00000000-0000-0000-0000-000000000010',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'placed','{}','{}',10.01,3,13.01,'USD'); INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) VALUES('00000000-0000-0000-0000-000000000010',gen_random_uuid(),'LEGACY','Legacy pack','pack',1,10.01,10.01);")
 before=sql('SELECT md5(string_agg(to_jsonb(o)::text,\'\')) FROM orders.orders o;')
 sql(migration.read_text());assert sql('SELECT md5(string_agg(to_jsonb(o)::text,\'\')) FROM orders.orders o;')==before
 assert sql('SELECT market_facts IS NULL FROM orders.order_items;').strip()=='t'
 assert sql("SELECT NOT enabled AND currency='USD' FROM cart_checkout.market_configuration;").strip()=='t'
 print(json.dumps({'legacy_order_unchanged':True,'legacy_item_explicitly_incomplete':True,'default_off_usd':True,'baseline_migrations':len(list(Path('commerce-api/rocento-api/migrations').glob('*.sql')))-1}))
finally:subprocess.run(['docker','rm','-f',name],capture_output=True)
