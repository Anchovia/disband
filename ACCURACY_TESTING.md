# Note extraction accuracy testing

The synthetic accuracy suite measures note extraction against deterministic
ground truth. It complements the runtime benchmark in `BENCHMARKING.md`.

## Generate fixtures

```powershell
npm run accuracy:generate
```

This reads `tests/accuracy/cases.json` and creates WAV/reference pairs under
`tests/accuracy/generated/`. Generated files are ignored by Git because the
case definition and generator are their reproducible source of truth.

The suite currently covers:

- clean guitar-range notes
- low bass notes including E1
- short staccato notes
- sustained notes with vibrato
- legato transitions without silent gaps
- moderate background noise

## Measure accuracy

Build the native analyzer first, then run:

```powershell
npm run accuracy:audio
```

Save a machine-readable report:

```powershell
npm run accuracy:audio -- --output benchmark-results/accuracy-baseline.json
```

Compare a candidate against that baseline:

```powershell
npm run accuracy:audio -- `
  --baseline benchmark-results/accuracy-baseline.json `
  --output benchmark-results/accuracy-candidate.json
```

The command exits with code `2` when the candidate fails an acceptance rule.

Use a different event matching tolerance:

```powershell
npm run accuracy:audio -- --onset-tolerance-ms 80
```

The accuracy command regenerates fixtures by default. Pass `--no-generate` to
reuse the existing generated files.

## Metrics

Reference and detected notes are matched independently from the production
matching code. The matcher preserves note order, maximizes the number of onset
matches inside the configured tolerance, and then minimizes total onset error.

- **Event precision/recall/F1:** onset matched, regardless of pitch
- **Strict note precision/recall/F1:** onset matched and MIDI exactly correct
- **MIDI accuracy:** exact MIDI rate among onset-matched notes
- **Octave error rate:** matched notes displaced by one or more octaves
- **Onset/offset error:** mean, median, p95, and maximum absolute error
- **Attack within 40 ms:** rate matching the default `attackOkWindowMs`
- **Release within 70 ms:** rate matching the default `releaseToleranceMs`
- **Absolute cents error:** pitch error against equal-tempered reference Hz

## Initial regression gate

When `--baseline` is provided, the candidate must satisfy all of these rules:

- aggregate strict Note F1 drop is at most 1 percentage point
- aggregate event F1 drop is at most 1 percentage point
- aggregate MIDI accuracy drop is at most 1 percentage point
- mean onset error increases by at most 5 ms
- mean offset error increases by at most 10 ms
- aggregate octave errors do not increase
- no individual synthetic case loses a MIDI-correct match or gains an octave error

Use `--allow-f1-drop-pp` only when a different aggregate tolerance is explicitly
justified. A speedup does not override a failed per-case pitch rule.

## Interpretation and limits

Synthetic fixtures provide exact, reproducible labels and catch obvious pitch,
timing, split, merge, low-frequency, and noise regressions. They do not prove
real guitar or bass accuracy because synthetic timbre, pickup response, room
noise, and playing techniques are simpler than recorded performances.

Before accepting behavior-changing optimizations, add labeled real recordings
exported from GP/MIDI or manually annotated note events. Keep both synthetic and
real-world groups in the acceptance report.

## GP-referenced real recordings

The Electron app renders Guitar Pro files as the reference score. The same
AlphaTab score data can be used headlessly to measure real recording accuracy.

List the tracks in a GP file:

```powershell
npm run accuracy:gp-reference -- `
  --gp "$HOME\Documents\Disband\Songs\example.gp" `
  --list-tracks
```

Export one score window as analyzer-ready reference JSON:

```powershell
npm run accuracy:gp-reference -- `
  --gp "$HOME\Documents\Disband\Songs\example.gp" `
  --track 3 `
  --start-ms 33250 `
  --duration-ms 26800 `
  --output benchmark-results/example.references.json
```

Real test fixtures use this filename convention:

```text
<exact-gp-filename>__tr-<zero-based-track>__start-<score-ms>__<take>.wav
```

For example:

```text
example.gp__tr-3__start-33250__1.wav
```

Put the corresponding GP file in either `tests/data/scores` (local and ignored
by Git) or `Documents/Disband/Songs`, then run:

```powershell
npm run accuracy:real
```

The command pairs every `tests/data/*.wav` fixture with its GP file and writes:

```text
benchmark-results/accuracy-real.json
benchmark-results/accuracy-real.xlsx
```

The Excel workbook contains summary, matched-note, and unmatched-note sheets.
Use `--baseline` to compare a later analyzer against an earlier real-world
report:

```powershell
npm run accuracy:real -- `
  --baseline benchmark-results/accuracy-real-baseline.json `
  --output benchmark-results/accuracy-real-candidate.json `
  --xlsx benchmark-results/accuracy-real-candidate.xlsx
```

For an arbitrary single WAV, pass the score metadata explicitly:

```powershell
npm run accuracy:real -- `
  --gp "$HOME\Documents\Disband\Songs\example.gp" `
  --track 3 `
  --start-ms 33250 `
  path\to\recording.wav
```

The analyzer currently produces one pitch at a time. Reports therefore include
the number of polyphonic score onsets so chord-heavy tracks are not mistaken
for monophonic detector regressions. GP files and recordings should only be
committed when their redistribution rights are clear.
