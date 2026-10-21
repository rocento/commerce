"""Standalone mobile admin ingress; opt-in real Nginx checks use a disposable container."""
import importlib.util
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from uuid import uuid4
ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('studio_config', ROOT / 'commerce-ops/deploy/ec2/configure.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)

class MobileStudioConfiguration(unittest.TestCase):
    def test_separate_bundle_and_explicit_mobile_api_allowlist(self):
        rendered = config.nginx('rocento.com')
        block = rendered.split('server_name apps.rocento.com;', 1)[1]
        self.assertIn('root /var/www/rocento/current/mobile-admin;', block)
        self.assertNotIn('current/grocery-admin', block)
        expression = next(line.strip()[len('location ~ '):-2] for line in block.splitlines() if line.strip().startswith('location ~ '))
        merchant='00000000-0000-0000-0000-000000000001'
        for path in [f'/api/v1/merchants/{merchant}/asset-library', f'/api/v1/merchants/{merchant}/asset-folders', f'/api/v1/merchants/{merchant}/asset-folders/{merchant}', f'/api/v1/merchants/{merchant}/assets/move', f'/api/v1/merchants/{merchant}/assets/{merchant}', f'/api/v1/merchants/{merchant}/app-preview/sessions', f'/api/v1/merchants/{merchant}/app-preview/sessions/{merchant}', f'/api/v1/merchants/{merchant}/app-preview/catalog', f'/api/v1/merchants/{merchant}/app-preview/categories', '/api/v1/admin/me', '/api/v1/admin/auth/login', '/api/v1/admin/auth/logout', '/api/v1/mobile/merchants', f'/api/v1/merchants/{merchant}/app-config/publish', f'/api/v1/merchants/{merchant}/assets/{merchant}/content',f'/api/v1/merchants/{merchant}/app-devices',f'/api/v1/merchants/{merchant}/app-devices/identities',f'/api/v1/merchants/{merchant}/app-devices/invitations',f'/api/v1/merchants/{merchant}/app-devices/{merchant}/revoke']:
            self.assertRegex(path, expression.strip(chr(34)))
        for path in [f'/api/v1/mobile/preview/{merchant}', f'/api/v1/mobile/preview/{merchant}/ack', '/api/v1/admin/users','/api/v1/admin/roles','/api/v1/admin/api-reference/openapi.json','/api/v1/catalog/products','/api/openapi.json','/api/metrics','/api/v1/customer/me','/api/v1/mobile/config','/api/v1/mobile/enroll','/api/v1/mobile/session',f'/api/v1/mobile/assets/{merchant}/content',f'/api/v1/merchants/{merchant}/assets/../app-builds']:
            self.assertIsNone(re.search(expression.strip(chr(34)),path),path)
        self.assertIn('location /api/ { return 404; }',block)
        build=(ROOT/'commerce-ops/deploy/ec2/build-frontend.sh').read_text()
        self.assertIn('pnpm --filter @rocento/mobile-admin build',build)
        self.assertIn('apps/mobile-admin/dist/. /public/mobile-admin/',build)
        self.assertNotIn('mobile-studio', (ROOT/'commerce-web/apps/admin/src/main.tsx').read_text())

@unittest.skipUnless(os.environ.get('MOBILE_STUDIO_INGRESS_TESTS') == '1','requires opt-in Docker Nginx fixture')
class MobileStudioIngress(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp=tempfile.TemporaryDirectory(prefix='mobile-studio-ingress-');cls.addClassCleanup(temp.cleanup)
        root=Path(temp.name);root.chmod(0o755);(root/'mobile-admin').mkdir();(root/'grocery-admin').mkdir()
        (root/'mobile-admin/index.html').write_text('Standalone mobile workspace')
        (root/'grocery-admin/index.html').write_text('Core admin workspace')
        rendered=config.nginx('example.test').replace('listen 80;','listen 18081;').replace('listen 443 ssl;','listen 8080;')
        rendered=re.sub(r'^\s+ssl_(certificate|certificate_key|protocols) .*\n','',rendered,flags=re.M)
        rendered=rendered.replace('/var/www/rocento/current/','/fixture/')
        rendered=re.sub(r'proxy_pass http://127\.0\.0\.1:\d+', 'proxy_pass http://127.0.0.1:18082',rendered)
        source='pid /tmp/nginx.pid;\nevents {}\nhttp {\naccess_log off;\nclient_body_temp_path /tmp/client_body;\nproxy_temp_path /tmp/proxy;\n'+rendered+'\nserver { listen 18082; location / { return 200 "mobile fixture $uri"; } }\n}'
        (root/'nginx.conf').write_text(source)
        cls.container='mobile-studio-ingress-'+uuid4().hex[:12]
        subprocess.run(['docker','run','--detach','--name',cls.container,'--entrypoint','nginx','--mount',f'type=bind,source={root},target=/fixture,readonly','nginxinc/nginx-unprivileged:1.28-alpine','-c','/fixture/nginx.conf','-g','daemon off;'],check=True,capture_output=True)
        cls.addClassCleanup(subprocess.run,['docker','rm','--force',cls.container],capture_output=True)
        result=subprocess.run(['docker','exec',cls.container,'nginx','-t','-c','/fixture/nginx.conf'],capture_output=True,text=True)
        if result.returncode:
            logs=subprocess.run(['docker','logs',cls.container],capture_output=True,text=True)
            raise RuntimeError(result.stderr+logs.stderr)
    def get(self,path,host='apps.example.test'):
        result=subprocess.run(['docker','exec',self.container,'curl','-sS','--path-as-is','--max-time','5','--include','-H',f'Host: {host}',f'http://127.0.0.1:8080{path}'],check=True,capture_output=True,text=True)
        headers,_,body=result.stdout.partition('\n\n');return int(headers.split()[1]),headers,body
    def test_root_and_deep_links_serve_only_mobile_bundle(self):
        for path in ['/','/studio']:
            status,headers,body=self.get(path);self.assertEqual(status,200);self.assertEqual(body,'Standalone mobile workspace');self.assertIn('noindex, nofollow',headers)
        self.assertEqual(self.get('/',host='admin.example.test')[2],'Core admin workspace')
    def test_core_and_encoded_api_routes_cannot_escape_allowlist(self):
        merchant='00000000-0000-0000-0000-000000000001'
        for path in [f'/api/v1/mobile/preview/{merchant}', f'/api/v1/mobile/preview/{merchant}/ack', '/api/v1/admin/users','/api/v1/catalog/products','/api/openapi.json','/api/metrics','/api/v1/customer/me','/api/v1/admin/auth/../users','/api/v1/admin/%75sers','/api/v1/mobile/merchants/../config']:
            self.assertEqual(self.get(path)[0],404,path)
    def test_mobile_requests_are_rewritten_to_the_authenticated_gateway(self):
        for path in ['/api/v1/merchants/00000000-0000-0000-0000-000000000001/asset-library', '/api/v1/merchants/00000000-0000-0000-0000-000000000001/asset-folders', '/api/v1/merchants/00000000-0000-0000-0000-000000000001/assets/move', '/api/v1/admin/me','/api/v1/mobile/merchants','/api/v1/merchants/00000000-0000-0000-0000-000000000001/app-config/draft?environment=production']:
            status,headers,body=self.get(path);self.assertEqual(status,200);self.assertEqual(body,'mobile fixture '+path.split('?')[0][4:]);self.assertIn('no-store',headers)

    def test_native_config_preserves_integrity_headers_without_changing_other_routes(self):
        status,headers,body=self.get('/api/v1/mobile/config?platform=ios',host='grocery.example.test')
        self.assertEqual(status,200)
        self.assertEqual(body,'mobile fixture /v1/mobile/config')
        self.assertIn('private, no-store, no-transform',headers)
        self.assertNotIn('no-transform',self.get('/api/v1/catalog/categories',host='grocery.example.test')[1])
        self.assertNotIn('no-transform',self.get('/api/v1/mobile/config',host='jewelry.example.test')[1])
        self.assertEqual(self.get('/api/v1/mobile/config')[0],404)

    def test_builder_rejects_nonproduction_environments(self):
        path='/api/v1/merchants/00000000-0000-0000-0000-000000000001/app-config/draft'
        for value in ['staging', 'development', '%73taging']:
            self.assertIn(self.get(path+'?environment='+value)[0], [400], value)
