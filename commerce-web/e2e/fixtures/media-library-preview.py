"""Disposable media-library fixture; no store data or object storage is touched."""
import runpy,json,uuid
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs
from email.parser import BytesParser
from email.policy import default
base=runpy.run_path(str(Path(__file__).with_name('admin-workflow-preview.py')))
folders=[dict(id='folder-products',name='Products',parent_id=None),dict(id='folder-banners',name='Campaigns',parent_id=None),dict(id='folder-pantry',name='Pantry',parent_id='folder-products')]
media=[dict(id=f'image-{i}',alt=f'Product photo {i+1:02}',object_key=f'catalog/image-{i}',content_type='image/png',size_bytes=24000,file_name=f'product-{i+1:02}.png',folder_id='folder-pantry' if i<3 else None) for i in range(52)]
class Handler(base['Handler']):
    def body(self): return json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
    def do_GET(self):
        path=urlparse(self.path).path
        if path=='/v1/admin/catalog/media/folders': return self.reply([{**folder,'media_count':sum(m['folder_id']==folder['id'] for m in media)} for folder in folders])
        if path=='/v1/admin/catalog/media/library':
            params=parse_qs(urlparse(self.path).query);folder=params.get('folder',['all'])[0];term=params.get('q',[''])[0].lower();offset=int(params.get('offset',['0'])[0]);limit=int(params.get('limit',['48'])[0])
            rows=[m for m in media if (folder=='all' or m['folder_id']==(None if folder=='unfiled' else folder)) and term in (m['alt']+' '+m['file_name']).lower()]
            return self.reply(dict(items=rows[offset:offset+limit],total=len(rows),offset=offset,limit=limit))
        if path.startswith('/v1/catalog/media/') and path.endswith('/content'):
            self.path='/v1/catalog/media/fixture-cover/content'
        return super().do_GET()
    def do_POST(self):
        if self.path=='/v1/admin/catalog/media/folders':
            body=self.body()
            if any(f['parent_id']==body['parent_id'] and f['name'].lower()==body['name'].lower() for f in folders): return self.reply({'error':'A folder with this name already exists here'},400)
            folder=dict(id=str(uuid.uuid4()),**body);folders.append(folder);return self.reply({**folder,'media_count':0},201)
        if self.path=='/v1/admin/catalog/media/move':
            body=self.body()
            for m in media:
                if m['id'] in body['ids']: m['folder_id']=body['folder_id']
            return self.reply({'status':'ok'})
        if self.path=='/v1/admin/catalog/media':
            content=self.rfile.read(int(self.headers.get('Content-Length',0)))
            message=BytesParser(policy=default).parsebytes(('Content-Type: '+self.headers['Content-Type']+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+content)
            values={part.get_param('name',header='content-disposition'):part for part in message.iter_parts()}
            item=dict(id=str(uuid.uuid4()),alt=values['alt'].get_content(),file_name=values['file'].get_filename(),content_type='image/png',size_bytes=len(values['file'].get_payload(decode=True)),object_key='catalog/test-upload',folder_id=values['folder_id'].get_content() if 'folder_id' in values else None)
            media.append(item);return self.reply(item,201)
        return super().do_POST()
    def do_PUT(self):
        if self.path.startswith('/v1/admin/catalog/media/folders/'):
            folder=next(f for f in folders if f['id']==self.path.rsplit('/',1)[1]);folder.update(self.body());return self.reply({**folder,'media_count':0})
        if self.path.startswith('/v1/admin/catalog/media/'):
            item=next(m for m in media if m['id']==self.path.rsplit('/',1)[1]);item.update(self.body());return self.reply(item)
        return super().do_PUT()
    def do_DELETE(self):
        if self.path.startswith('/v1/admin/catalog/media/folders/'):
            ids={self.path.rsplit('/',1)[1]}
            while True:
                children={f['id'] for f in folders if f['parent_id'] in ids}
                if children<=ids: break
                ids|=children
            folders[:]=[f for f in folders if f['id'] not in ids]
            for item in media:
                if item['folder_id'] in ids:item['folder_id']=None
            return self.reply({'status':'ok'})
        return super().do_DELETE()
if __name__=='__main__':
    print('Synthetic media library: http://127.0.0.1:18091',flush=True)
    ThreadingHTTPServer(('127.0.0.1',18091),Handler).serve_forever()
