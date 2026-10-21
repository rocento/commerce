import {createHash} from 'node:crypto';

/** Evaluation-only labels. These are not vocabulary, production rules, or training data. */
export type ShopperCase={case_id:string;store:string;family_id:string;scenario_family:string;turns:string[];budget:number|null;target_product_name:string|null;quantity?:number;expected:string};
export type CsvRow=Record<string,string>;
export type EvaluationResult={status:string;intent:string|null;entities:Record<string,any>;context?:{next?:Record<string,any>};missing?:string[];clarificationQuestion?:string;message?:string};
export type Check={code:string;passed:boolean;expected:unknown;actual:unknown};
export const rubricVersion='shopper-language-semantics-v3';
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** RFC 4180 quoting, embedded newlines, CRLF and a UTF-8 BOM. */
export function parseCsv(input:string):CsvRow[]{
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 const text=input.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const char=text[i];
  if(quoted){if(char==='"'&&text[i+1]==='"'){field+='"';i++;}else if(char==='"')quoted=false;else field+=char;continue;}
  if(char==='"'){if(field)throw new Error('Unexpected quote in CSV field');quoted=true;}
  else if(char===','){row.push(field);field='';}
  else if(char==='\n'||char==='\r'){if(char==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))rows.push(row);row=[];field='';}
  else field+=char;
 }
 if(quoted)throw new Error('Unterminated quoted CSV field');
 if(field||row.length){row.push(field);rows.push(row);}
 const [header,...body]=rows;if(!header?.length)throw new Error('Empty CSV');
 if(new Set(header).size!==header.length)throw new Error('Duplicate CSV column');
 return body.map((cells,index)=>{if(cells.length!==header.length)throw new Error(`CSV row ${index+2} has ${cells.length} columns; expected ${header.length}`);return Object.fromEntries(header.map((key,i)=>[key,cells[i]]));});
}

export function selectCases(csv:CsvRow[],source:ShopperCase[]):ShopperCase[]{
 const byId=new Map(source.map(row=>[row.case_id,row]));const seen=new Set<string>();
 return csv.map(row=>{
  if(seen.has(row.case_id))throw new Error(`Duplicate CSV case ${row.case_id}`);seen.add(row.case_id);
  const item=byId.get(row.case_id);if(!item)throw new Error(`Missing source metadata for ${row.case_id}`);
  const turns=row.user_questions.split(/(?:^|\n\n)Turn \d+: /).slice(1);
  if(JSON.stringify(turns)!==JSON.stringify(item.turns)||turns.length!==Number(row.turn_count))throw new Error(`CSV/source turn mismatch for ${row.case_id}`);
  if(item.store!==row.demo||item.family_id!==row.family_id||item.scenario_family!==row.scenario_family)throw new Error(`CSV/source label mismatch for ${row.case_id}`);
  return {...item,turns};
 });
}

