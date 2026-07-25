# Audio analysis benchmarking

The audio benchmark measures the existing native analyzer as a black box. It
does not change or instrument the note extraction algorithm, so the same
measurement can be reused for the baseline and every optimized variant.

## Prerequisite

Build the native audio engine so the analyzer exists at:

```text
native/audio-engine/bin/<platform>/disband-audio-analyze[.exe]
```

## Run

Use every WAV fixture in `tests/data`:

```powershell
npm run benchmark:audio
```

Use specific WAV files or change the run count:

```powershell
npm run benchmark:audio -- --warmup 3 --iterations 20 tests/data/example.wav
```

Save a machine-readable report:

```powershell
npm run benchmark:audio -- --output benchmark-results/baseline.json
```

Save JSON and a formatted Excel workbook in the same run:

```powershell
npm run benchmark:audio -- --warmup 3 --iterations 20 `
  --output benchmark-results/baseline.json `
  --xlsx benchmark-results/baseline.xlsx
```

Run `npm run benchmark:audio -- --help` for all options.

## Optional reference notes

If a WAV has a sibling `<name>.references.json`, the benchmark sends that JSON
to the analyzer through stdin. For example:

```text
example.wav
example.references.json
```

This exercises matching and judgment as well as extraction. Without a
reference file, the analyzer still measures the production note extraction
path and reports an empty judgment list.

## Reported values

- End-to-end process time, including process startup, WAV loading, analysis,
  result serialization, and shutdown
- Minimum, median, mean, p95, maximum, and population standard deviation
- Median and p95 real-time factor (`elapsed time / audio duration`)
- Detected note and judgment counts
- SHA-256 hashes for the analyzer, inputs, and outputs
- Git commit, branch, dirty state, and basic machine information

The Excel workbook contains a formatted summary, every measured run, and
reproducibility metadata (input, output, and analyzer hashes).

Warmup runs start new analyzer processes but are excluded from the statistics.
They reduce first-read and operating-system cache effects; they are not an
in-process warm benchmark.

## Comparison rules

Baseline and optimized measurements must use:

1. The same machine and power mode.
2. Release builds from the same toolchain.
3. The same analyzer invocation and WAV/reference fixtures.
4. The same warmup and measured run counts.
5. No unrelated heavy workloads.

Compare median for typical performance and p95 for slow-run regressions.
An optimization is not accepted on speed alone: output stability and separate
accuracy fixtures must also be checked.
