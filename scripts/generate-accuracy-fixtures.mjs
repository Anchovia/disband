import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const defaultCasesPath = path.join(repositoryRoot, 'tests', 'accuracy', 'cases.json');
const defaultOutputDirectory = path.join(repositoryRoot, 'tests', 'accuracy', 'generated');

function parseArguments(argv) {
  const options = {
    casesPath: defaultCasesPath,
    outputDirectory: defaultOutputDirectory,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cases' || argument === '--output-dir') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--cases') options.casesPath = path.resolve(value);
      if (argument === '--output-dir') options.outputDirectory = path.resolve(value);
      continue;
    }
    if (argument === '--help') {
      console.log(`Generate deterministic accuracy fixtures

Usage:
  npm run accuracy:generate -- [options]

Options:
  --cases <path>       Accuracy case definition JSON
  --output-dir <path>  Generated WAV/reference directory
  --help               Show this help`);
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function hashSeed(text) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

function midiToFrequency(midi) {
  return 440 * (2 ** ((midi - 69) / 12));
}

function writeMonoPcm16Wave(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * bytesPerSample);
  }

  return buffer;
}

function synthesizeCase(testCase, sampleRate) {
  const references = [];
  let cursorMs = testCase.leadingSilenceMs ?? 500;

  for (let index = 0; index < testCase.notes.length; index += 1) {
    const note = testCase.notes[index];
    references.push({
      id: index,
      timestamp: cursorMs,
      length: note.durationMs,
      midi: note.midi,
    });
    cursorMs += note.durationMs + (note.gapAfterMs ?? 0);
  }

  const durationMs = cursorMs + (testCase.trailingSilenceMs ?? 500);
  const sampleCount = Math.ceil(durationMs * sampleRate / 1000);
  const samples = new Float64Array(sampleCount);
  const random = createRandom(hashSeed(testCase.name));
  const backgroundNoise = testCase.backgroundNoise ?? 0;

  if (backgroundNoise > 0) {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = random() * backgroundNoise;
    }
  }

  const harmonics = testCase.harmonics ?? [1, 0.4, 0.18, 0.08];
  const harmonicScale = harmonics.reduce((sum, coefficient) => sum + Math.abs(coefficient), 0);

  references.forEach((reference, referenceIndex) => {
    const note = testCase.notes[referenceIndex];
    const startSample = Math.round(reference.timestamp * sampleRate / 1000);
    const noteSampleCount = Math.round(reference.length * sampleRate / 1000);
    const amplitude = note.amplitude ?? 0.72;
    const attackMs = note.attackMs ?? 5;
    const releaseMs = note.releaseMs ?? 24;
    const vibratoCents = note.vibratoCents ?? 0;
    const vibratoHz = note.vibratoHz ?? 5;
    const baseFrequency = midiToFrequency(note.midi);
    let phase = 0;

    for (let offset = 0; offset < noteSampleCount; offset += 1) {
      const timeSeconds = offset / sampleRate;
      const timeMs = timeSeconds * 1000;
      const vibrato = vibratoCents === 0
        ? 0
        : vibratoCents * Math.sin(2 * Math.PI * vibratoHz * timeSeconds);
      const frequency = baseFrequency * (2 ** (vibrato / 1200));
      phase += 2 * Math.PI * frequency / sampleRate;

      let waveform = 0;
      for (let harmonic = 0; harmonic < harmonics.length; harmonic += 1) {
        waveform += harmonics[harmonic]
          * Math.sin((harmonic + 1) * phase + harmonic * 0.17);
      }
      waveform /= harmonicScale;

      const attackGain = Math.min(1, timeMs / Math.max(0.1, attackMs));
      const remainingMs = reference.length - timeMs;
      const releaseGain = Math.min(1, remainingMs / Math.max(0.1, releaseMs));
      const decayGain = 0.72 + 0.28 * Math.exp(-timeMs / 350);
      const pickNoise = 0.035 * Math.exp(-timeMs / 2.5) * random();
      const sampleIndex = startSample + offset;
      if (sampleIndex < samples.length) {
        samples[sampleIndex] += amplitude
          * attackGain
          * Math.max(0, releaseGain)
          * decayGain
          * (waveform + pickNoise);
      }
    }
  });

  return {
    durationMs,
    references,
    wave: writeMonoPcm16Wave(samples, sampleRate),
  };
}

export async function generateAccuracyFixtures(options = {}) {
  const casesPath = path.resolve(options.casesPath ?? defaultCasesPath);
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory);
  const definition = JSON.parse(await fs.readFile(casesPath, 'utf8'));
  const sampleRate = definition.sampleRate ?? 44100;

  await fs.mkdir(outputDirectory, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    definition: path.relative(repositoryRoot, casesPath).replaceAll('\\', '/'),
    sampleRate,
    cases: [],
  };

  for (const testCase of definition.cases) {
    const synthesized = synthesizeCase(testCase, sampleRate);
    const waveName = `${testCase.name}.wav`;
    const referenceName = `${testCase.name}.references.json`;
    await fs.writeFile(path.join(outputDirectory, waveName), synthesized.wave);
    await fs.writeFile(
      path.join(outputDirectory, referenceName),
      `${JSON.stringify(synthesized.references, null, 2)}\n`,
      'utf8',
    );
    manifest.cases.push({
      name: testCase.name,
      description: testCase.description,
      wave: waveName,
      references: referenceName,
      durationMs: synthesized.durationMs,
      noteCount: synthesized.references.length,
    });
  }

  await fs.writeFile(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return { manifest, outputDirectory };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await generateAccuracyFixtures(options);
  console.log(`Generated ${result.manifest.cases.length} accuracy fixtures`);
  console.log(`Output: ${result.outputDirectory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Accuracy fixture generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
