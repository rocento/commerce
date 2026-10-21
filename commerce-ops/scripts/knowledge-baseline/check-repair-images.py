"""Non-root, read-only checks of the exact publication images; no network or DB."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'output/enterprise-knowledge-release-repair-20261010/final'
report = {'scope': 'Frozen candidate images only; no production activation', 'images': {}}
programs = {
    'language': r"""
import assert from 'node:assert/strict';
import {loadRuntime} from './src/runtime.ts';
import {resolve} from './src/engine.ts';
import {readDeploymentRelease} from './scripts/deployment-release.ts';
import {runtimeSha256} from './src/runtime-identity.ts';
import {resolutionEnvelope} from './src/resolution-wire.ts';
const release=await readDeploymentRelease(new URL('./data/',import.meta.url));
const identity=release.release.payload.identity,runtime=await loadRuntime();
assert.equal(identity.runtimeSha256,await runtimeSha256());assert.notEqual(process.getuid(),0);
const cases=[['show my cart','VIEW_CART','RESOLVED'],['if possible, show rules for returns','RETURN_POLICY','RESOLVED'],['Hi, Can I return Acme Notebook if it is not right for me?','RETURN_POLICY','RESOLVED'],['Can I get a replacement for a laptop tomorrow? I need it for video editing.','DELIVERY_DATE','NEEDS_CONTEXT'],['pls i need take any two fresh items from my cart','REMOVE_FROM_CART','NEEDS_CONTEXT'],['Find a camera for macro photography under $500','PRODUCT_SEARCH','RESOLVED']];
for(const [text,intent,status] of cases){const result=resolve(runtime,text);assert.equal(result.intent,intent,text);assert.equal(result.status,status,text);resolutionEnvelope(result,{releaseId:identity.releaseId,generationFingerprint:runtime.dictionary.generationFingerprint,runtimeVersion:identity.runtimeSha256,normalizationVersion:'english-v1',clauseSpanEncoding:'utf-16-code-units',evidenceSpanEncoding:'unicode-code-points'});}
console.log(JSON.stringify({nodeVersion:process.version,uid:process.getuid(),identity,checks:cases.length,passed:true}));
""",
    'assistant': r"""
import json,os,hashlib
from pathlib import Path
from app.main import app
from app.commerce_action_engine.actions.shopping.context import _published_sentence_rules
assert os.getuid()!=0 and _published_sentence_rules()
with open('app/commerce_language_engine/data/compiled.json') as stream:d=json.load(stream)
assert d['languageKnowledge']['revision']==10
sources={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path('app').rglob('*.py'))}
compiled=hashlib.sha256(Path('app/commerce_language_engine/data/compiled.json').read_bytes()).hexdigest()
print(json.dumps({'uid':os.getuid(),'knowledgeRevision':10,'fingerprint':d['generationFingerprint'],'publishedRulesReadable':True,'sourceSha256':sources,'compiledSha256':compiled,'passed':True}))
""",
}
for component, program in programs.items():
    tag=(sys.argv[1] if component=='assistant' and len(sys.argv)>1 else f'commerce-knowledge-release-repair:{component}-final-20261010')
    metadata=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
    command=['docker','run','--rm','--network','none','--read-only','-i',tag]
    command+=['node','--input-type=module','-'] if component=='language' else ['python','-']
    completed=subprocess.run(command,input=program,text=True,capture_output=True,check=True)
    path=OUT/(component+'-image-runtime.log');path.write_text(completed.stdout+completed.stderr)
    details=json.loads(completed.stdout.strip().splitlines()[-1])
    if component=='assistant':
        manifest=json.loads((OUT/'python-build-manifest.json').read_text())
        expected={name:digest for name,digest in manifest.items() if name.startswith('app/') and name.endswith('.py') and not name.startswith('app/commerce_language_engine/')}
        assert details['sourceSha256']==expected, 'Python image source differs from verified build'
        assert details['compiledSha256']==manifest['app/commerce_language_engine/data/compiled.json']
    report['images'][component]={'tag':tag,'imageId':metadata['Id'],'platform':metadata['Os']+'/'+metadata['Architecture'],'nonRootUser':metadata['Config']['User'],'network':'none','readOnly':True,'result':details,'logSha256':hashlib.sha256(path.read_bytes()).hexdigest()}
report['passed']=all(image['result']['passed'] for image in report['images'].values())
with (OUT/'image-verification.json').open('x') as stream:json.dump(report,stream,indent=2);stream.write('\n')
print(json.dumps({'passed':report['passed'],'images':{name:value['imageId'] for name,value in report['images'].items()}}))
