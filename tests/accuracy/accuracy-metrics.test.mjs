import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareAccuracyReports,
  evaluateCase,
  matchByOnset,
} from '../../scripts/accuracy-audio.mjs';

const reference = (timestamp, midi, length = 200) => ({
  id: 0,
  timestamp,
  length,
  midi,
});

const played = (startMs, midi, endMs = startMs + 200) => ({
  startMs,
  endMs,
  midi,
  hz: 440 * (2 ** ((midi - 69) / 12)),
});

test('matches exact ordered notes and reports perfect strict accuracy', () => {
  const references = [reference(100, 40), reference(500, 45)];
  const playedNotes = [played(100, 40), played(500, 45)];
  const metrics = evaluateCase(references, playedNotes, 100);

  assert.equal(metrics.event.f1, 1);
  assert.equal(metrics.strictNote.f1, 1);
  assert.equal(metrics.matchedPitch.midiAccuracy, 1);
  assert.equal(metrics.timing.absoluteOnsetErrorMs.mean, 0);
});

test('separates onset matching from MIDI accuracy', () => {
  const metrics = evaluateCase(
    [reference(100, 40)],
    [played(105, 52, 305)],
    100,
  );

  assert.equal(metrics.event.f1, 1);
  assert.equal(metrics.strictNote.f1, 0);
  assert.equal(metrics.matchedPitch.midiAccuracy, 0);
  assert.equal(metrics.counts.octaveErrors, 1);
});

test('counts a split detection as an extra played note', () => {
  const metrics = evaluateCase(
    [reference(100, 40, 400)],
    [
      played(100, 40, 250),
      played(250, 40, 500),
    ],
    100,
  );

  assert.equal(metrics.counts.onsetMatched, 1);
  assert.equal(metrics.counts.eventFalsePositive, 1);
  assert.equal(metrics.event.precision, 0.5);
  assert.equal(metrics.event.recall, 1);
  assert.equal(metrics.event.f1, 2 / 3);
});

test('ordered matcher maximizes matches before minimizing onset error', () => {
  const matches = matchByOnset(
    [reference(100, 40), reference(200, 42)],
    [played(95, 40), played(205, 42)],
    110,
  );

  assert.deepEqual(matches, [
    { referenceIndex: 0, playedIndex: 0 },
    { referenceIndex: 1, playedIndex: 1 },
  ]);
});

test('baseline comparison passes identical reports and rejects per-case pitch loss', () => {
  const perfectMetrics = evaluateCase(
    [reference(100, 40)],
    [played(100, 40)],
    100,
  );
  const baseline = {
    results: [{ name: 'case', metrics: perfectMetrics }],
    aggregate: {
      ...perfectMetrics,
      counts: { ...perfectMetrics.counts },
    },
  };
  const identical = structuredClone(baseline);
  assert.equal(compareAccuracyReports(baseline, identical).passed, true);

  const regressed = structuredClone(baseline);
  regressed.results[0].metrics.counts.midiCorrect = 0;
  regressed.results[0].metrics.strictNote.f1 = 0;
  regressed.aggregate.counts.midiCorrect = 0;
  regressed.aggregate.strictNote.f1 = 0;
  regressed.aggregate.matchedPitch.midiAccuracy = 0;
  assert.equal(compareAccuracyReports(baseline, regressed).passed, false);
});
