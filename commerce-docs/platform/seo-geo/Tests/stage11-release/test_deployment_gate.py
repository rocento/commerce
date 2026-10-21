import copy, importlib.util, pathlib, unittest
spec=importlib.util.spec_from_file_location('gate',pathlib.Path(__file__).with_name('deployment_gate.py'));gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
class GateTests(unittest.TestCase):
 def fixture(self):return {'installations':[{'project':p,'errors':[],'origins':[f'https://{p}.example.test/'],'installation_ids':['00000000-0000-0000-0000-00000000000'+str(ord(p)-96)],'database_scopes':[f'{p}-db'],'media_scopes':[f'{p}-media']} for p in ['a','b']]}
 def test_distinct_scopes(self):self.assertEqual(gate.assess(self.fixture())['gate'],'Verified')
 def test_all_shared_scopes_block(self):
  for key in ['origins','installation_ids','database_scopes','media_scopes']:
   data=self.fixture();data['installations'][1][key]=data['installations'][0][key];self.assertEqual(gate.assess(data)['gate'],'Blocked')
 def test_missing_or_failed_evidence_blocks(self):
  self.assertEqual(gate.assess({'installations':[]})['gate'],'Blocked');data=self.fixture();data['installations'][0]['errors']=['unavailable'];self.assertEqual(gate.assess(data)['gate'],'Blocked')
 def test_unapproved_origins(self):
  for origin in ['http://a.test/','https://user:password@a.test/','https://a.test/?x=secret','https://a.test:443/']:
   data=self.fixture();data['installations'][0]['origins']=[origin];self.assertEqual(gate.assess(data)['gate'],'Blocked')


class ComposeContractTests(unittest.TestCase):
 def test_overlay_connects_private_health_and_same_artifacts(self):
  import os, re, subprocess, tempfile, json
  root=pathlib.Path(__file__).resolve().parents[5]
  variables=set(re.findall(r'\$\{([A-Z0-9_]+):\?',(root/'compose.yaml').read_text()+(root/'compose.publication.yaml').read_text()))
  values={v:'synthetic-test-only-'*4 for v in variables}
  values.update(PUBLICATION_INSTALLATION_ID='00000000-0000-0000-0000-000000000001',PUBLICATION_APPROVED_ORIGIN='https://merchant.example.test/',PUBLICATION_ARTIFACT_DIR='/tmp/synthetic-artifacts',PUBLICATION_WORKSPACE_DIR='/tmp/synthetic-workspace')
  with tempfile.NamedTemporaryFile(mode='w') as f:
   f.write('\n'.join(f'{k}={v}' for k,v in values.items()));f.flush()
   result=subprocess.run(['docker','compose','--env-file',f.name,'-f',str(root/'compose.yaml'),'-f',str(root/'compose.publication.yaml'),'config','--format','json'],capture_output=True,text=True,check=True,timeout=20)
  config=json.loads(result.stdout)['services'];api=config['api-gateway'];renderer=config['publication-renderer'];self.assertEqual(api['environment']['PUBLICATION_RENDERER_URL'],'http://publication-renderer:8081/');self.assertEqual(api['environment']['PUBLICATION_OBSERVATION_TOKEN'],renderer['environment']['PUBLICATION_OBSERVATION_TOKEN']);self.assertEqual(str(renderer['environment']['PUBLICATION_MAX_INFLIGHT']),'32');self.assertEqual(renderer['environment']['PUBLICATION_ARTIFACT_DIR'],'/srv/publication');self.assertEqual(str(api['environment']['PUBLICATION_NOINDEX']).lower(),'true');self.assertTrue(renderer['read_only'])
  self.assertEqual([v['source'] for v in api['volumes'] if v['target']=='/srv/publication'],[v['source'] for v in renderer['volumes'] if v['target']=='/srv/publication'])

class TopologyTests(unittest.TestCase):
 def container(self,name,network,alias):return {'Id':name,'Name':'/'+name,'NetworkSettings':{'Networks':{network:{'Aliases':[alias]}}}}
 def test_same_alias_on_separate_networks_is_isolated(self):
  a=self.container('api-a','a','api');pa=self.container('pg-a','a','postgres');pb=self.container('pg-b','b','postgres');self.assertTrue(gate.resolves_uniquely('postgres',a,pa,[a,pa,pb]))
 def test_ambiguous_shared_network_blocks(self):
  a=self.container('api-a','shared','api');pa=self.container('pg-a','shared','postgres');pb=self.container('pg-b','shared','postgres');self.assertFalse(gate.resolves_uniquely('postgres',a,pa,[a,pa,pb]))
if __name__=='__main__':unittest.main()
