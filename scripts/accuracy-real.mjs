import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  aggregateResults,
  compareAccuracyReports,
  evaluateCase,
} from './accuracy-audio.mjs';
import { writeAccuracyWorkbook } from './accuracy-xlsx.mjs';
import {
  extractTrackReferenceNotes,
  listScoreTracks,
  loadGpScore,
  parseFixtureFilename,
  readWavDurationMs,
  sliceReferenceNotes,
} from './gp-reference.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const defaultFixtureDirectory = path.join(repositoryRoot, 'tests', 'data');
const localScoreDirectory = path.join(defaultFixtureDirectory, 'scores');
const defaultOutput = path.join(repositoryRoot, 'benchmark-results', 'accuracy-real.json');
const defaultExcelOutput = path.join(repositoryRoot, 'benchmark-results', 'accuracy-real.xlsx');

function defaultAnalyzerPath() {
  const executable = process.platform === 'win32'
    ? 'disband-audio-analyze.exe'
    : 'disband-audio-analyze';
  return path.join(
    repositoryRoot,
    'native',
    'audio-engine',
    'bin',
    process.platform,
    executable,
  );
}

function defaultSongsDirectory() {
  return path.join(os.homedir(), 'Documents', 'Disband', 'Songs');
}

function printHelp() {
  console.log(`Disband GP-referenced real recording accuracy test

Usage:
  npm run accuracy:real -- [options] [wav files...]

The default input is every WAV in tests/data. A fixture named
<song.gp>__tr-<track>__start-<milliseconds>__<take>.wav is automatically
paired with <songs-dir>/<song.gp>.

Options:
  --analyzer <path>             Path to disband-audio-analyze
  --songs-dir <path>            Directory containing matching GP files
  --gp <path>                   Explicit GP file (single WAV only)
  --track <index>               Override zero-based track index
  --start-ms <value>            Override score window start
  --onset-tolerance-ms <value>  Event matching tolerance (default: 100)
  --baseline <path>             Compare against an earlier real report
  --allow-f1-drop-pp <value>    Allowed aggregate F1 drop (default: 1)
  --output <path>               JSON report path
  --xlsx <path>                 Excel report path
  --allow-missing               Skip WAV fixtures whose GP file is missing
  --json                        Print only JSON
  --help                        Show this help`);
}

function parseNonNegativeNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
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