const SEARCH=['PRODUCT_SEARCH','PRODUCT_RECOMMEND'];
const DELIVERY=['CHECK_DELIVERY','DELIVERY_TIME','DELIVERY_DATE','DELIVERY_AREA'];
const CATALOG:Record<string,string[]>={
 '01':['PRODUCT_SEARCH'],'02':['CHECK_PRICE'],'03':['CHECK_STOCK'],'04':['PRODUCT_DETAILS'],
 '05':['PRODUCT_COMPARE'],'06':['PRODUCT_ALTERNATIVE','COMPARE_PRICE','UNIT_PRICE'],
 '07':['CHECK_PRICE'],'08':['RETURN_POLICY'],'09':['ADD_TO_CART'],'10':['ADD_TO_WISHLIST'],
};
/** Labels follow the original generator's 80 independent task rubrics, not engine output. */
const FAMILIES:Record<string,string[][]>={
 grocery:[SEARCH,SEARCH,SEARCH,[...SEARCH,'PRODUCT_ALLERGENS','PRODUCT_SAFETY'],SEARCH,['PRODUCT_ALTERNATIVE',...SEARCH],SEARCH,['PRODUCT_STORAGE','PRODUCT_SHELF_LIFE'],['PRODUCT_NUTRITION',...SEARCH],['UNIT_PRICE','COMPARE_PRICE',...SEARCH],SEARCH,SEARCH,SEARCH,SEARCH,DELIVERY,['RETURN_POLICY'],SEARCH,['PRODUCT_ATTRIBUTE','PRODUCT_DETAILS',...SEARCH],['CHECK_STOCK','PRODUCT_ALTERNATIVE',...SEARCH],SEARCH],
 jewelry:[SEARCH,['PRODUCT_SIZE_GUIDE'],['PRODUCT_MATERIAL','PRODUCT_ALLERGENS','PRODUCT_SAFETY',...SEARCH],['PRODUCT_MATERIAL','PRODUCT_COMPARE',...SEARCH],SEARCH,['PRODUCT_ATTRIBUTE','PRODUCT_CARE',...SEARCH],['PRODUCT_AUTHENTICITY','PRODUCT_CERTIFICATION'],['PRODUCT_COMPARE','PRODUCT_MATERIAL','PRODUCT_CARE'],['PRODUCT_ATTRIBUTE','PRODUCT_DETAILS'],DELIVERY,['RETURN_POLICY'],SEARCH,['PRODUCT_SIMILAR',...SEARCH],['PRODUCT_CARE'],SEARCH,SEARCH,SEARCH,['PRODUCT_ORIGIN','PRODUCT_CERTIFICATION'],SEARCH,SEARCH],
 electronics:[SEARCH,['PRODUCT_COMPATIBILITY',...SEARCH],['PRODUCT_COMPARE',...SEARCH],SEARCH,SEARCH,['PRODUCT_BATTERY_LIFE',...SEARCH],['PRODUCT_COMPARE','PRODUCT_ALTERNATIVE','COMPARE_PRICE',...SEARCH],['PRODUCT_COMPATIBILITY'],['PRODUCT_STORAGE_CAPACITY'],['PRODUCT_ATTRIBUTE',...SEARCH],DELIVERY,['RETURN_POLICY'],['PRODUCT_WARRANTY'],SEARCH,SEARCH,SEARCH,SEARCH,['PRODUCT_SPARE_PARTS','PRODUCT_CARE','PRODUCT_ALTERNATIVE'],['PRODUCT_SPARE_PARTS','CHECK_STOCK',...SEARCH],['PRODUCT_COMPARE',...SEARCH]],
 pharmacy:[['PRODUCT_USAGE',...SEARCH],['PRODUCT_INGREDIENTS','PRODUCT_SAFETY',...SEARCH],['PRODUCT_INGREDIENTS','PRODUCT_ALLERGENS'],SEARCH,['PRODUCT_COMPARE',...SEARCH],SEARCH,['PRODUCT_SAFETY'],['PRODUCT_SAFETY'],['PRODUCT_USAGE'],['PRODUCT_SAFETY','PRODUCT_USAGE'],['PRODUCT_COMPARE',...SEARCH],['PRODUCT_AUTHENTICITY','PRODUCT_CERTIFICATION'],['PRODUCT_EXPIRY'],[...DELIVERY,...SEARCH],['RETURN_POLICY'],SEARCH,SEARCH,['PRODUCT_SAFETY'],['CHECK_STOCK','PRODUCT_SAFETY',...SEARCH],['PRODUCT_USAGE',...SEARCH]],
};
export function expectedIntents(item:ShopperCase):string[]{
 const catalog=item.family_id.match(/-catalog-(\d+)$/);if(catalog)return CATALOG[catalog[1]]??[];
 return FAMILIES[item.store]?.[Number(item.family_id.split('-').at(-1))-1]??[];
}
const normalized=(value:string)=>value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const writes=new Set(['ADD_TO_CART','REMOVE_FROM_CART','CLEAR_CART','UPDATE_CART_QUANTITY','ADD_TO_WISHLIST','REMOVE_FROM_WISHLIST','CLEAR_WISHLIST','CREATE_ORDER','CANCEL_ORDER','REORDER','CHECKOUT','PLACE_ORDER','RETURN_ORDER','REFUND_ORDER','TRANSFER_TO_CART','TRANSFER_TO_WISHLIST']);
const relationValues=(result:EvaluationResult)=>result.entities.shoppingContext?.relations??[];
const entitiesText=(result:EvaluationResult)=>JSON.stringify(result.entities).toLowerCase();
const productArguments=(result:EvaluationResult)=>[result.entities.productText,...(result.entities.items??[]).map((item:any)=>item.productText),...(result.entities.products??[]).map((item:any)=>typeof item==='string'?item:item.productText)].filter((x):x is string=>typeof x==='string');
const targetName=(value:string)=>normalized(value).replace(/^(?:the|an|a) /,'');
const hasTarget=(result:EvaluationResult,target:string)=>productArguments(result).some(value=>targetName(value).includes(targetName(target)));
/** Independent equivalences from the original shopper prompts, not production knowledge. */
function purposeRetained(result:EvaluationResult,activity:string):boolean{
 const meanings=new Set<string>(relationValues(result).filter((relation:any)=>relation.relation==='intended_use').map((relation:any)=>normalized(relation.value)));
 if(meanings.has(activity))return true;
 if(activity==='working from home')return meanings.has('remote work');
 if(activity==='reading and video calls')return meanings.has('reading')&&meanings.has('video calls');
 if(activity==='drawing and design')return meanings.has('drawing')&&meanings.has('design');
 return false;
}

