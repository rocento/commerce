"""Evaluate the frozen corpus through real Node parsing and Python shopping admission."""
import argparse
import asyncio
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
sys.path[:0]=[str(ROOT/'commerce-assistant-platform'),str(ROOT/'commerce-assistant-platform/tests')]
from app.commerce_action_engine.application.context import TurnContext
from app.commerce_action_engine.application.interpretation import (
 interpret_resolution,
 shopping_plan,
)
from app.commerce_action_engine.contracts.action import ActorContext
from app.commerce_action_engine.execution.language import gate

# Explicit synthetic evaluation identity; this runner never executes commerce.
EVALUATION_ID = "00000000-0000-0000-0000-000000000001"
EVALUATION_CONTEXT = TurnContext(actor=ActorContext(tenant_id=EVALUATION_ID, store_id=EVALUATION_ID, session_id=EVALUATION_ID, request_id=EVALUATION_ID, channel="evaluation"))


def norm(text):
 return ' '.join(w[:-1] if w.endswith('s') and not w.endswith('ss') else w for w in str(text).lower().replace('_',' ').split())
def evaluate(case,raw):
 problems=[];expected=case['expected'];message=case['messages'][-1]
 resolution=gate.Resolution.model_validate(raw);decision=interpret_resolution(resolution,EVALUATION_CONTEXT);route=decision.route
 try:plan=shopping_plan(decision.result,message)
 except Exception as e:plan=None;problems.append('plan exception: '+str(e))
 data=plan.model_dump(mode='json') if plan else None
 if expected.get('guard'):
  if route=='search' and plan and not plan.clarification:problems.append('unsupported claim was admitted without clarification')
  if route in {'cart','order','reorder'}:problems.append('recommendation became a mutation route')
 else:
  wanted=expected.get('route','search')
  if route!=wanted:problems.append('route '+route+' expected '+wanted)
  if wanted=='search':
   if not plan or plan.clarification:problems.append('no executable search plan')
   else:
    if 'product' in expected and norm(expected['product']) not in {norm(plan.query),norm(plan.category)}:problems.append('product not preserved: '+str((plan.query,plan.category)))
    if 'purpose' in expected and norm(plan.intended_use)!=norm(expected['purpose']):problems.append('purpose not preserved: '+str(plan.intended_use))
    for key in ['max_price','exclusive_max','currency','sort_by','in_stock']:
     if key in expected:
      actual=getattr(plan,key)
      if key=='max_price':actual=float(actual) if actual is not None else None
      if actual!=expected[key]:problems.append(key+' not preserved: '+str(actual))
    if 'attribute' in expected:
     key,value=expected['attribute'];values={norm(c.name):norm(c.value) for c in plan.attributes}
     if values.get(key)!=norm(value):problems.append('attribute not preserved: '+str(values))
    if 'followup' in expected and expected['followup']!='browse' and resolution.entities.get('recommendationFollowup')!=expected['followup']:problems.append('follow-up relation not preserved')
 return dict(id=case['id'],group=case['group'],split=case['split'],text=case['messages'][-1],route=route,intent=resolution.intent,status=resolution.status,plan=data,passed=not problems,failures=problems)

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--label',required=True);args=parser.parse_args()
 folder=ROOT/'commerce-docs/platform/qa/recommendations-1000';cases=[json.loads(s) for s in (folder/'cases.jsonl').read_text().splitlines()]
 output=subprocess.run(['node',str(ROOT/'commerce-ops/scripts/shopping_eval/engine-worker.mjs'),str(folder/'cases.jsonl')],check=True,capture_output=True,text=True)
 (folder/(args.label+'-raw.jsonl')).write_text(output.stdout)
 raw=[json.loads(s) for s in output.stdout.splitlines()];results=[evaluate(case,row['turns'][-1]['result']) for case,row in zip(cases,raw,strict=True)]
 (folder/(args.label+'-results.json')).write_text(json.dumps(results,indent=2)+'\n')
 summary={group:{'passed':sum(r['passed'] for r in results if r['group']==group),'total':sum(r['group']==group for r in results)} for group in sorted({r['group'] for r in results})}
 print(json.dumps(summary,indent=2));print('TOTAL',sum(r['passed'] for r in results),len(results))
 for group in summary:
  bad=[r for r in results if r['group']==group and not r['passed']]
  for row in bad[:5]:print(group,row['text'],row['failures'])
if __name__=='__main__':main()
