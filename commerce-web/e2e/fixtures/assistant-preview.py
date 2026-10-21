"""Opt-in, loopback-only synthetic M06/M07 browser fixture; never connects to commerce.
Run: python3 commerce-web/e2e/fixtures/assistant-preview.py
Start the existing storefront with API_PROXY_TARGET=http://127.0.0.1:18086.
Use 'slow' to stop a response and 'retry' to exercise a recoverable outage.
"""
from datetime import datetime, timezone
from urllib.parse import urlparse,parse_qs
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

ID = str(UUID(int=6))
CUSTOMER = {"id": ID, "email": "m06@example.test", "mobile_number": None, "verified": True, "created_at": "2026-09-15T12:00:00Z"}
HISTORY = [{"conversation_id": ID, "request_id": str(UUID(int=7)), "question": "Saved shopping question", "answer": "## Saved answer\n\n- **Catalog facts** stay grounded.\n- [Browse products](/search)", "created_at": "2026-09-15T12:00:00Z"}]
ATTEMPTS = {}
PRODUCTS = [
    {"id": str(UUID(int=n)), "name": name, "image_id": str(UUID(int=99)) if n == 6 else None, "price": price, "currency": "USD", "in_stock": stock, "route": f"/products/{UUID(int=n)}", "attributes": attrs, "reasons": [f"Current catalog price: {price} USD"], "unmet": []}
    for n, name, price, stock, attrs in [
        (6, "Running shoes", "99", True, [{"name":"color","value":"black"},{"name":"size","value":"42"}]),
        (8, "Trail shoes", "109", None, [{"name":"color","value":"green"}]),
    ]
]
CART = {"items": [
    {"product_id": str(UUID(int=i + 20)), "name": name, "quantity": quantity,
     "price": price, "line_total": total, "currency": "USD"}
    for i, (name, quantity, price, total) in enumerate([
        ("Gala Apples 1kg", 2, "3.50", "7.00"), ("Bananas 1kg", 2, "1.50", "3.00"),
        ("Baladi Bread", 2, "1.20", "2.40"), ("Black Tea", 1, "3.40", "3.40"),
        ("Fresh Milk", 1, "2.25", "2.25"), ("Egyptian Rice", 1, "2.49", "2.49"),
        ("Roumi Cheese", 1, "6.00", "6.00"),
    ])
], "total_lines": 7, "total_quantity": 10, "subtotal": "26.54", "discount_amount": "0",
    "currency": "USD", "fully_reserved": False}
