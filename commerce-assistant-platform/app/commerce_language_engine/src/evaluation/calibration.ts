/** Offline diagnostics only. Expected labels never select a calibrator. */
import {applyCalibration, calibrationForIntent, calibrationMetrics, confusionMatrix, fitIsotonic} from '../calibration.ts';
import type {ConfidenceCalibration} from '../types.ts';

export type Prediction = {expected:string|null; predicted:string|null; confidence:number};

export function evaluateCalibration(
  development:Prediction[], heldout:Prediction[], families:ReadonlyMap<string,string>,
  dictionaryVersion:number, minimumSamples:number,
) {
  const familyOf = (intent:string) => families.get(intent) ?? 'OTHER_KNOWN';
  const calibrations:ConfidenceCalibration[] = [];
  const predictedFamilies = [...new Set(development.flatMap(r => r.predicted ? [familyOf(r.predicted)] : []))].sort();
  for (const family of predictedFamilies) {
    // Abstentions have no predicted-intent confidence. Report them separately,
    // rather than fitting them to the expected family's calibration curve.
    const samples = development.filter(r => r.predicted && familyOf(r.predicted) === family)
      .map(r => ({confidence:r.confidence, correct:r.predicted === r.expected}));
    if (samples.length < minimumSamples) continue;
    const calibration:ConfidenceCalibration = {
      scopeKind:'INTENT_FAMILY', scopeCode:family, dictionaryVersion,
      method:'ISOTONIC', parameters:fitIsotonic(samples), sampleCount:samples.length, metrics:{},
    };
    const before = calibrationMetrics(samples);
    const after = calibrationMetrics(samples.map(s => ({...s, confidence:applyCalibration(s.confidence, calibration)})));
    calibration.metrics = {developmentBrierBefore:before.brierScore, developmentBrierAfter:after.brierScore,
      developmentECEBefore:before.expectedCalibrationError, developmentECEAfter:after.expectedCalibrationError};
    calibrations.push(calibration);
  }
  const evaluated = heldout.filter(r => r.predicted !== null).map(row => {
    const family = familyOf(row.predicted!);
    const calibration = calibrationForIntent(calibrations, row.predicted!, dictionaryVersion, family);
    return {...row, family, calibrationApplied:!!calibration, calibrated:applyCalibration(row.confidence, calibration)};
  });
  const metrics = (rows:typeof evaluated) => ({
    raw:calibrationMetrics(rows.map(r => ({confidence:r.confidence, correct:r.predicted === r.expected}))),
    calibrated:calibrationMetrics(rows.map(r => ({confidence:r.calibrated, correct:r.predicted === r.expected}))),
  });
  const summarizeAbstentions = (rows:Prediction[]) => ({
    count:rows.filter(r => r.predicted === null).length,
    expectedUnknown:rows.filter(r => r.predicted === null && r.expected === null).length,
    missedKnown:rows.filter(r => r.predicted === null && r.expected !== null).length,
  });
  return {
    calibrations, evaluated,
    heldout:{...metrics(evaluated), confusion:confusionMatrix(heldout),
      byPredictedFamily:Object.fromEntries([...new Set(evaluated.map(r => r.family))].sort().map(family => {
        const rows = evaluated.filter(r => r.family === family);
        return [family, {count:rows.length, calibrationApplied:rows.some(r => r.calibrationApplied), ...metrics(rows)}];
      }))},
    abstentions:{development:summarizeAbstentions(development), heldout:summarizeAbstentions(heldout)},
  };
}
