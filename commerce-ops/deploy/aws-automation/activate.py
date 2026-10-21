#!/usr/bin/env python3
"""Scoped 2026-10-14 App Studio rollout; execute as root on the existing demo host."""
import fcntl, json, os, shutil, subprocess, time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
root=Path('/opt/rocento')
lock=(root/'deploy/ec2/setup.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
run=lambda *a:subprocess.check_output(a,text=True).strip()
release=Path('/var/www/rocento/releases/apps-android-ec2-20261014')
backup=Path('/var/backups/rocento/apps-android-ec2-20261014')
previous=Path('/var/www/rocento/current').resolve()
old='sha256:802aaec0af95033a153818d0332a9e1c91a13c9d01fde8154e66c42e846d8f30'
assert run('docker','inspect','rocento-grocery-api-gateway-1','--format','{{.Image}}')==old,'Live gateway changed'
assert str(previous)=='/var/www/rocento/releases/studio-preview-variants-v3-20261013','Live frontend changed'
assert not backup.exists() and not release.exists(),'Release already exists'
stage=Path('/home/ubuntu/apps-production-20261014')
assert (stage/'integration.exit').read_text().strip()=='0','Coordinated gateway acceptance did not pass'
candidate=run('docker','image','inspect','rocento-apps:20261014','--format','{{.Id}}')
rollback=run('docker','image','inspect','rocento-apps:rollback-20261014','--format','{{.Id}}')
sidecar=run('docker','image','inspect','rocento-mobile-preview:20261014','--format','{{.Id}}')
backup.mkdir(mode=0o700);release.mkdir(mode=0o755)
nginx=Path('/etc/nginx/sites-enabled/rocento').resolve();original_nginx=nginx.read_text()
config=root/'deploy/ec2/grocery.yaml';original_config=config.read_text()
(backup/'nginx.conf').write_text(original_nginx);(backup/'grocery.yaml').write_text(original_config)
(backup/'previous.json').write_text(json.dumps({'frontend':str(previous),'image':old,'rollbackImage':rollback}))
before=run('docker','ps','--format','{{.Names}} {{.ID}}')
(backup/'containers-before').write_text(before)
with (backup/'mobile-before.sql').open('w') as f:
 subprocess.run(['docker','exec','rocento-grocery-postgres-1','sh','-c','pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=mobile && pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --table=public._sqlx_migrations'],stdout=f,check=True)
for path in previous.iterdir():
 if path.name=='mobile-admin':continue
 if path.is_dir():shutil.copytree(path,release/path.name,copy_function=os.link)
 else:os.link(path,release/path.name)
(release/'mobile-admin').mkdir()
subprocess.run(['tar','-xzf','/tmp/rocento-android-studio-ui-20261014.tar.gz','-C',str(release/'mobile-admin')],check=True)
for p in (release/'mobile-admin').rglob('*'):p.chmod(0o755 if p.is_dir() else 0o644)
compose=['bash',str(root/'deploy/ec2/server/ec2-compose.sh'),'grocery','up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','api-gateway']
def link(target):
 temp=Path('/var/www/rocento/current.android-next');temp.symlink_to(target);os.replace(temp,'/var/www/rocento/current')
snippets=[Path('/etc/nginx/snippets/rocento-native-preview-apps.conf'),Path('/etc/nginx/snippets/rocento-native-preview-grocery.conf')]
assert not any(p.exists() for p in snippets),'Proxy snippets already exist'
try:
 cfg=json.loads(original_config);cfg['services']['api-gateway']['image']=candidate
 config.write_text(json.dumps(cfg,indent=2)+'\n')
 subprocess.run(compose,cwd=root,check=True)
 assert run('docker','inspect','rocento-grocery-api-gateway-1','--format','{{.State.Health.Status}}')=='healthy'
 print('Migration-compatible commerce gateway healthy',flush=True)
 info=json.loads(run('docker','inspect','rocento-grocery-api-gateway-1'))[0]
 original_env=dict(x.split('=',1) for x in info['Config']['Env'] if '=' in x)
 env={k:original_env[k] for k in ['DATABASE_URL','AUTH_SECRET','STOREFRONT_URL','S3_ENDPOINT','S3_ACCESS_KEY','S3_SECRET_KEY']}
 for key,port in [('DATABASE_URL',5432),('S3_ENDPOINT',9000)]:
  u=urlsplit(env[key]);auth=u.netloc.rsplit('@',1)[0]+'@' if '@' in u.netloc else ''
  env[key]=urlunsplit((u.scheme,auth+'127.0.0.1:'+str(port),u.path,u.query,u.fragment))
 control=dict(x.split('=',1) for x in Path('/opt/rocento-preview-control/controller.env').read_text().splitlines())
 env.update(MOBILE_ANDROID_PREVIEW_WORKER_URL='http://127.0.0.1:19097',MOBILE_ANDROID_PREVIEW_WORKER_TOKEN=control['MOBILE_ANDROID_PREVIEW_WORKER_TOKEN'],MOBILE_ANDROID_PREVIEW_MERCHANT='312f9ac8-4888-4d35-92a0-e5fdb3bf59b8')
 path=Path('/opt/rocento-preview-control/gateway.env')
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:
  for k,v in env.items():
   assert '\n' not in v;f.write(k+'='+v+'\n')
 subprocess.run(['docker','run','-d','--name','rocento-mobile-preview-gateway','--network','host','--restart','unless-stopped','--env-file',str(path),'--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--cap-drop','ALL','--security-opt','no-new-privileges',sidecar],check=True,stdout=subprocess.DEVNULL)
 for i in range(30):
  code=subprocess.run(['curl','-s','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:9085/v1/merchants/312f9ac8-4888-4d35-92a0-e5fdb3bf59b8/app-preview/instance'],capture_output=True,text=True).stdout
  if code=='401':break
  time.sleep(2)
 else:raise RuntimeError('Preview gateway did not become ready')
 for source,dest in zip(['/tmp/nginx-apps.conf','/tmp/nginx-native.conf'],snippets):shutil.copy2(source,dest);dest.chmod(0o644)
 new=original_nginx
 for host in ['apps','grocery']:
  marker='    server_name '+host+'.rocento.com;\n'
  assert new.count(marker)==1
  new=new.replace(marker,marker+'    include /etc/nginx/snippets/rocento-native-preview-'+host+'*.conf;\n')
 nginx.write_text(new)
 subprocess.run(['nginx','-t'],check=True)
 subprocess.run(['systemctl','reload','nginx'],check=True)
 link(release)
 html=subprocess.check_output(['curl','-fsS','--retry','3','--max-time','20','https://apps.rocento.com/'])
 assert html==(release/'mobile-admin/index.html').read_bytes(),'Frontend hash mismatch'
 for host in ['admin','jewelry-admin','electronics-admin','pharmacy-admin']:
  subprocess.run(['curl','-fsS','--retry','2','--max-time','20',f'https://{host}.rocento.com/api/ready'],stdout=subprocess.DEVNULL,check=True)
 after=dict(line.split() for line in run('docker','ps','--format','{{.Names}} {{.ID}}').splitlines())
 for line in before.splitlines():
  name,container=line.split()
  if name!='rocento-grocery-api-gateway-1':assert after.get(name)==container,name
 result={'status':'deployed','release':str(release),'previous':str(previous),'gateway':candidate,'previewGateway':sidecar,'backup':str(backup),'rollbackImage':rollback,'unrelatedContainersUnchanged':True}
 (backup/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
except BaseException:
 nginx.write_text(original_nginx)
 subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
 if Path('/var/www/rocento/current').resolve()!=previous:link(previous)
 cfg=json.loads(original_config);cfg['services']['api-gateway']['image']=rollback;config.write_text(json.dumps(cfg,indent=2)+'\n')
 subprocess.run(compose,cwd=root,check=True)
 subprocess.run(['docker','rm','-f','rocento-mobile-preview-gateway'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 raise
