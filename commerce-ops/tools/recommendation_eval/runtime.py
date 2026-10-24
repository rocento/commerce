"""Run every corpus request through the real authenticated chat/SSE app with fixture catalog transport."""
import json
import logging
import sys
import time

logging.disable(logging.CRITICAL)
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(ROOT/'commerce-assistant-platform'),str(ROOT/'commerce-assistant-platform/tests')]
import importlib

import httpx
import pytest
from app.commerce_action_engine.execution.language import gate
from app.main import create_app
from fastapi.testclient import TestClient
from test_assistant import identity
from test_catalog_schema import catalog_schema, schema_attribute
from test_shopping import product

folder=ROOT/'commerce-docs/platform/qa/recommendations-1000'
cases=[json.loads(l) for l in (folder/'cases.jsonl').read_text().splitlines()]
raw={r['id']:r['turns'][-1]['result'] for r in map(json.loads,(folder/'candidate-raw.jsonl').read_text().splitlines())}
plans={r['id']:r['plan'] for r in json.loads((folder/'candidate-results.json').read_text())}
patch=pytest.MonkeyPatch();config,_,headers=identity.__wrapped__(patch)
current={};calls=[]
async def resolve(url,text,**kwargs):return gate.Resolution.model_validate(raw[current['id']])
patch.setattr(gate,'resolve',resolve)
class NoModel:
 async def generate(self,request):raise AssertionError('Unexpected model call')
 async def stream(self,request):
  raise AssertionError('Unexpected model stream')
  yield
 async def aclose(self):pass
patch.setattr(importlib.import_module('app.commerce_action_engine.application.bootstrap'),'build_provider',lambda _:NoModel())
def commerce(request):
 assert request.method=='POST' and request.url.path=='/v1/assistant-tools/shopper','Unexpected commerce action '+str(request.url)
 body=json.loads(request.content);name=body['name'];calls.append(body)
 assert name in {'get_catalog_schema','search_products','get_discount_recommendations'},'Write or unexpected tool: '+name
 expected=current['expected'];plan=plans[current['id']] or {}
 attrs=[schema_attribute('color',options=['red','blue','green','black','white']),schema_attribute('material',options=['silver','gold','rose gold']),schema_attribute('size',options=['7']),schema_attribute('flavor',options=['vanilla']),schema_attribute('occasion','multiselect',['dinner','breakfast','lunch','snack','birthday','anniversary','wedding','work'],'semantic',semantic_role='intended_use')]
 category=plan.get('category')
 if category and current['group'] not in {'product','budget'}:attrs.append(schema_attribute('product_kind',options=[category],policy='semantic',semantic_role='classification'))
 if name=='get_catalog_schema':return httpx.Response(200,json={'products':[],'category':None,'catalog_schema':catalog_schema('general',attrs),'default_currency':'USD'})
 facts=[]
 if category:facts.append({'name':'product_kind','value':json.dumps(category),'source':'MERCHANT'})
 if 'purpose' in expected:facts.append({'name':'occasion','value':json.dumps([expected['purpose']]),'source':'MERCHANT'})
 if 'attribute' in expected:
  key,value=expected['attribute'];facts.append({'name':key,'value':json.dumps(value),'source':'MERCHANT'})
 price=str(expected.get('max_price',10)-1)
 good=product(1,name=expected.get('product','Merchant recommendation'),price=price,category='General',attributes=facts)
 if name=='get_discount_recommendations':
  good['price']='10'
  return httpx.Response(200,json={'offers':[{'product':good,'offer':{'product_id':good['id'],'currency':'USD','original_price':'10','discounted_price':'8','savings':'2','discount_percent':'20'}}],'candidate_limit':50,'metric':'catalog_discount_percent','quantity':1})
 
 args=body['arguments']
 if 'max_price' in expected:assert Decimal(str(args['max_price']))==expected['max_price'],'Budget missing from retrieval'
 if 'attribute' in expected:
  key,value=expected['attribute'];assert str(args['attributes'].get(key))==value,'Attribute missing from retrieval'
 # A returned candidate at/outside the boundary must be independently rejected.
 bad=product(2,name='Rejected candidate',price=str(expected.get('max_price',10)+(0 if expected.get('exclusive_max') else 1)),category=category or 'General',attributes=[],in_stock=False)
 return httpx.Response(200,json={'products':[good,bad] if 'max_price' in expected or expected.get('in_stock') else [good],'category':None})
results=[]
with TestClient(create_app(config,transport=httpx.MockTransport(commerce))) as client:
 for current in cases:
  calls.clear();request_id=str(uuid4());failure=[]
  try:
   response=client.post('/v1/chat',headers={**headers(request_id=request_id,iat=int(time.time()),exp=int(time.time())+45),'x-commerce-catalog-token':'fixture-catalog','x-delivery-latitude':'30','x-delivery-longitude':'31'},json={'request_id':request_id,'message':current['messages'][-1]})
   assert response.status_code==200,response.text[:200]
   events=[json.loads(l[6:]) for l in response.text.splitlines() if l.startswith('data: ')]
   assert not any(e['type']=='error' for e in events),'SSE error'
   cards=[p for e in events for b in e.get('blocks',[]) for p in b.get('products',[])]
   text=''.join(e.get('text','') for e in events if e['type']=='message.delta')
   expect_clarify=current['expected'].get('guard') or current['expected'].get('followup') in {'cheaper','different'}
   if expect_clarify:
    assert not cards,'Ungrounded cards instead of evidence/context clarification'
    assert text.strip(),'Missing clarification'
   else:
    assert cards,'No product cards: '+text[:240]
    assert all(p['name']!='Rejected candidate' for p in cards),'Ineligible product recommended'
    if 'max_price' in current['expected']:
     ceiling=current['expected']['max_price'];strict=current['expected']['exclusive_max']
     assert all(Decimal(p['price'])<ceiling if strict else Decimal(p['price'])<=ceiling for p in cards)
   outcome='clarification' if expect_clarify else 'products'
  except Exception as error:failure=[str(error)];outcome='failure';text=locals().get('text','')
  results.append({'id':current['id'],'group':current['group'],'passed':not failure,'outcome':outcome,'failures':failure,'tools':[c['name'] for c in calls],'response':text})
  if len(results)%100==0:print(len(results),'tested;',sum(r['passed'] for r in results),'passed',flush=True)
patch.undo()
(folder/'runtime-results.json').write_text(json.dumps(results,indent=2)+'\n')
print('RESULT',sum(r['passed'] for r in results),'/',len(results))
for row in [r for r in results if not r['passed']][:25]:print(row['id'],row['group'],row['failures'])
