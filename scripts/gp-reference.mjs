import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as alphaTab from '@coderline/alphatab';

const FIXTURE_FILENAME_PATTERN = /^(.*?)__tr-(\d+)__start-(\d+)__(\d+)\.wav$/i;

function printHelp() {
  console.log(`Disband Guitar Pro reference exporter

Usage:
  npm run accuracy:gp-reference -- --gp <path> --track <index> [options]

Options:
  --gp <path>           Guitar Pro file to read
  --track <index>       Zero-based AlphaTab track index
  --start-ms <value>    Score window start in milliseconds (default: 0)
  --duration-ms <value> Window duration in milliseconds (default: full score)
  --output <path>       Write reference-note JSON
  --json                Print only reference-note JSON
  --list-tracks         Print available tracks and exit
  --help                Show this help`);
}

function parseNonNegativeNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative number`);
  }
  return parsed;
}

function parseTrackIndex(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('--track must be a non-negative integer');
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    gpPath: null,
    trackIndex: null,
    startMs: 0,
    durationMs: null,
    output: null,
    json: false,
    listTracks: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--list-tracks') {
      options.listTracks = true;
      continue;
    }
    if (argument === '--gp' || argument === '--track' || argument === '--start-ms'
      || argument === '--duration-ms' || argument === '--output') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--gp') options.gpPath = path.resolve(value);
      if (argument === '--track') options.trackIndex = parseTrackIndex(value);
      if (argument === '--start-ms') {
        options.startMs = parseNonNegativeNumber(value, argument);
      }
      if (argument === '--duration-ms') {
        options.durationMs = parseNonNegativeNumber(value, argument);
      }
      if (argument === '--output') options.output = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!options.gpPath) throw new Error('--gp is required');
  if (!options.listTracks && options.trackIndex === null) {
    throw new Error('--track is required unless --list-tracks is used');
  }
  return options;
}

export function parseFixtureFilename(filePath) {
  const match = path.basename(filePath).match(FIXTURE_FILENAME_PATTERN);
  if (!match) return null;
  return {
    songFileName: match[1],
    trackIndex: Number(match[2]),
    startMs: Number(match[3]),
    takeIndex: Number(match[4]),
  };
}

export function readWavDurationMs(filePath) {
  const data = readFileSync(filePath);
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE file: ${filePath}`);
  }

  let byteRate = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const chunkId = data.toString('ascii', offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 12 && chunkDataOffset + 12 <= data.length) {
      byteRate = data.readUInt32LE(chunkDataOffset + 8);
    }
    if (chunkId === 'data') {
      dataSize = Math.min(chunkSize, Math.max(0, data.length - chunkDataOffset));
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (byteRate <= 0 || dataSize <= 0) {
    throw new Error(`WAV file is missing usable fmt/data chunks: ${filePath}`);
  }
  return dataSize * 1000 / byteRate;
}

export function loadGpScore(filePath) {
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(readFileSync(filePath));
}

export function listScoreTracks(score) {
  return score.tracks.map((track) => ({
    index: track.index,
    name: track.name,
    shortName: track.shortName,
    staves: track.staves.length,
    bars: track.staves[0]?.bars.length ?? 0,
  }));
}

function createPlaybackTimeline(score) {
  const midiFile = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile);
  const generator = new alphaTab.midi.MidiFileGenerator(
    score,
    new alphaTab.Settings(),
    handler,
  );
  generator.generate();

  const tempoEvents = midiFile.events
    .filter((event) => event instanceof alphaTab.midi.TempoChangeEvent)
    .map((event) => ({ tick: event.tick, bpm: event.beatsPerMinute }))
    .sort((left, right) => left.tick - right.tick);

  const segments = [];
  let previousTick = 0;
  let previousMs = 0;
  let bpm = score.tempo > 0 ? score.tempo : 120;

  for (const event of tempoEvents) {
    if (event.tick > previousTick) {
      previousMs += (event.tick - previousTick) * 60000 / (bpm * midiFile.division);
      previousTick = event.tick;
    }
    bpm = event.bpm;
    const previousSegment = segments.at(-1);
    if (previousSegment?.tick === event.tick) {
      previousSegment.ms = previousMs;
      previousSegment.bpm = bpm;
    } else {
      segments.push({ tick: event.tick, ms: previousMs, bpm });
    }
  }

  if (segments.length === 0 || segments[0].tick > 0) {
    segments.unshift({ tick: 0, ms: 0, bpm: score.tempo > 0 ? score.tempo : 120 });
  }

  const tickToMs = (tick) => {
    let low = 0;
    let high = segments.length - 1;
    let segmentIndex = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (segments[middle].tick <= tick) {
        segmentIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const segment = segments[segmentIndex];
    return segment.ms + (tick - segment.tick) * 60000 / (segment.bpm * midiFile.division);
  };

  return {
    masterBars: generator.tickLookup.masterBars,
    tickToMs,
  };
}