/** Minimum language semantics only: passing cannot certify factual advice or real product retrieval. */
export function evaluateTurn(item:ShopperCase,turnIndex:number,result:EvaluationResult,previous?:EvaluationResult):Check[]{
 const text=item.turns[turnIndex];const checks:Check[]=[];
 const add=(code:string,passed:boolean,expected:unknown,actual:unknown)=>checks.push({code,passed,expected,actual:actual??null});
 const catalog=item.family_id.match(/-catalog-(\d+)$/)?.[1];
 const allowedWrites=turnIndex===0&&catalog==='09'?['ADD_TO_CART']:turnIndex===0&&catalog==='10'?['ADD_TO_WISHLIST']:[];
 add('no_unrequested_write',!writes.has(result.intent??'')||allowedWrites.includes(result.intent!),allowedWrites,result.intent);
 const args=productArguments(result);
 add('no_response_style_as_product',!args.some(value=>/sensible options than a long list|what you cannot verify|practical starting point|tradeoffs|keep the answer short|explain why each suggestion|details i have not given/i.test(value)),'Product arguments exclude response-style instructions',args);
 add('no_unsegmented_question_as_product',!args.some(value=>/what (?:should|would|is|are)|where (?:should|do)|how (?:do|can)|please (?:give|ask|keep|explain)|my (?:limit|budget) is|budget (?:of|is)/i.test(value)),'Product arguments exclude question/budget clauses',args);
 if(turnIndex===0){
  const intents=expectedIntents(item);if(!intents.length)throw new Error(`Unlabeled family ${item.family_id}`);
  add('family_route',intents.includes(result.intent??'')&&['RESOLVED','NEEDS_CONTEXT','UNSUPPORTED'].includes(result.status),intents,{status:result.status,intent:result.intent});
  if(item.target_product_name){
   add('named_product_retained',hasTarget(result,item.target_product_name),item.target_product_name,args);
   if(catalog==='09'||catalog==='07')add('quantity_retained',(result.entities.quantity??result.entities.items?.[0]?.quantity)===item.quantity,item.quantity,result.entities.quantity??result.entities.items?.[0]?.quantity);
   if(catalog==='05'){
    const other=text.match(/ compare with (.+?)\?$/i)?.[1];
    if(other)add('comparison_second_product_retained',hasTarget(result,other),other,args);
   }
  }
  if(item.budget!==null){
   const price=result.entities.price;
   add('budget_value',price?.value===item.budget,item.budget,price?.value);
   add('budget_is_cap',['<','<='].includes(price?.operator),'Upper bound (< or <=), not equality',price?.operator);
   add('budget_currency',price?.currency==='USD','USD',price?.currency);
  }
  const recipient=text.match(/\bfor my (mother|partner|sister|friend|father|brother|daughter|son|grandmother|grandfather)\b/i)?.[1];
  if(recipient)add('recipient_relation',relationValues(result).some((r:any)=>r.relation==='recipient'&&normalized(r.value).includes(recipient.toLowerCase())),recipient,relationValues(result));
  const activities=['online classes','video editing','working from home','travel photography','gaming','reading and video calls','music production','university assignments','running a small business','drawing and design'];
  const activity=activities.find(value=>text.toLowerCase().includes('for '+value));
  if(activity)add('intended_use_relation',purposeRetained(result,activity),activity,relationValues(result));
  // The quantity of people is not the number of units to purchase.
  const people=text.match(/\bfor (\d+) (?:people|person|kids)\b/i);
  if(people)add('people_not_product_quantity',result.entities.quantity===undefined&&!(result.entities.items??[]).some((x:any)=>x.quantity!==undefined),'Headcount must not silently become product quantity',{quantity:result.entities.quantity,items:result.entities.items});
  if(item.family_id==='electronics-02'||item.family_id==='electronics-08')add('compatibility_requirement_retained',Boolean(result.entities.evidenceRequirements?.some((e:any)=>/compatibility/.test(e.kind))||relationValues(result).some((r:any)=>r.relation==='compatibility_target')||result.intent==='PRODUCT_COMPATIBILITY'&&args.length),'Compatibility target or evidence requirement',result.entities);
  if(item.family_id==='pharmacy-18')add('symptoms_not_shopping_search',!['PRODUCT_SEARCH','PRODUCT_RECOMMEND','ADD_TO_CART'].includes(result.intent??'')&&result.status!=='UNKNOWN','Recognize adverse symptoms without product search',{status:result.status,intent:result.intent});
  if(item.family_id==='pharmacy-07'||item.family_id==='pharmacy-08')add('safety_context_retained',result.intent==='PRODUCT_SAFETY'||/pregnan|pediatric|child/.test(entitiesText(result)),'Preserve pregnancy or child safety concern',result.entities);
  if(item.scenario_family==='allergy')add('allergy_context_retained',/allerg|nickel/.test(entitiesText(result))||result.intent==='PRODUCT_ALLERGENS','Preserve allergy evidence requirement',result.entities);
 }else{
  const budget=text.match(/Actually my budget is \$(\d+)/i);
  if(budget){
   add('budget_followup_value',result.entities.price?.value===Number(budget[1]),Number(budget[1]),result.entities.price);
   add('budget_followup_cap',['<','<='].includes(result.entities.price?.operator),'Upper bound (< or <=)',result.entities.price?.operator);
   add('budget_followup_currency',result.entities.price?.currency==='USD','USD',result.entities.price?.currency);
   const priorTargets=previous?productArguments(previous):[];
   if(priorTargets.length&&previous?.status==='RESOLVED')add('budget_followup_keeps_target',priorTargets.some(target=>hasTarget(result,target)),priorTargets,args);
   else add('budget_followup_needs_context',result.status==='NEEDS_CONTEXT'||Boolean(result.context?.next?.activeSearch),'Ask for unresolved product, or retain an active request',{status:result.status,next:result.context?.next});
  }else{
   const kind=/explain why/.test(text)?'explanation':/another option/.test(text)?'alternative':'clarification';
   const hasPrior=Boolean(previous?.context?.next?.activeSearch);
   // Requires explicit discourse interpretation or an appropriate semantic intent.
   // UNKNOWN and an unrelated generic product search never count as successful continuation.
   const roles=result.entities.shoppingContext?.sentenceRoles??[];
   const preferences=result.entities.shoppingContext?.responsePreferences??[];
   const matchingRole=roles.some((role:any)=>kind==='explanation'?/explain|reason/.test(role.role):kind==='alternative'?/alternative|another|reject/.test(role.role):/clarif|question/.test(role.role));
   // Existing engine contracts represent these explicit meanings as a generic
   // response_preference role plus a specific preference value, not a new intent.
   const matchingPreference=kind==='explanation'?preferences.includes('explain_fit'):kind==='clarification'?preferences.includes('one_question'):false;
   const matchingIntent=kind==='alternative'?result.intent==='PRODUCT_ALTERNATIVE':kind==='explanation'?result.intent==='EXPLAIN_RECOMMENDATION':result.intent==='CLARIFY_REQUEST';
   add('followup_discourse',matchingRole||matchingPreference||matchingIntent||!hasPrior&&result.status==='NEEDS_CONTEXT',{kind,requiresPriorContext:hasPrior},{status:result.status,intent:result.intent,roles,preferences});
  }
 }
 return checks;
}
