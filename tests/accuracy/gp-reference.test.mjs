import assert from 'node:assert/strict';
import test from 'node:test';
import * as alphaTab from '@coderline/alphatab';
import {
  extractTrackReferenceNotes,
  parseFixtureFilename,
  sliceReferenceNotes,
} from '../../scripts/gp-reference.mjs';

test('parses the song, track, score offset, and take from a fixture filename', () => {
  assert.deepEqual(
    parseFixtureFilename(
      'tests/data/Ozzy Osbourne-Crazy Train.gp__tr-5__start-2850__2.wav',
    ),
    {
      songFileName: 'Ozzy Osbourne-Crazy Train.gp',
      trackIndex: 5,
      startMs: 2850,
      takeIndex: 2,
    },
  );
  assert.equal(parseFixtureFilename('plain.wav'), null);
});

test('extracts score notes on the AlphaTab playback timeline', () => {
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(
    String.raw`\tempo 120 . 0.6.4 2.6.4`,
  );
  const notes = extractTrackReferenceNotes(score, 0);

  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((note) => note.midi),
    [40, 42],
  );
  assert.ok(Math.abs(notes[0].timestamp) < 0.001);
  assert.ok(Math.abs(notes[0].length - 500) < 0.001);
  assert.ok(Math.abs(notes[1].timestamp - 500) < 0.001);
  assert.ok(Math.abs(notes[1].length - 500) < 0.001);
});

test('slices references into recording-local time and clamps the final note', () => {
  const notes = [
    { id: 0, timestamp: 1000, length: 400, midi: 40 },
    { id: 1, timestamp: 1500, length: 800, midi: 42 },
    { id: 2, timestamp: 2500, length: 300, midi: 44 },
  ];

  assert.deepEqual(sliceReferenceNotes(notes, 1000, 1000), [
    { id: 0, timestamp: 0, length: 400, midi: 40 },
    { id: 1, timestamp: 500, length: 500, midi: 42 },
  ]);
});
