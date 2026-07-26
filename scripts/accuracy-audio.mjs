import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { generateAccuracyFixtures } from './generate-accuracy-fixtures.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const defaultFixtureDirectory = path.join(repositoryRoot, 'tests', 'accuracy', 'generated');

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

function printHelp() {
  console.log(`Disband note extraction accuracy test

Usage:
  npm run accuracy:audio -- [options]

Options:
  --analyzer <path>             Path to disband-audio-analyze
  --fixtures <path>             Generated fixture directory
  --onset-tolerance-ms <value>  Event matching tolerance (default: 100)
  --baseline <path>             Compare against an earlier accuracy report
  --allow-f1-drop-pp <value>    Allowed aggregate F1 drop (default: 1)
  --output <path>               Write JSON report
  --json                        Print only JSON
  --no-generate                 Reuse existing generated fixtures
  --help                        Show this help`);
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    analyzer: defaultAnalyzerPath(),
    fixtureDirectory: defaultFixtureDirectory,
    onsetToleranceMs: 100,
    allowedF1DropPp: 1,
    baseline: null,
    output: null,
    json: false,
    generate: true,
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
    if (argument === '--no-generate') {
      options.generate = false;
      continue;
    }
    if (argument === '--analyzer' || argument === '--fixtures'
      || argument === '--onset-tolerance-ms' || argument === '--allow-f1-drop-pp'
      || argument === '--baseline' || argument === '--output') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--analyzer') options.analyzer = path.resolve(value);
      if (argument === '--fixtures') options.fixtureDirectory = path.resolve(value);
      if (argument === '--onset-tolerance-ms') {
        options.onsetToleranceMs = parsePositiveNumber(value, argument);
      }
      if (argument === '--allow-f1-drop-pp') {
        options.allowedF1DropPp = parsePositiveNumber(value, argument);
      }
      if (argument === '--baseline') options.baseline = path.resolve(value);
      if (argument === '--output') options.output = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
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

function runAnalyzer(analyzer, wavePath, referenceJson) {
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
    child.stdin.end(referenceJson);
  });
}

function isBetter(candidate, current) {
  if (candidate.matches !== current.matches) return candidate.matches > current.matches;
  if (candidate.cost !== current.cost) return candidate.cost < current.cost;
  return candidate.action === 'match' && current.action !== 'match';
}

export function matchByOnset(references, playedNotes, toleranceMs) {
  const rows = references.length + 1;
  const columns = playedNotes.length + 1;
  const table = Array.from(
    { length: rows },
    () => Array.from({ length: columns }, () => ({
      matches: 0,
      cost: 0,
      action: null,
    })),
  );

  for (let referenceCount = 1; referenceCount < rows; referenceCount += 1) {
    table[referenceCount][0] = {
      ...table[referenceCount - 1][0],
      action: 'skipReference',
    };
  }
  for (let playedCount = 1; playedCount < columns; playedCount += 1) {
    table[0][playedCount] = {
      ...table[0][playedCount - 1],
      action: 'skipPlayed',
    };
  }

  for (let referenceCount = 1; referenceCount < rows; referenceCount += 1) {
    for (let playedCount = 1; playedCount < columns; playedCount += 1) {
      const skipReference = {
        ...table[referenceCount - 1][playedCount],
        action: 'skipReference',
      };
      const skipPlayed = {
        ...table[referenceCount][playedCount - 1],
        action: 'skipPlayed',
      };
      let best = isBetter(skipPlayed, skipReference) ? skipPlayed : skipReference;

      const reference = references[referenceCount - 1];
      const played = playedNotes[playedCount - 1];
      const onsetErrorMs = Math.abs(played.startMs - reference.timestamp);
      if (onsetErrorMs <= toleranceMs) {
        const previous = table[referenceCount - 1][playedCount - 1];
        const match = {
          matches: previous.matches + 1,
          cost: previous.cost + onsetErrorMs,
          action: 'match',
        };
        if (isBetter(match, best)) best = match;
      }
      table[referenceCount][playedCount] = best;
    }
  }

  const matches = [];
  let referenceCount = references.length;
  let playedCount = playedNotes.length;
  while (referenceCount > 0 || playedCount > 0) {
    const action = table[referenceCount][playedCount].action;
    if (action === 'match') {
      matches.push({
        referenceIndex: referenceCount - 1,
        playedIndex: playedCount - 1,
      });
      referenceCount -= 1;
      playedCount -= 1;
    } else if (action === 'skipReference') {
      referenceCount -= 1;
    } else if (action === 'skipPlayed') {
      playedCount -= 1;
    } else {
      break;
    }
  }
  return matches.reverse();
}

