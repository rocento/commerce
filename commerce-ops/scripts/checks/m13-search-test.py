"""Test real Meilisearch with an isolated index and SQLx disposable databases."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import quote
import os
import subprocess
import threading
import uuid
root=Path(__file__).resolve().parents[3]
values=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
index='m13_test_'+uuid.uuid4().hex
class Proxy(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def forward(self):
        path=self.path.replace('/indexes/products','/indexes/'+index)
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        request=Request('http://localhost:7700'+path,data=body or None,method=self.command,headers={'Authorization':'Bearer '+values['MEILI_MASTER_KEY'],'Content-Type':'application/json'})
        try: response=urlopen(request,timeout=20)
        except HTTPError as error: response=error
        with response:
            data=response.read();self.send_response(response.code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    do_GET=do_POST=do_PUT=do_PATCH=do_DELETE=forward
server=ThreadingHTTPServer(('127.0.0.1',0),Proxy)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=os.environ.copy();env['M13_SEARCH_URL']=f'http://127.0.0.1:{server.server_port}';env['MEILI_MASTER_KEY']=values['MEILI_MASTER_KEY']
if 'DATABASE_URL' not in env:
    env['DATABASE_URL']='postgres://{}:{}@127.0.0.1:5432/{}'.format(quote(values.get('POSTGRES_USER','commerce'),safe=''),quote(values['POSTGRES_PASSWORD'],safe=''),quote(values.get('POSTGRES_DB','commerce'),safe=''))
try:
subprocess.run(['cargo','test','-p','api-gateway','--test','delivery_areas','real_search','--','--ignored'],cwd=root/'commerce-api',env=env,check=True)
finally:
    server.shutdown()
    try:
        with urlopen(Request('http://localhost:7700/indexes/'+index,method='DELETE',headers={'Authorization':'Bearer '+values['MEILI_MASTER_KEY']}),timeout=20) as response: response.read()
    except HTTPError as error:
        if error.code!=404: raise