export function extractTrackReferenceNotes(score, trackIndex) {
  const track = score.tracks.find((candidate) => candidate.index === trackIndex);
  if (!track) {
    throw new Error(
      `Track ${trackIndex} does not exist. Available tracks: `
      + listScoreTracks(score).map((candidate) => candidate.index).join(', '),
    );
  }
  const staff = track.staves[0];
  if (!staff) throw new Error(`Track ${trackIndex} has no staff`);

  const { masterBars, tickToMs } = createPlaybackTimeline(score);
  const notes = [];

  for (const playbackBar of masterBars) {
    const bar = staff.bars.find((candidate) => candidate.masterBar === playbackBar.masterBar);
    if (!bar) continue;

    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest) continue;
        for (const note of beat.notes) {
          if (note.isTieDestination) continue;

          let durationTicks = beat.playbackDuration;
          let tiedNote = note.tieDestination;
          while (tiedNote) {
            durationTicks += tiedNote.beat.playbackDuration;
            tiedNote = tiedNote.tieDestination;
          }
          if (note.isStaccato) durationTicks /= 2;

          const startTick = playbackBar.start + beat.playbackStart;
          const timestamp = tickToMs(startTick);
          const endMs = tickToMs(startTick + durationTicks);
          notes.push({
            id: notes.length,
            timestamp,
            length: Math.max(0, endMs - timestamp),
            midi: note.calculateRealValue(true, true),
          });
        }
      }
    }
  }

  notes.sort((left, right) => (
    left.timestamp - right.timestamp
    || left.midi - right.midi
    || left.length - right.length
  ));
  return notes.map((note, index) => ({ ...note, id: index }));
}

export function sliceReferenceNotes(notes, startMs = 0, durationMs = null) {
  const endMs = durationMs === null ? Number.POSITIVE_INFINITY : startMs + durationMs;
  return notes
    .filter((note) => note.timestamp >= startMs && note.timestamp < endMs)
    .map((note, index) => ({
      id: index,
      timestamp: note.timestamp - startMs,
      length: Math.min(note.length, endMs - note.timestamp),
      midi: note.midi,
    }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const score = loadGpScore(options.gpPath);

  if (options.listTracks) {
    const tracks = listScoreTracks(score);
    if (options.json) console.log(JSON.stringify(tracks, null, 2));
    else {
      console.log(`Score: ${score.title || path.basename(options.gpPath)}`);
      for (const track of tracks) {
        console.log(`${track.index} | ${track.name || track.shortName || '(unnamed track)'}`);
      }
    }
    return;
  }

  const allNotes = extractTrackReferenceNotes(score, options.trackIndex);
  const references = sliceReferenceNotes(allNotes, options.startMs, options.durationMs);
  const json = `${JSON.stringify(references, null, 2)}\n`;
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, json, 'utf8');
  }

  if (options.json) console.log(json.trimEnd());
  else {
    const track = listScoreTracks(score).find((candidate) => candidate.index === options.trackIndex);
    console.log(`Score: ${score.title || path.basename(options.gpPath)}`);
    console.log(`Track: ${options.trackIndex} | ${track?.name || '(unnamed track)'}`);
    console.log(`Window: ${options.startMs.toFixed(1)} ms - ${
      options.durationMs === null ? 'end' : `${(options.startMs + options.durationMs).toFixed(1)} ms`
    }`);
    console.log(`Reference notes: ${references.length}`);
    if (options.output) console.log(`Reference JSON: ${options.output}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`GP reference export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
