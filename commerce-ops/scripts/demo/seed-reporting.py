"""Deterministic local M8 demo: 10k products/customers and 12k orders, isolated by m8-demo IDs.
Only targets this repository's local Compose databases. No external messages, payments or indexing.
Products are inactive and customer password hashes are unusable. Re-running does not overwrite rows.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import datetime as dt
import json
import uuid
from m8_db import pg,ch
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply-local',action='store_true',required=True)
parser.parse_args()
sql="""
BEGIN;
CREATE TEMP TABLE m8_ids AS SELECT g,md5('m8-demo:product:'||g)::uuid product,md5('m8-demo:customer:'||g)::uuid customer,md5('m8-demo:order:'||g)::uuid order_id,md5('m8-demo:location:'||g)::uuid location,md5('m8-demo:cart:'||g)::uuid cart,(50+(g*37)%2450)::numeric/100 price,1+g%5 quantity FROM generate_series(1,10000) g;
INSERT INTO catalog.categories(id,name,slug) SELECT md5('m8-demo:category:'||g)::uuid,(ARRAY['Produce','Dairy','Meat','Bakery','Pantry','Frozen','Beverages','Snacks','Household','Personal care','Baby','Pet'])[1+(g-1)%12]||' demo '||g,'m8-demo-category-'||g FROM generate_series(1,60) g ON CONFLICT DO NOTHING;
INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id,active,in_stock) SELECT product,'M8-DEMO-'||lpad(g::text,5,'0'),'m8-demo-product-'||g,(ARRAY['Apples','Milk','Chicken','Bread','Rice','Peas','Juice','Crackers','Soap','Shampoo','Wipes','Pet food'])[1+(g-1)%12]||' · demo pack '||g,'Synthetic M8 reporting fixture',price,'USD','pack',md5('m8-demo:category:'||(1+(g-1)%60))::uuid,false,true FROM m8_ids ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock(product_id,on_hand) SELECT product,20+g%300 FROM m8_ids ON CONFLICT DO NOTHING;
INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified,created_at) SELECT customer,'m8-demo-'||g||'@example.test','email','!M8-NO-LOGIN',true,current_date-interval '240 days' FROM m8_ids ON CONFLICT DO NOTHING;
INSERT INTO customers.customer_locations(id,customer_id,label,latitude,longitude,formatted_address,is_default) SELECT location,customer,'home',30.0444,31.2357,'Synthetic M8 demo address',true FROM m8_ids ON CONFLICT DO NOTHING;
INSERT INTO cart_checkout.carts(id,customer_id) SELECT cart,customer FROM m8_ids ON CONFLICT DO NOTHING;
CREATE TEMP TABLE m8_orders AS SELECT g,product,customer,location,cart,order_id,price,quantity,(current_date-45-(g%150))::timestamptz+interval '12 hours' created FROM m8_ids UNION ALL SELECT g,product,customer,location,cart,md5('m8-demo:repeat:'||g)::uuid,price,quantity,(current_date-15-(g%150))::timestamptz+interval '12 hours' FROM m8_ids WHERE g%5=0;
INSERT INTO cart_checkout.quotes(id,customer_id,cart_id,location_id,snapshot,expires_at,created_at) SELECT md5('m8-demo:quote:'||order_id)::uuid,customer,cart,location,'{}',created+interval '15 minutes',created FROM m8_orders ON CONFLICT DO NOTHING;
INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,subtotal,delivery_fee,total,currency,created_at,updated_at) SELECT order_id,customer,md5('m8-demo:quote:'||order_id)::uuid,order_id,CASE WHEN g%20=0 THEN 'cancelled' WHEN g%50=0 THEN 'delivery_failed' ELSE 'cash_collected' END,jsonb_build_object('formatted_address','Synthetic M8 demo address'),jsonb_build_object('email','m8-demo-'||g||'@example.test','primary_identifier','email'),price*quantity,3,price*quantity+3,'USD',created,created FROM m8_orders ON CONFLICT DO NOTHING;
INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total) SELECT o.order_id,p.id,p.sku,p.name,p.unit,o.quantity,o.price,o.price*o.quantity FROM m8_orders o JOIN catalog.products p ON p.id=o.product ON CONFLICT DO NOTHING;
INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency,collected_at,collected_by) SELECT o.id,'cod',o.total,o.currency,CASE WHEN o.status='cash_collected' THEN o.created_at END,CASE WHEN o.status='cash_collected' THEN md5('m8-demo:operator')::uuid END FROM orders.orders o JOIN m8_orders m ON m.order_id=o.id ON CONFLICT DO NOTHING;
INSERT INTO payments.manual_refunds(id,order_id,amount,reason,actor_id,created_at) SELECT md5('m8-demo:refund:'||o.id)::uuid,o.id,o.total,'Synthetic M8 demo full refund',md5('m8-demo:operator')::uuid,o.created_at+interval '1 day' FROM orders.orders o JOIN m8_orders m ON m.order_id=o.id WHERE m.g%37=0 AND o.status='cash_collected' ON CONFLICT DO NOTHING;
INSERT INTO orders.order_status_history(id,order_id,status,reason,created_at) SELECT md5('m8-demo:history:'||o.id)::uuid,o.id,o.status,'Synthetic M8 demo fixture',o.created_at FROM orders.orders o JOIN m8_orders m ON m.order_id=o.id ON CONFLICT DO NOTHING;
COMMIT;
SELECT json_build_object('products',(SELECT count(*) FROM catalog.products WHERE sku LIKE 'M8-DEMO-%'),'customers',(SELECT count(*) FROM customers.customers WHERE email LIKE 'm8-demo-%@example.test'),'orders',(SELECT count(*) FROM orders.orders WHERE contact->>'email' LIKE 'm8-demo-%@example.test'));
"""
print(pg(sql).splitlines()[-1])
rows=[]
namespace=uuid.UUID('957fe19e-4dfd-41ad-9635-14399741388f')
today=dt.datetime.now(dt.timezone.utc).date()
for i in range(10000):
    session=str(uuid.uuid5(namespace,f'session:{i}'))
    stamp=dt.datetime.combine(today-dt.timedelta(days=1+i%60),dt.time(12),dt.timezone.utc)
    kinds=['page_view']+(['cart_added'] if i%2==0 else [])+(['checkout_started'] if i%4==0 else [])+(['order_placed'] if i%8==0 else [])
    for step,kind in enumerate(kinds):
        rows.append(json.dumps({'id':str(uuid.uuid5(namespace,f'event:{i}:{kind}')),'session_id':session,'event_type':kind,'path':{'page_view':'/','cart_added':'/cart','checkout_started':'/checkout','order_placed':'/checkout/complete'}[kind],'source':['direct','search','social','email','referral'][i%5],'occurred_at':(stamp+dt.timedelta(seconds=step)).isoformat()}))
for start in range(0,len(rows),1000):
    ch("INSERT INTO browser_events SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow",'\n'.join(rows[start:start+1000]))
print(json.dumps({'browser_events':len(rows),'daily_sessions':10000,'expected_funnel':{'visitors':10000,'carts':5000,'checkouts':2500,'purchases':1250}}))