def rich_blocks(compare):
    block = {"kind":"comparison_table" if compare else "recommendation_group", "title":"Compare current catalog facts" if compare else "Matches to your requirements", "products":PRODUCTS, "sources":[{"kind":"catalog", "product_id":p["id"], "route":p["route"]} for p in PRODUCTS]}
    if compare:
        block["rows"] = [{"label":"Current price","values":["99 USD","109 USD"]},{"label":"Availability","values":["In stock","Availability unknown"]},{"label":"color","values":["black","green"]},{"label":"size","values":["42","Not provided"]}]
    return [block, {"kind":"text","text":"Prices are current catalog prices; checkout may add tax and delivery."}, {"kind":"action","action":{"label":"Browse the catalog","route":"/search"}}]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/v1/theme/"):
            theme = json.loads((Path(__file__).resolve().parents[3] / "commerce-demo/grocery/theme.json").read_text())
            self.reply({"version_id": None, "configuration": theme, "cities": []})
        elif path == f"/v1/catalog/media/{UUID(int=99)}/content":
            body = b'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150" viewBox="0 0 240 150"><rect width="240" height="150" fill="#e9eee6"/><path d="M45 93L65 55L97 74L120 87L170 94Q195 100 190 112H50Q36 110 45 93" fill="#334636"/><path d="M48 112H188" stroke="#fff" stroke-width="8"/></svg>'
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/v1/delivery-area":
            self.reply({"configured": False, "deliverable": True, "area_id": None})
        elif path == "/v1/assistant/history":
            cid=parse_qs(urlparse(self.path).query).get('conversation_id',[None])[0]
            self.reply([r for r in reversed(HISTORY) if cid is None or r['conversation_id']==cid])
        elif path == "/v1/customer/me":
            self.reply(CUSTOMER)
        elif path in ("/v1/customer/support/tickets", "/v1/catalog/categories", "/v1/customer/locations"):
            self.reply([])
        else:
            self.reply({"error": "Synthetic fixture: endpoint unavailable"}, 404)

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        if size > 16384:
            self.reply({}, 413)
            return
        body = json.loads(self.rfile.read(size) or "{}")
        if self.path == "/v1/customer/auth/refresh":
            self.reply({"access_token": "synthetic-m06-token", "customer": CUSTOMER})
            return
        if self.path == "/v1/assistant/feedback":
            for row in HISTORY:
                if row['request_id']==body['request_id']: row['helpful']=body['helpful']
            self.reply({'status':'ok'})
            return
        if self.path != "/v1/assistant/chat":
            self.reply({}, 404)
            return
        question = body["message"]
        ATTEMPTS[question] = ATTEMPTS.get(question, 0) + 1
        if "retry" in question.lower() and ATTEMPTS[question] == 1:
            self.reply({"error": "synthetic-internal-canary"}, 503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        sequence = 0
        def event(kind, **fields):
            nonlocal sequence
            value = {"version": "1", "request_id": body["request_id"], "sequence": sequence, "type": kind, **fields}
            sequence += 1
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(value)}\n\n".encode())
            self.wfile.flush()
        try:
            if "cart" in question.lower() or "basket" in question.lower():
                cart = CART if "empty" not in question.lower() else {**CART, "items": [], "total_lines": 0, "total_quantity": 0, "subtotal": "0.00"}
                blocks = [{"kind": "cart_summary", "cart": cart}]
                answer = f"Your cart has {cart['total_quantity']} items."
                event("progress", stage="catalog")
                event("message.delta", text=answer)
                event("content.blocks", blocks=blocks)
                if body.get("conversation_id"):
                    HISTORY.append({"conversation_id": body["conversation_id"], "request_id": body["request_id"], "question": question, "answer": answer, "blocks": blocks, "created_at": datetime.now(timezone.utc).isoformat()})
                event("done", saved=True)
                return
            if body.get("order_id"):
                event("progress", stage="order")
                time.sleep(1)
                event("card.order", order={"id": body["order_id"], "number": 106, "status": "shipped", "subtotal": "99.00", "discount_amount": "0.00", "tax_amount": "0.00", "delivery_fee": "5.00", "total": "104.00", "currency": "USD", "cancellation_available": False, "shipments": [{"tracking_reference": "M06-FIXTURE", "status": "shipped"}]})
                event("message.delta", text="Your order is **shipped**.")
                event("done")
                return
            event("progress", stage="catalog")
            time.sleep(1)
            event("message.delta", text="## Verified catalog matches\n\n")
            if "slow" in question.lower():
                for _ in range(15):
                    time.sleep(1)
                    event("message.delta", text="Checking another detail. ")
            event("message.delta", text=f"- **Running shoes** — 99 USD. Delivery availability unknown. /products/{ID}\n  Color=black, size=42.\n\nCatalog prices may differ from checkout totals.")
            blocks=rich_blocks("compare" in question.lower())
            event("content.blocks", blocks=blocks)
            if body.get('conversation_id'):
                HISTORY.append({'conversation_id':body['conversation_id'],'request_id':body['request_id'],'question':question,'answer':'Saved catalog facts','blocks':blocks,'helpful':None,'created_at':datetime.now(timezone.utc).isoformat()})
            event("done",saved=True)
        except (BrokenPipeError, ConnectionResetError):
            pass

if __name__ == "__main__":
    print("Synthetic assistant fixture: http://127.0.0.1:18086", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 18086), Handler).serve_forever()
