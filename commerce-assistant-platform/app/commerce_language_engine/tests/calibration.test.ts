import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyCalibration,calibrationForIntent,calibrationMetrics,confusionMatrix,fitIsotonic} from '../src/calibration.ts';

test('isotonic fit is monotonic and improves a deliberately overconfident heldout-style sample',()=>{
 const samples=[0.2,0.3,0.4,0.7,0.8,0.9].map(confidence=>({confidence,correct:confidence<0.5}));
 const fitted=fitIsotonic(samples),calibration={scopeKind:'INTENT_FAMILY',scopeCode:'Shopping',dictionaryVersion:7,method:'ISOTONIC',parameters:fitted,sampleCount:samples.length,metrics:{}};
 const predictions=[0.2,0.3,0.4,0.7,0.8,0.9].map(value=>applyCalibration(value,calibration));
 assert.ok(predictions.every((value,index)=>index===0||value>=predictions[index-1]!));
 assert.ok(calibrationMetrics(samples.map(s=>({...s,confidence:applyCalibration(s.confidence,calibration)}))).brierScore<calibrationMetrics(samples).brierScore);
});

test('Platt and temperature calibrators clamp output safely',()=>{
 const base={scopeKind:'GLOBAL',scopeCode:'*',dictionaryVersion:2,sampleCount:0,metrics:{}};
 assert.ok(applyCalibration(0.9,{...base,method:'PLATT',parameters:{a:2,b:-2}})<0.5);
 assert.ok(applyCalibration(0.9,{...base,method:'TEMPERATURE',parameters:{temperature:4}})<0.9);
 assert.equal(applyCalibration(0.9,{...base,method:'TEMPERATURE',parameters:{temperature:0}}),0.9);
});

test('calibration selection is dictionary-version scoped and prefers intent to family',()=>{
 const rows=[
  {scopeKind:'INTENT_FAMILY',scopeCode:'Shopping',dictionaryVersion:3,method:'IDENTITY',parameters:{},sampleCount:20,metrics:{}},
  {scopeKind:'INTENT',scopeCode:'ADD_TO_CART',dictionaryVersion:3,method:'PLATT',parameters:{a:1,b:0},sampleCount:20,metrics:{}},
  {scopeKind:'INTENT',scopeCode:'ADD_TO_CART',dictionaryVersion:2,method:'PLATT',parameters:{a:1,b:0},sampleCount:20,metrics:{}},
 ];
 assert.equal(calibrationForIntent(rows,'ADD_TO_CART',3,'Shopping'),rows[1]);
 assert.equal(calibrationForIntent(rows,'VIEW_CART',3,'Shopping'),rows[0]);
 assert.equal(calibrationForIntent(rows,'VIEW_CART',4,'Shopping'),undefined);
});

test('runtime calibration is explicitly gated to diagnostic-only artifacts',async()=>{
 const {promotionBlockers}=await import('../src/artifact-promotion.ts');
 const artifact={dictionaryVersion:7,generationFingerprint:'synthetic',runtimePromotion:'DISABLED',provenance:{source:'generated-corpus',sampleCount:10000},evaluationGate:{passed:false,brierScoreRegressed:true}};
 const blockers=promotionBlockers(artifact,{dictionaryVersion:7,generationFingerprint:'synthetic'},['CREATE_ORDER']);
 assert.ok(blockers.includes('artifact_explicitly_disabled'));
 assert.ok(blockers.includes('heldout_calibration_gate_failed'));
 assert.ok(blockers.includes('insufficient_production_feedback'));
 assert.ok(blockers.includes('critical_precision_gate_failed:CREATE_ORDER'));
});

test('artifact promotion requires production samples and critical-intent precision',async()=>{
 const {promotionBlockers}=await import('../src/artifact-promotion.ts');
 const candidate={dictionaryVersion:8,generationFingerprint:'prod-fingerprint',runtimePromotion:'CANDIDATE',provenance:{source:'production-feedback',sampleCount:1200},evaluationGate:{passed:true,brierScoreRegressed:false},criticalIntentPrecision:{CREATE_ORDER:{precision:0.995,samples:125},CHECKOUT:{precision:0.992,samples:140},CANCEL_ORDER:{precision:0.99,samples:100}}};
 assert.deepEqual(promotionBlockers(candidate,{dictionaryVersion:8,generationFingerprint:'prod-fingerprint'},['CREATE_ORDER','CHECKOUT','CANCEL_ORDER']),[]);
});

test('reliability metrics and confusion matrix account for abstentions',()=>{
 const metrics=calibrationMetrics([{confidence:0.9,correct:true},{confidence:0.8,correct:false}],2);
 assert.equal(metrics.count,2);assert.ok(Math.abs(metrics.brierScore-0.325)<1e-12);assert.ok(Math.abs(metrics.expectedCalibrationError-0.35)<1e-12);
 const confusion=confusionMatrix([{expected:'BUY',predicted:'BUY'},{expected:'BUY',predicted:null},{expected:null,predicted:'BUY'}]);
 assert.equal(confusion.matrix.BUY.BUY,1);assert.equal(confusion.matrix.BUY['<ABSTAIN>'],1);assert.equal(confusion.byIntent.BUY.precision,0.5);
});