function defaultWaveFiles() {
  if (!existsSync(defaultFixtureDirectory)) return [];
  return readdirSync(defaultFixtureDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.wav')
    .map((entry) => path.join(defaultFixtureDirectory, entry.name))
    .sort();
}

function parseArguments(argv) {
  const options = {
    analyzer: defaultAnalyzerPath(),
    songsDirectory: defaultSongsDirectory(),
    gpPath: null,
    trackIndex: null,
    startMs: null,
    onsetToleranceMs: 100,
    allowedF1DropPp: 1,
    baseline: null,
    output: defaultOutput,
    xlsx: defaultExcelOutput,
    allowMissing: false,
    json: false,
    waveFiles: [],
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
    if (argument === '--allow-missing') {
      options.allowMissing = true;
      continue;
    }
    if (argument === '--analyzer' || argument === '--songs-dir' || argument === '--gp'
      || argument === '--track' || argument === '--start-ms'
      || argument === '--onset-tolerance-ms' || argument === '--allow-f1-drop-pp'
      || argument === '--baseline' || argument === '--output' || argument === '--xlsx') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--analyzer') options.analyzer = path.resolve(value);
      if (argument === '--songs-dir') options.songsDirectory = path.resolve(value);
      if (argument === '--gp') options.gpPath = path.resolve(value);
      if (argument === '--track') options.trackIndex = parseTrackIndex(value);
      if (argument === '--start-ms') {
        options.startMs = parseNonNegativeNumber(value, argument);
      }
      if (argument === '--onset-tolerance-ms') {
        options.onsetToleranceMs = parsePositiveNumber(value, argument);
      }
      if (argument === '--allow-f1-drop-pp') {
        options.allowedF1DropPp = parsePositiveNumber(value, argument);
      }
      if (argument === '--baseline') options.baseline = path.resolve(value);
      if (argument === '--output') options.output = path.resolve(value);
      if (argument === '--xlsx') options.xlsx = path.resolve(value);
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    options.waveFiles.push(path.resolve(argument));
  }

  if (options.waveFiles.length === 0) options.waveFiles = defaultWaveFiles();
  if (options.waveFiles.length === 0) throw new Error('No WAV files were found');
  if (options.gpPath && options.waveFiles.length !== 1) {
    throw new Error('--gp can only be used when exactly one WAV is provided');
  }
  return options;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function gitValue(args) {
  try {
    return execFileSync(
      'git',
      ['-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`, ...args],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return null;
  }
}

function runAnalyzer(analyzer, wavePath, referenceNotes) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(analyzer, ['--analyze-wav', wavePath], {
      cwd: repositoryRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Analyzer exited with ${code}\n${stderr}`));
        return;
      }
      try {
        resolve({
          elapsedMs: performance.now() - startedAt,
          output: JSON.parse(stdout.trim()),
          outputSha256: createHash('sha256').update(stdout.trim()).digest('hex'),
        });
      } catch (error) {
        reject(new Error(`Analyzer returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(referenceNotes));
  });
}

function resolveFixture(options, wavePath) {
  const fixture = parseFixtureFilename(wavePath);
  const localGpPath = fixture
    ? path.join(localScoreDirectory, fixture.songFileName)
    : null;
  const gpPath = options.gpPath ?? (
    localGpPath && existsSync(localGpPath)
      ? localGpPath
      : fixture
        ? path.join(options.songsDirectory, fixture.songFileName)
        : null
  );
  const trackIndex = options.trackIndex ?? fixture?.trackIndex ?? null;
  const startMs = options.startMs ?? fixture?.startMs ?? null;
  if (!gpPath) {
    throw new Error(
      `Cannot infer a GP file from ${path.basename(wavePath)}. `
      + 'Use a fixture-style filename or pass --gp.',
    );
  }
  if (trackIndex === null) {
    throw new Error(`Cannot infer a track for ${path.basename(wavePath)}. Pass --track.`);
  }
  if (startMs === null) {
    throw new Error(`Cannot infer a start time for ${path.basename(wavePath)}. Pass --start-ms.`);
  }
  return { fixture, gpPath, trackIndex, startMs };
}

function referenceDiagnostics(referenceNotes) {
  const onsetCounts = new Map();
  for (const note of referenceNotes) {
    const key = note.timestamp.toFixed(3);
    onsetCounts.set(key, (onsetCounts.get(key) ?? 0) + 1);
  }
  const counts = [...onsetCounts.values()];
  return {
    polyphonicOnsets: counts.filter((count) => count > 1).length,
    maximumSimultaneousNotes: counts.length > 0 ? Math.max(...counts) : 0,
  };
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function milliseconds(value) {
  return value === null ? 'n/a' : `${value.toFixed(1)} ms`;
}

function printHumanReport(report) {
  console.log('Disband GP-referenced real recording accuracy test');
  console.log(`Analyzer: ${report.analyzer.path}`);
  console.log(`Onset match tolerance: ${report.configuration.onsetToleranceMs} ms`);
  console.log('');
  console.log('Case | refs/detected | event F1 | strict F1 | MIDI | onset MAE | offset MAE');
  for (const result of report.results) {
    console.log([
      result.name,
      `${result.metrics.counts.references}/${result.metrics.counts.played}`,
      percentage(result.metrics.event.f1),
      percentage(result.metrics.strictNote.f1),
      percentage(result.metrics.matchedPitch.midiAccuracy),
      milliseconds(result.metrics.timing.absoluteOnsetErrorMs.mean),
      milliseconds(result.metrics.timing.absoluteOffsetErrorMs.mean),
    ].join(' | '));
    if (result.referenceDiagnostics.polyphonicOnsets > 0) {
      console.log(
        `  Note: ${result.referenceDiagnostics.polyphonicOnsets} score onsets are polyphonic `
        + `(max ${result.referenceDiagnostics.maximumSimultaneousNotes} notes), `
        + 'while the analyzer is monophonic.',
      );
    }
  }
  console.log('');
  console.log([
    'Aggregate',
    `${report.aggregate.counts.references}/${report.aggregate.counts.played}`,
    percentage(report.aggregate.event.f1),
    percentage(report.aggregate.strictNote.f1),
    percentage(report.aggregate.matchedPitch.midiAccuracy),
    milliseconds(report.aggregate.timing.absoluteOnsetErrorMs.mean),
    milliseconds(report.aggregate.timing.absoluteOffsetErrorMs.mean),
  ].join(' | '));

  if (report.comparison) {
    console.log(`Baseline comparison: ${report.comparison.passed ? 'PASS' : 'FAIL'}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.analyzer)) {
    throw new Error(`Analyzer not found: ${options.analyzer}`);
  }

  const resolved = [];
  const missing = [];
  for (const wavePath of options.waveFiles) {
    if (!existsSync(wavePath)) throw new Error(`WAV file not found: ${wavePath}`);
    const fixture = resolveFixture(options, wavePath);
    if (!existsSync(fixture.gpPath)) {
      missing.push({ wavePath, gpPath: fixture.gpPath });
    } else {
      resolved.push({ wavePath, ...fixture });
    }
  }
  if (missing.length > 0 && !options.allowMissing) {
    throw new Error(
      `Missing ${missing.length} matching GP file(s):\n`
      + missing.map((entry) => (
        `  ${path.basename(entry.wavePath)}\n    expected: ${entry.gpPath}`
      )).join('\n'),
    );
  }
  if (resolved.length === 0) {
    throw new Error('No WAV/GP pairs are available to measure');
  }

  const report = {
    schemaVersion: 1,
    kind: 'real-world',
    generatedAt: new Date().toISOString(),
    configuration: {
      onsetToleranceMs: options.onsetToleranceMs,
      songsDirectory: options.songsDirectory,
    },
    git: {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['branch', '--show-current']),
      dirty: Boolean(gitValue(['status', '--porcelain', '--untracked-files=no'])),
    },
    analyzer: {
      path: options.analyzer,
      sha256: sha256File(options.analyzer),
    },
    skippedMissingPairs: missing.map((entry) => ({
      wave: entry.wavePath,
      expectedGp: entry.gpPath,
    })),
    results: [],
  };

  const scoreCache = new Map();
  const trackNoteCache = new Map();
  for (const input of resolved) {
    let score = scoreCache.get(input.gpPath);
    if (!score) {
      score = loadGpScore(input.gpPath);
      scoreCache.set(input.gpPath, score);
    }
    const cacheKey = `${input.gpPath}\0${input.trackIndex}`;
    let allReferenceNotes = trackNoteCache.get(cacheKey);
    if (!allReferenceNotes) {
      allReferenceNotes = extractTrackReferenceNotes(score, input.trackIndex);
      trackNoteCache.set(cacheKey, allReferenceNotes);
    }

    const durationMs = readWavDurationMs(input.wavePath);
    const referenceNotes = sliceReferenceNotes(
      allReferenceNotes,
      input.startMs,
      durationMs,
    );
    if (referenceNotes.length === 0) {
      throw new Error(
        `No score notes found for ${path.basename(input.wavePath)} `
        + `(track ${input.trackIndex}, ${input.startMs}-${input.startMs + durationMs} ms)`,
      );
    }

    const analysis = await runAnalyzer(options.analyzer, input.wavePath, referenceNotes);
    const playedNotes = Array.isArray(analysis.output.playedNotes)
      ? analysis.output.playedNotes
      : [];
    const track = listScoreTracks(score).find(
      (candidate) => candidate.index === input.trackIndex,
    );
    report.results.push({
      name: path.basename(input.wavePath, path.extname(input.wavePath)),
      wave: input.wavePath,
      waveSha256: sha256File(input.wavePath),
      gp: input.gpPath,
      gpSha256: sha256File(input.gpPath),
      track: {
        index: input.trackIndex,
        name: track?.name || track?.shortName || '(unnamed track)',
      },
      window: {
        startMs: input.startMs,
        durationMs,
        endMs: input.startMs + durationMs,
      },
      referenceDiagnostics: referenceDiagnostics(referenceNotes),
      referenceNotes,
      playedNotes,
      analyzerOutputSha256: analysis.outputSha256,
      elapsedMs: analysis.elapsedMs,
      metrics: evaluateCase(referenceNotes, playedNotes, options.onsetToleranceMs),
    });
  }

  report.aggregate = aggregateResults(report.results);
  if (options.baseline) {
    const baseline = JSON.parse(readFileSync(options.baseline, 'utf8'));
    report.comparison = compareAccuracyReports(
      baseline,
      report,
      options.allowedF1DropPp,
    );
    report.baselineReport = options.baseline;
  }

  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeAccuracyWorkbook(report, options.xlsx);

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    printHumanReport(report);
    console.log(`\nJSON report: ${options.output}`);
    console.log(`Excel report: ${options.xlsx}`);
    if (missing.length > 0) {
      console.log(`Skipped missing pairs: ${missing.length}`);
    }
  }
  if (report.comparison && !report.comparison.passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Real accuracy test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