function divide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1Score(precision, recall) {
  return precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
}

function summarize(values) {
  if (values.length === 0) {
    return {
      mean: null,
      median: null,
      p95: null,
      max: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted.at(-1),
  };
}

function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

export function evaluateCase(references, playedNotes, onsetToleranceMs) {
  const matches = matchByOnset(references, playedNotes, onsetToleranceMs);
  const matchDetails = [];
  const onsetErrors = [];
  const offsetErrors = [];
  const centsErrors = [];
  let midiCorrect = 0;
  let octaveErrors = 0;
  let attacksWithin40Ms = 0;
  let releasesWithin70Ms = 0;

  for (const match of matches) {
    const reference = references[match.referenceIndex];
    const played = playedNotes[match.playedIndex];
    const onsetErrorMs = played.startMs - reference.timestamp;
    const referenceEndMs = reference.timestamp + reference.length;
    const offsetErrorMs = played.endMs - referenceEndMs;
    const midiError = played.midi - reference.midi;
    const referenceHz = midiToFrequency(reference.midi);
    const centsError = played.hz > 0
      ? 1200 * Math.log2(played.hz / referenceHz)
      : null;
    const midiMatch = midiError === 0;

    if (midiMatch) midiCorrect += 1;
    if (Math.abs(midiError) >= 12 && Math.abs(midiError) % 12 === 0) octaveErrors += 1;
    if (Math.abs(onsetErrorMs) <= 40) attacksWithin40Ms += 1;
    if (Math.abs(offsetErrorMs) <= 70) releasesWithin70Ms += 1;
    onsetErrors.push(Math.abs(onsetErrorMs));
    offsetErrors.push(Math.abs(offsetErrorMs));
    if (centsError !== null) centsErrors.push(Math.abs(centsError));
    matchDetails.push({
      ...match,
      referenceMidi: reference.midi,
      playedMidi: played.midi,
      midiError,
      midiMatch,
      onsetErrorMs,
      offsetErrorMs,
      centsError,
    });
  }

  const eventPrecision = divide(matches.length, playedNotes.length);
  const eventRecall = divide(matches.length, references.length);
  const strictPrecision = divide(midiCorrect, playedNotes.length);
  const strictRecall = divide(midiCorrect, references.length);

  return {
    counts: {
      references: references.length,
      played: playedNotes.length,
      onsetMatched: matches.length,
      midiCorrect,
      eventFalsePositive: playedNotes.length - matches.length,
      eventMissed: references.length - matches.length,
      strictFalsePositive: playedNotes.length - midiCorrect,
      strictMissed: references.length - midiCorrect,
      octaveErrors,
    },
    event: {
      precision: eventPrecision,
      recall: eventRecall,
      f1: f1Score(eventPrecision, eventRecall),
    },
    strictNote: {
      precision: strictPrecision,
      recall: strictRecall,
      f1: f1Score(strictPrecision, strictRecall),
    },
    matchedPitch: {
      midiAccuracy: divide(midiCorrect, matches.length),
      octaveErrorRate: divide(octaveErrors, matches.length),
      absoluteCentsError: summarize(centsErrors),
    },
    timing: {
      attackWithin40MsRate: divide(attacksWithin40Ms, matches.length),
      releaseWithin70MsRate: divide(releasesWithin70Ms, matches.length),
      absoluteOnsetErrorMs: summarize(onsetErrors),
      absoluteOffsetErrorMs: summarize(offsetErrors),
    },
    matches: matchDetails,
  };
}

function aggregateResults(results) {
  const totals = {
    references: 0,
    played: 0,
    onsetMatched: 0,
    midiCorrect: 0,
    octaveErrors: 0,
  };
  const onsetErrors = [];
  const offsetErrors = [];
  const centsErrors = [];
  let attacksWithin40Ms = 0;
  let releasesWithin70Ms = 0;

  for (const result of results) {
    totals.references += result.metrics.counts.references;
    totals.played += result.metrics.counts.played;
    totals.onsetMatched += result.metrics.counts.onsetMatched;
    totals.midiCorrect += result.metrics.counts.midiCorrect;
    totals.octaveErrors += result.metrics.counts.octaveErrors;
    for (const match of result.metrics.matches) {
      onsetErrors.push(Math.abs(match.onsetErrorMs));
      offsetErrors.push(Math.abs(match.offsetErrorMs));
      if (match.centsError !== null) centsErrors.push(Math.abs(match.centsError));
      if (Math.abs(match.onsetErrorMs) <= 40) attacksWithin40Ms += 1;
      if (Math.abs(match.offsetErrorMs) <= 70) releasesWithin70Ms += 1;
    }
  }

  const eventPrecision = divide(totals.onsetMatched, totals.played);
  const eventRecall = divide(totals.onsetMatched, totals.references);
  const strictPrecision = divide(totals.midiCorrect, totals.played);
  const strictRecall = divide(totals.midiCorrect, totals.references);

  return {
    counts: {
      ...totals,
      eventFalsePositive: totals.played - totals.onsetMatched,
      eventMissed: totals.references - totals.onsetMatched,
      strictFalsePositive: totals.played - totals.midiCorrect,
      strictMissed: totals.references - totals.midiCorrect,
    },
    event: {
      precision: eventPrecision,
      recall: eventRecall,
      f1: f1Score(eventPrecision, eventRecall),
    },
    strictNote: {
      precision: strictPrecision,
      recall: strictRecall,
      f1: f1Score(strictPrecision, strictRecall),
    },
    matchedPitch: {
      midiAccuracy: divide(totals.midiCorrect, totals.onsetMatched),
      octaveErrorRate: divide(totals.octaveErrors, totals.onsetMatched),
      absoluteCentsError: summarize(centsErrors),
    },
    timing: {
      attackWithin40MsRate: divide(attacksWithin40Ms, totals.onsetMatched),
      releaseWithin70MsRate: divide(releasesWithin70Ms, totals.onsetMatched),
      absoluteOnsetErrorMs: summarize(onsetErrors),
      absoluteOffsetErrorMs: summarize(offsetErrors),
    },
  };
}

function percentagePointDelta(current, baseline) {
  return (current - baseline) * 100;
}

export function compareAccuracyReports(baseline, current, allowedF1DropPp = 1) {
  const baselineCases = new Map(baseline.results.map((result) => [result.name, result]));
  const perCase = current.results.map((result) => {
    const baselineResult = baselineCases.get(result.name);
    if (!baselineResult) {
      return {
        name: result.name,
        baselineMissing: true,
        passed: false,
      };
    }
    const midiCorrectDelta = result.metrics.counts.midiCorrect
      - baselineResult.metrics.counts.midiCorrect;
    const octaveErrorDelta = result.metrics.counts.octaveErrors
      - baselineResult.metrics.counts.octaveErrors;
    return {
      name: result.name,
      baselineMissing: false,
      strictNoteF1DeltaPp: percentagePointDelta(
        result.metrics.strictNote.f1,
        baselineResult.metrics.strictNote.f1,
      ),
      midiCorrectDelta,
      octaveErrorDelta,
      passed: midiCorrectDelta >= 0 && octaveErrorDelta <= 0,
    };
  });

  const strictNoteF1DeltaPp = percentagePointDelta(
    current.aggregate.strictNote.f1,
    baseline.aggregate.strictNote.f1,
  );
  const eventF1DeltaPp = percentagePointDelta(
    current.aggregate.event.f1,
    baseline.aggregate.event.f1,
  );
  const midiAccuracyDeltaPp = percentagePointDelta(
    current.aggregate.matchedPitch.midiAccuracy,
    baseline.aggregate.matchedPitch.midiAccuracy,
  );
  const onsetMeanDeltaMs = current.aggregate.timing.absoluteOnsetErrorMs.mean
    - baseline.aggregate.timing.absoluteOnsetErrorMs.mean;
  const offsetMeanDeltaMs = current.aggregate.timing.absoluteOffsetErrorMs.mean
    - baseline.aggregate.timing.absoluteOffsetErrorMs.mean;
  const octaveErrorDelta = current.aggregate.counts.octaveErrors
    - baseline.aggregate.counts.octaveErrors;
  const rules = [
    {
      name: 'aggregate strict note F1',
      value: strictNoteF1DeltaPp,
      minimum: -allowedF1DropPp,
      passed: strictNoteF1DeltaPp >= -allowedF1DropPp,
    },
    {
      name: 'aggregate event F1',
      value: eventF1DeltaPp,
      minimum: -allowedF1DropPp,
      passed: eventF1DeltaPp >= -allowedF1DropPp,
    },
    {
      name: 'aggregate MIDI accuracy',
      value: midiAccuracyDeltaPp,
      minimum: -allowedF1DropPp,
      passed: midiAccuracyDeltaPp >= -allowedF1DropPp,
    },
    {
      name: 'mean onset error',
      value: onsetMeanDeltaMs,
      maximum: 5,
      passed: onsetMeanDeltaMs <= 5,
    },
    {
      name: 'mean offset error',
      value: offsetMeanDeltaMs,
      maximum: 10,
      passed: offsetMeanDeltaMs <= 10,
    },
    {
      name: 'octave errors',
      value: octaveErrorDelta,
      maximum: 0,
      passed: octaveErrorDelta <= 0,
    },
    {
      name: 'per-case pitch regressions',
      failedCases: perCase.filter((result) => !result.passed).map((result) => result.name),
      passed: perCase.every((result) => result.passed),
    },
  ];

  return {
    allowedF1DropPp,
    passed: rules.every((rule) => rule.passed),
    aggregateDelta: {
      strictNoteF1Pp: strictNoteF1DeltaPp,
      eventF1Pp: eventF1DeltaPp,
      midiAccuracyPp: midiAccuracyDeltaPp,
      onsetMeanMs: onsetMeanDeltaMs,
      offsetMeanMs: offsetMeanDeltaMs,
      octaveErrors: octaveErrorDelta,
    },
    rules,
    perCase,
  };
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function milliseconds(value) {
  return value === null ? 'n/a' : `${value.toFixed(1)} ms`;
}

function printHumanReport(report) {
  console.log('Disband synthetic accuracy test');
  console.log(`Analyzer: ${report.analyzer.path}`);
  console.log(`Onset match tolerance: ${report.configuration.onsetToleranceMs} ms`);
  console.log('');
  console.log('Case | refs/played | event F1 | strict note F1 | MIDI | onset MAE | offset MAE');
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
    console.log('');
    console.log(`Baseline comparison: ${report.comparison.passed ? 'PASS' : 'FAIL'}`);
    console.log([
      `strict Note F1 ${report.comparison.aggregateDelta.strictNoteF1Pp.toFixed(2)} pp`,
      `event F1 ${report.comparison.aggregateDelta.eventF1Pp.toFixed(2)} pp`,
      `MIDI ${report.comparison.aggregateDelta.midiAccuracyPp.toFixed(2)} pp`,
      `onset mean ${report.comparison.aggregateDelta.onsetMeanMs.toFixed(2)} ms`,
      `offset mean ${report.comparison.aggregateDelta.offsetMeanMs.toFixed(2)} ms`,
      `octave errors ${report.comparison.aggregateDelta.octaveErrors >= 0 ? '+' : ''}${report.comparison.aggregateDelta.octaveErrors}`,
    ].join(' | '));
    const failures = report.comparison.rules.filter((rule) => !rule.passed);
    for (const failure of failures) {
      console.log(`  FAIL: ${failure.name}`);
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.analyzer)) {
    throw new Error(`Analyzer not found: ${options.analyzer}`);
  }
  if (options.generate) {
    await generateAccuracyFixtures({ outputDirectory: options.fixtureDirectory });
  }

  const manifestPath = path.join(options.fixtureDirectory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Fixture manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration: {
      onsetToleranceMs: options.onsetToleranceMs,
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
    fixtureManifest: path.relative(repositoryRoot, manifestPath).replaceAll('\\', '/'),
    results: [],
  };

  for (const testCase of manifest.cases) {
    const wavePath = path.join(options.fixtureDirectory, testCase.wave);
    const referencePath = path.join(options.fixtureDirectory, testCase.references);
    const referenceJson = readFileSync(referencePath, 'utf8');
    const references = JSON.parse(referenceJson);
    const analysis = await runAnalyzer(options.analyzer, wavePath, referenceJson);
    const playedNotes = Array.isArray(analysis.output.playedNotes)
      ? analysis.output.playedNotes
      : [];

    report.results.push({
      name: testCase.name,
      description: testCase.description,
      waveSha256: sha256File(wavePath),
      referenceSha256: sha256File(referencePath),
      analyzerOutputSha256: analysis.outputSha256,
      elapsedMs: analysis.elapsedMs,
      metrics: evaluateCase(references, playedNotes, options.onsetToleranceMs),
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
    report.baselineReport = path.relative(repositoryRoot, options.baseline).replaceAll('\\', '/');
  }
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    printHumanReport(report);
    if (options.output) console.log(`\nJSON report: ${options.output}`);
  }
  if (report.comparison && !report.comparison.passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Accuracy test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
