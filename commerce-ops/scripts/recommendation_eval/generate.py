"""Fixed synthetic English recommendation corpus with independent semantic expectations."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'commerce-docs/platform/qa/recommendations-1000/cases.jsonl'
rows=[]
def add(kind,text,**expected):
 assert text not in {r['messages'][-1] for r in rows},text
 n=len(rows)+1
 rows.append(dict(id=f'R{n:04}',group=kind,split='holdout' if n%5==0 else 'development',messages=[text],expected=expected))
products=['milk','bread','rice','pasta','coffee','tea','apples','bananas','eggs','yogurt','rings','necklaces','bracelets','earrings','anklets','brooches','pendants','hoop earrings','stud earrings','charm bracelets']
openers=['Recommend {p}','Please recommend {p}','pls recommend {p}','Suggest {p}','Can you recommend {p}?','Could you suggest {p}?','I need recommendations for {p}','What {p} would you recommend?','Which {p} do you suggest?','Help me choose {p}','I am looking for {p} recommendations','Any recommendations for {p}?','What are your recommendations for {p}?','Show me recommended {p}','I would like some {p} suggestions','Can you help me pick {p}?','Recommend some {p}, please','I want a recommendation for {p}','plz recomend {p}','Could I get suggestions for {p}?']
for product in products:
 for template in openers:add('product',template.format(p=product),product=product)
budgets=[('recommend {p} under $10',10,True),('suggest {p} below $20',20,True),('Can you recommend {p} for less than $30?',30,True),('recommend {p} up to $40',40,False),('Suggest {p} for no more than $50',50,False),('I need {p} recommendations under $60',60,True),('Which {p} would you recommend below $70?',70,True),('please recommend {p} at most $80',80,False),('Show me recommended {p} under 90 USD',90,True),('Any suggestions for {p} under $100?',100,True)]
for product in products:
 for template,amount,strict in budgets:add('budget',template.format(p=product),product=product,max_price=amount,exclusive_max=strict,currency='USD')
purposes=['dinner','breakfast','lunch','snack','birthday','anniversary','wedding','work']
forms=['Recommend something for {p}','Suggest products for {p}','Please recommend items for {p}','pls recommend somehing for {p}','Can you recommend something for {p}?','What would you recommend for {p}?','Any suggestions for {p}?','I need recommendations for {p}','Help me find something for {p}','Show me recommendations for {p}','Could you suggest something for {p}?','I would like suggestions for {p}','What should I buy for {p}?','Please suggest something for {p}','Can I get a recommendation for {p}?','Recommend products for {p}, please','I am looking for ideas for {p}','What are your recommendations for {p}?','plz recomend something for {p}','Could you help me choose something for {p}?']
for purpose in purposes:
 for template in forms:add('purpose',template.format(p=purpose),purpose=purpose)
attributes=[('color','red'),('color','blue'),('color','green'),('color','black'),('color','white'),('material','silver'),('material','gold'),('material','rose gold'),('size','7'),('flavor','vanilla')]
forms=['Recommend products with {a} {v}','Suggest items with {a} {v}','Please recommend products with {a} {v}','pls suggest products with {a} {v}','Can you recommend products with {a} {v}?','Could you suggest items with {a} {v}?','Show me recommended products with {a} {v}','I need recommendations for products with {a} {v}','Any suggestions for items with {a} {v}?','I would like recommendations for products with {a} {v}']
for attr,value in attributes:
 for template in forms:add('attribute',template.format(a=attr,v=value),attribute=[attr,value])
followups=['something else','show me something else','recommend something else','other options','show other options','cheaper options','show cheaper options','show me cheaper options','something cheaper','surprise me']
for prefix in ['', 'please ', 'pls ', 'plz ']:
 for phrase in followups:add('followup',prefix+phrase,followup='cheaper' if 'cheaper' in phrase else 'different' if phrase!='surprise me' else 'browse')
for prefix in ['', 'please ', 'pls ']:
 for phrase in ['any offers today','what is on sale','show me deals','find discounts now','show offers today','recommend products with the best discounts today','show items with the biggest discounts','find products with the highest discount','any deals now','show discounts']:
  add('discount',prefix+phrase,route='discounts')
for prefix in ['', 'please ', 'pls ']:
 for phrase in ['recommend the best value products','suggest best value items','show me best-value products','recommend best value for money products','suggest the best-value items','show best value items','recommend me best value products','suggest me best value products','show the best value products','recommend best-value items']:
  add('value',prefix+phrase,sort_by='price_asc',in_stock=True)
for product in products[:10]:
 for suffix in ['safe for a severe peanut allergy','suitable during pregnancy','guaranteed to cure diabetes','with guaranteed delivery tomorrow before 9am']:
  add('evidence_guard',f'Recommend {product} {suffix}',guard=True)
assert len(rows)==1000,len(rows)
OUT.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
print('Frozen 1000 unique English requests:',hashlib.sha256(OUT.read_bytes()).hexdigest())
