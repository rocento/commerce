"""Isolated grocery-card UI fixture; never uses live customers, carts or wishlists."""
import runpy
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
base=runpy.run_path(str(Path(__file__).with_name('admin-workflow-preview.py')))
products=[dict(id=f'product-{i}',sku=f'GROCERY-{i}',slug=f'product-{i}',name=name,description='',price=price,currency='USD',unit='pack',category_id='category-0',attributes={},media_ids=['fixture-cover'],active=True,in_stock=i!=2,product_type='simple',parent_id=None,variant_attributes={},attribute_set_id=None,updated_at='2026-09-21T08:00:00Z') for i,(name,price) in enumerate([('Tahini Jar 350g','2.80'),('Baladi Ghee 500g','5.50'),('Premium Egyptian Pantry Selection','8.20'),('Fresh Pantry Essentials','4.90')])]
customer=dict(id='fixture-shopper',name='Sample shopper',email='shopper@example.test',verified=True,phone=None)
cart=dict(id='fixture-cart',items=[dict(product_id='product-0',quantity=2,reserved_quantity=2)],subtotal='5.60',total='5.60',currency='USD',discounts=[])
wishlist=[]
class Handler(base['Handler']):
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/v1/search': return self.reply(dict(hits=products,total=len(products),offset=0,limit=50,facets={}))
        if path=='/v1/customer/me': return self.reply(customer)
        if path=='/v1/customer/wishlist': return self.reply(wishlist)
        if path=='/v1/delivery-area': return self.reply(dict(configured=False,deliverable=True,area_id=None))
        if path.startswith('/v1/inventory/'): return self.reply(dict(available=0 if path.endswith('product-2') else 20,on_hand=20,reserved=2))
        return super().do_GET()
    def do_POST(self):
        if self.path=='/v1/customer/auth/refresh': return self.reply(dict(access_token='synthetic-test-token',customer=customer))
        if self.path=='/v1/cart': return self.reply(cart)
        if self.path=='/v1/cart/items':
            import json
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            cart['items'].append(dict(product_id=body['product_id'],quantity=body['quantity'],reserved_quantity=body['quantity']))
            return self.reply(cart)
        return super().do_POST()
    def do_PUT(self):
        if self.path.startswith('/v1/customer/wishlist/'):
            wishlist.append(self.path.rsplit('/',1)[1]); return self.reply(wishlist)
        if self.path.startswith('/v1/cart/items/'):
            import json
            body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            for item in cart['items']:
                if item['product_id']==self.path.rsplit('/',1)[1]: item.update(quantity=body['quantity'],reserved_quantity=body['quantity'])
            return self.reply(cart)
        return super().do_PUT()
    def do_DELETE(self):
        if self.path.startswith('/v1/customer/wishlist/'):
            wishlist.remove(self.path.rsplit('/',1)[1]); return self.reply(wishlist)
        if self.path.startswith('/v1/cart/items/'):
            cart['items'][:]=[item for item in cart['items'] if item['product_id']!=self.path.rsplit('/',1)[1]]
            return self.reply(cart)
        return super().do_DELETE()
if __name__=='__main__':
    print('Synthetic grocery cards: http://127.0.0.1:18090',flush=True)
    ThreadingHTTPServer(('127.0.0.1',18090),Handler).serve_forever()
