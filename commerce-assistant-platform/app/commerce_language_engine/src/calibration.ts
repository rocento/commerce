import type {ConfidenceCalibration} from './types.ts';

export type CalibrationSample={confidence:number;correct:boolean};
export type ReliabilityBin={lower:number;upper:number;count:number;meanConfidence:number;accuracy:number};
export type CalibrationMetrics={count:number;brierScore:number;expectedCalibrationError:number;reliability:ReliabilityBin[]};
const clamp=(n:number)=>Math.max(0,Math.min(1,n));

export function calibrationForIntent(calibrations:ConfidenceCalibration[]|undefined,intent:string|undefined,dictionaryVersion:number,family?:string):ConfidenceCalibration|undefined {
 if(!calibrations||!intent)return undefined;
 const eligible=calibrations.filter(c=>c.dictionaryVersion===dictionaryVersion);
 return eligible.find(c=>c.scopeKind==='INTENT'&&c.scopeCode===intent)
  ??(family?eligible.find(c=>c.scopeKind==='INTENT_FAMILY'&&c.scopeCode===family):undefined)
  ??eligible.find(c=>c.scopeKind==='GLOBAL'&&c.scopeCode==='*');
}

export function applyCalibration(raw:number,calibration?:ConfidenceCalibration):number {
 const p=clamp(raw);if(!calibration||calibration.method==='IDENTITY'||calibration.method==='CUSTOM')return p;
 const parameters=calibration.parameters;
 if(calibration.method==='PLATT'){
  const a=Number(parameters.a),b=Number(parameters.b);if(!Number.isFinite(a)||!Number.isFinite(b))return p;
  const x=Math.max(-35,Math.min(35,a*p+b));return 1/(1+Math.exp(-x));
 }
 if(calibration.method==='TEMPERATURE'){
  const temperature=Number(parameters.temperature);if(!Number.isFinite(temperature)||temperature<=0)return p;
  const logit=Math.log(Math.max(1e-7,p)/Math.max(1e-7,1-p));return 1/(1+Math.exp(-Math.max(-35,Math.min(35,logit/temperature))));
 }
 if(calibration.method==='ISOTONIC'){
  const knots=parameters.knots;
  if(!Array.isArray(knots)||!knots.length)return p;
  let previous=0;
  for(const knot of knots){
   if(!knot||typeof knot!=='object')return p;
   const x=Number((knot as Record<string,unknown>).x),y=Number((knot as Record<string,unknown>).y);
   if(!Number.isFinite(x)||!Number.isFinite(y)||x<previous||y<0||y>1)return p;
   previous=x;
  }
  const first=knots[0] as {x:number;y:number};if(p<=first.x)return clamp(first.y);
  for(let i=1;i<knots.length;i++){
   const left=knots[i-1] as {x:number;y:number},right=knots[i] as {x:number;y:number};
   if(p<=right.x){const span=right.x-left.x;return clamp(span===0?right.y:left.y+(right.y-left.y)*(p-left.x)/span);}
  }
  return clamp((knots.at(-1) as {y:number}).y);
 }
 return p;
}

export function calibrationMetrics(samples:CalibrationSample[],bins=10):CalibrationMetrics {
 if(!Number.isInteger(bins)||bins<1)throw new Error('bins must be a positive integer');
 const buckets=Array.from({length:bins},()=>({count:0,confidence:0,correct:0}));let brier=0;
 for(const sample of samples){
  if(!Number.isFinite(sample.confidence)||sample.confidence<0||sample.confidence>1)throw new Error('confidence must be between 0 and 1');
  const target=Number(sample.correct);brier+=(sample.confidence-target)**2;
  const index=Math.min(bins-1,Math.floor(sample.confidence*bins)),bucket=buckets[index]!;bucket.count++;bucket.confidence+=sample.confidence;bucket.correct+=target;
 }
 const reliability=buckets.flatMap((bucket,index)=>bucket.count?[{lower:index/bins,upper:(index+1)/bins,count:bucket.count,meanConfidence:bucket.confidence/bucket.count,accuracy:bucket.correct/bucket.count}]:[]);
 const ece=reliability.reduce((sum,bin)=>sum+bin.count/samples.length*Math.abs(bin.meanConfidence-bin.accuracy),0);
 return {count:samples.length,brierScore:samples.length?brier/samples.length:0,expectedCalibrationError:samples.length?ece:0,reliability};
}

// Pool-adjacent-violators isotonic fit. Weighted block means make the curve monotonic.
export function fitIsotonic(samples:CalibrationSample[]):{knots:{x:number;y:number}[];sampleCount:number} {
 const sorted=[...samples].sort((a,b)=>a.confidence-b.confidence),blocks:{min:number;max:number;sum:number;count:number}[]=[];
 for(const sample of sorted){
  if(!Number.isFinite(sample.confidence)||sample.confidence<0||sample.confidence>1)throw new Error('confidence must be between 0 and 1');
  blocks.push({min:sample.confidence,max:sample.confidence,sum:Number(sample.correct),count:1});
  while(blocks.length>1){const right=blocks.at(-1)!,left=blocks.at(-2)!;if(left.sum/left.count<=right.sum/right.count)break;
   blocks.splice(-2,2,{min:left.min,max:right.max,sum:left.sum+right.sum,count:left.count+right.count});
  }
 }
 return {knots:blocks.map(b=>({x:(b.min+b.max)/2,y:b.sum/b.count})),sampleCount:samples.length};
}

export function confusionMatrix(rows:{expected:string|null;predicted:string|null}[]) {
 const labels=[...new Set(rows.flatMap(r=>[r.expected??'<ABSTAIN>',r.predicted??'<ABSTAIN>']))].sort();
 const matrix=Object.fromEntries(labels.map(label=>[label,Object.fromEntries(labels.map(other=>[other,0]))]));
 for(const row of rows)matrix[row.expected??'<ABSTAIN>']![row.predicted??'<ABSTAIN>']++;
 const byIntent=Object.fromEntries(labels.map(label=>{
  const tp=matrix[label]![label]!,support=Object.values(matrix[label]!).reduce((a,b)=>a+b,0),predicted=labels.reduce((n,actual)=>n+matrix[actual]![label]!,0),precision=predicted?tp/predicted:0,recall=support?tp/support:0;
  return [label,{support,predicted,precision,recall,f1:precision+recall?2*precision*recall/(precision+recall):0}];
 }));
 return {labels,matrix,byIntent};
}
