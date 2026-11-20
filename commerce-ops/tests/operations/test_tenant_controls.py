import importlib.util,json,tempfile,unittest,uuid
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('controls',ROOT/'commerce-ops/cloud/host/tenant_controls.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ControlsTests(unittest.TestCase):
 def setUp(self):self.item={'id':str(uuid.uuid4()),'tenantId':str(uuid.uuid4()),'slug':'fixture-store','action':'SUSPEND'}
 def test_request_identifiers_are_strict(self):
  for field,value in [('id',"';DROP"),('slug','bad;host'),('action','DELETE')]:
   with self.assertRaises(ValueError):m.validate(dict(self.item,**{field:value}))
 def test_unprovisioned_store_gets_exact_denial_routes(self):
  with tempfile.TemporaryDirectory() as root,patch.object(m,'STATE',Path(root)/'state'),patch.object(m,'NGINX',Path(root)),patch.object(m,'trusted',side_effect=Path),patch.object(m,'run',return_value=b'') as run:
   m.restrict_runtime(self.item);text=(Path(root)/('merchant-'+self.item['tenantId']+'.conf')).read_text()
   self.assertIn('fixture-store.rocento.com fixture-store-admin.rocento.com',text);self.assertIn('return 503',text)
   self.assertFalse(any(call.args[0][0]=='docker' for call in run.call_args_list))
 def test_runtime_stops_without_removing_volumes(self):
  with tempfile.TemporaryDirectory() as root,patch.object(m,'STATE',Path(root)/'state'),patch.object(m,'NGINX',Path(root)),patch.object(m,'trusted',side_effect=Path):
   directory=m.STATE/self.item['tenantId'];directory.mkdir(parents=True)
   (directory/'compose.json').write_text(json.dumps({'name':'merchant-'+self.item['tenantId']}));(directory/'runtime.env').write_text('')
   with patch.object(m,'run',return_value=b'') as run:m.restrict_runtime(self.item)
   calls=[c.args[0] for c in run.call_args_list];self.assertTrue(any('stop' in c for c in calls));self.assertFalse(any('down' in c or 'rm' in c or '-v' in c for c in calls))
 def test_failed_nginx_validation_restores_existing_configuration(self):
  with tempfile.TemporaryDirectory() as root,patch.object(m,'STATE',Path(root)/'state'),patch.object(m,'NGINX',Path(root)),patch.object(m,'trusted',side_effect=Path),patch.object(m,'run',side_effect=RuntimeError):
   target=Path(root)/('merchant-'+self.item['tenantId']+'.conf');target.write_text('original')
   with self.assertRaises(RuntimeError):m.restrict_runtime(self.item)
   self.assertEqual(target.read_text(),'original')
 def test_completion_retains_billing_and_uses_transaction(self):
  sql=m.complete_sql(dict(self.item,action='ARCHIVE'))
  self.assertIn('BEGIN;',sql);self.assertIn('COMMIT;',sql);self.assertIn("management_state='ARCHIVED'",sql)
  self.assertNotIn('DELETE',sql);self.assertNotIn('billing_entitlements',sql);self.assertIn('audit_events',sql)
if __name__=='__main__':unittest.main()
