import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { writeBenchmarkWorkbook } from './benchmark-xlsx.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function printHelp() {
  console.log(`Disband audio analysis benchmark

Usage:
  npm run benchmark:audio -- [options] [wav files...]

Options:
  --analyzer <path>    Path to disband-audio-analyze executable
  --iterations <n>     Measured process runs per WAV (default: 10)
  --warmup <n>         Unmeasured process runs per WAV (default: 2)
  --output <path>      Write the full JSON report to a file
  --xlsx <path>        Write a formatted Excel report
  --json               Print only the JSON report
  --help               Show this help

When no WAV files are provided, all tests/data/*.wav files are used.
If <name>.references.json exists next to a WAV, it is sent to the analyzer
through stdin on every run.`);
}

function parsePositiveInteger(value, option, allowZero = false) {
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0);
  if (!valid) {
    throw new Error(`${option} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return parsed;
}

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

function parseArguments(argv) {
  const options = {
    analyzer: defaultAnalyzerPath(),
    iterations: 10,
    warmup: 2,
    output: null,
    xlsx: null,
    json: false,
    files: [],
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
    if (argument === '--analyzer' || argument === '--iterations'
      || argument === '--warmup' || argument === '--output'
      || argument === '--xlsx') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === '--analyzer') options.analyzer = path.resolve(value);
      if (argument === '--iterations') {
        options.iterations = parsePositiveInteger(value, argument);
      }
      if (argument === '--warmup') {
        options.warmup = parsePositiveInteger(value, argument, true);
      }
      if (argument === '--output') options.output = path.resolve(value);
      if (argument === '--xlsx') options.xlsx = path.resolve(value);
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    options.files.push(path.resolve(argument));
  }

  if (options.files.length === 0) {
    const dataDirectory = path.join(repositoryRoot, 'tests', 'data');
    if (existsSync(dataDirectory)) {
      options.files = readdirSync(dataDirectory)
        .filter((name) => path.extname(name).toLowerCase() === '.wav')
        .sort()
        .map((name) => path.join(dataDirectory, name));
    }
  }

  return options;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readWaveDurationMs(filePath) {
  const descriptor = openSync(filePath, 'r');
  try {
    const fileSize = statSync(filePath).size;
    const header = Buffer.alloc(12);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length
      || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('not a RIFF/WAVE file');
    }

    let byteRate = 0;
    let dataSize = 0;
    let position = 12;
    const chunkHeader = Buffer.alloc(8);

    while (position + chunkHeader.length <= fileSize) {
      if (readSync(descriptor, chunkHeader, 0, chunkHeader.length, position)
          !== chunkHeader.length) {
        break;
      }

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const chunkDataPosition = position + chunkHeader.length;

      if (chunkId === 'fmt ' && chunkSize >= 12) {
        const format = Buffer.alloc(12);
        readSync(descriptor, format, 0, format.length, chunkDataPosition);
        byteRate = format.readUInt32LE(8);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }

      if (byteRate > 0 && dataSize > 0) break;
      position = chunkDataPosition + chunkSize + (chunkSize % 2);
    }

    if (byteRate <= 0 || dataSize <= 0) {
      throw new Error('missing fmt or data chunk');
    }
    return (dataSize / byteRate) * 1000;
  } finally {
    closeSync(descriptor);
  }
}

function referenceFileFor(wavPath) {
  const parsed = path.parse(wavPath);
  const candidate = path.join(parsed.dir, `${parsed.name}.references.json`);
  return existsSync(candidate) ? candidate : null;
}

function runAnalyzer(analyzer, wavPath, referenceInput) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(analyzer, ['--analyze-wav', wavPath], {
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
      const elapsedMs = performance.now() - startedAt;
      if (code !== 0) {
        reject(new Error(
          `Analyzer failed for ${path.basename(wavPath)} with exit code ${code}\n${stderr}`,
        ));
        return;
      }

      const trimmedOutput = stdout.trim();
      try {
        const parsed = JSON.parse(trimmedOutput);
        resolve({
          elapsedMs,
          outputHash: createHash('sha256').update(trimmedOutput).digest('hex'),
          playedNoteCount: Array.isArray(parsed.playedNotes) ? parsed.playedNotes.length : null,
          judgmentCount: Array.isArray(parsed.noteJudgments) ? parsed.noteJudgments.length : null,
        });
      } catch (error) {
        reject(new Error(
          `Analyzer returned invalid JSON for ${path.basename(wavPath)}: ${error.message}`,
        ));
      }
    });

    child.stdin.end(referenceInput ?? '');
  });
}

function percentile(sortedValues, percentileValue) {
  const rank = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(rank, sortedValues.length - 1))];
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce(
    (total, value) => total + ((value - mean) ** 2),
    0,
  ) / values.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];

  return {
    minMs: sorted[0],
    medianMs: median,
    meanMs: mean,
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    standardDeviationMs: Math.sqrt(variance),
  };
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

async function benchmarkFile(options, wavPath) {
  if (!existsSync(wavPath)) throw new Error(`WAV file not found: ${wavPath}`);

  const referencePath = referenceFileFor(wavPath);
  const referenceInput = referencePath ? readFileSync(referencePath, 'utf8') : null;
  const durationMs = readWaveDurationMs(wavPath);

  for (let run = 0; run < options.warmup; run += 1) {
    await runAnalyzer(options.analyzer, wavPath, referenceInput);
  }

  const runs = [];
  for (let run = 0; run < options.iterations; run += 1) {
    runs.push(await runAnalyzer(options.analyzer, wavPath, referenceInput));
  }

  const timing = summarize(runs.map((run) => run.elapsedMs));
  const hashes = [...new Set(runs.map((run) => run.outputHash))];
  const noteCounts = [...new Set(runs.map((run) => run.playedNoteCount))];
  const judgmentCounts = [...new Set(runs.map((run) => run.judgmentCount))];

  return {
    file: path.relative(repositoryRoot, wavPath).replaceAll('\\', '/'),
    audioSha256: sha256File(wavPath),
    durationMs,
    referenceFile: referencePath
      ? path.relative(repositoryRoot, referencePath).replaceAll('\\', '/')
      : null,
    warmupRuns: options.warmup,
    measuredRuns: options.iterations,
    timing,
    realTimeFactor: {
      median: timing.medianMs / durationMs,
      p95: timing.p95Ms / durationMs,
    },
    output: {
      deterministic: hashes.length === 1
        && noteCounts.length === 1
        && judgmentCounts.length === 1,
      hashes,
      playedNoteCounts: noteCounts,
      judgmentCounts,
    },
    runTimesMs: runs.map((run) => run.elapsedMs),
  };
}

function printHumanReport(report) {
  console.log('Disband audio benchmark');
  console.log(`Analyzer: ${report.analyzer.path}`);
  console.log(`Git: ${report.git.branch ?? 'unknown'} @ ${report.git.commit ?? 'unknown'}${report.git.dirty ? ' (dirty)' : ''}`);
  console.log(`Runs: ${report.configuration.iterations} measured, ${report.configuration.warmup} warmup`);
  console.log('');
  console.log('WAV | median | p95 | RTF median | notes | stable');

  for (const result of report.results) {
    console.log([
      path.basename(result.file),
      `${result.timing.medianMs.toFixed(2)} ms`,
      `${result.timing.p95Ms.toFixed(2)} ms`,
      result.realTimeFactor.median.toFixed(4),
      result.output.playedNoteCounts.join('/'),
      result.output.deterministic ? 'yes' : 'NO',
    ].join(' | '));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(options.analyzer)) {
    throw new Error(
      `Analyzer executable not found: ${options.analyzer}\nBuild the native audio engine first or pass --analyzer <path>.`,
    );
  }
  if (options.files.length === 0) {
    throw new Error('No WAV files were provided and tests/data contains no WAV files');
  }

  const status = gitValue(['status', '--porcelain', '--untracked-files=no']);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    configuration: {
      iterations: options.iterations,
      warmup: options.warmup,
    },
    system: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
    },
    git: {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['branch', '--show-current']),
      dirty: Boolean(status),
    },
    analyzer: {
      path: path.resolve(options.analyzer),
      sha256: sha256File(options.analyzer),
    },
    results: [],
  };

  for (const wavPath of options.files) {
    report.results.push(await benchmarkFile(options, wavPath));
  }

  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (options.xlsx) {
    await writeBenchmarkWorkbook(report, options.xlsx);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
    if (options.output) console.log(`\nJSON report: ${options.output}`);
    if (options.xlsx) console.log(`Excel report: ${options.xlsx}`);
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
