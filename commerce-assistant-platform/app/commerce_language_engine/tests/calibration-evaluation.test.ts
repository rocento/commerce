import './recognition-test-context.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCalibration} from '../src/evaluation/calibration.ts';

const families = new Map([['BUY','Shopping'], ['TRACK','Orders']]);
const development = [
  {expected:'TRACK', predicted:'BUY', confidence:0.9},
  {expected:'TRACK', predicted:'BUY', confidence:0.9},
  {expected:'TRACK', predicted:'TRACK', confidence:0.9},
  {expected:'TRACK', predicted:'TRACK', confidence:0.9},
];

test('cross-family errors use predicted family in fitting and held-out scoring', () => {
  const report = evaluateCalibration(development, [{expected:'TRACK', predicted:'BUY', confidence:0.9}], families, 8, 2);
  assert.equal(report.evaluated[0].family, 'Shopping');
  assert.equal(report.evaluated[0].calibrated, 0);
  assert.equal(report.heldout.calibrated.brierScore, 0);
  const other = evaluateCalibration(development, [{expected:'BUY', predicted:'BUY', confidence:0.9}], families, 8, 2);
  assert.equal(other.evaluated[0].calibrated, report.evaluated[0].calibrated);
  assert.equal(other.heldout.calibrated.brierScore, 1);
});

test('abstentions are separately counted and cannot contaminate calibration', () => {
  const abstentions = [{expected:'BUY', predicted:null, confidence:1}, {expected:null, predicted:null, confidence:0}];
  const report = evaluateCalibration([...development, ...abstentions], [...development, ...abstentions], families, 8, 2);
  assert.deepEqual(report.abstentions.heldout, {count:2, expectedUnknown:1, missedKnown:1});
  assert.deepEqual(report.abstentions.development, report.abstentions.heldout);
  assert.equal(report.heldout.raw.count, 4);
  assert.equal(report.calibrations.find(c => c.scopeCode === 'Shopping')?.sampleCount, 2);
  assert.equal(report.heldout.confusion.matrix.BUY['<ABSTAIN>'], 1);
});

test('missing or undersampled predicted families retain raw confidence', () => {
  const report = evaluateCalibration(development, [{expected:'BUY', predicted:'NEW', confidence:0.8}], families, 8, 3);
  assert.equal(report.calibrations.length, 0);
  assert.equal(report.evaluated[0].calibrationApplied, false);
  assert.equal(report.evaluated[0].calibrated, 0.8);
});
