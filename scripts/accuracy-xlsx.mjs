import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';

const COLORS = {
  navy: '172554',
  blue: '2563EB',
  paleBlue: 'DBEAFE',
  paleGreen: 'DCFCE7',
  paleRed: 'FEE2E2',
  paleSlate: 'F1F5F9',
  slate: '475569',
  white: 'FFFFFF',
};

function percentage(value) {
  return Number.isFinite(value) ? value : null;
}

function metricValue(summary, key) {
  return summary?.[key] ?? null;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: COLORS.white } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.slate } };
  row.alignment = { vertical: 'middle', wrapText: true };
}

function styleDataRows(sheet, startRow, endRow) {
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    if (rowIndex % 2 === 0 && !row.fill?.type) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleSlate } };
    }
    row.alignment = { vertical: 'top', wrapText: true };
  }
}

function addSummarySheet(workbook, report) {
  const sheet = workbook.addWorksheet('Summary', {
    views: [{ state: 'frozen', ySplit: 10, showGridLines: false }],
  });
  sheet.mergeCells('A1:P2');
  const title = sheet.getCell('A1');
  title.value = report.kind === 'real-world'
    ? 'Disband GP-Referenced Accuracy'
    : 'Disband Note Extraction Accuracy';
  title.font = { bold: true, size: 20, color: { argb: COLORS.white } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  title.alignment = { vertical: 'middle' };

  const metadata = [
    ['Generated', report.generatedAt],
    ['Git', `${report.git?.branch ?? '-'} @ ${report.git?.commit?.slice(0, 12) ?? '-'}`],
    ['Analyzer SHA-256', report.analyzer?.sha256?.slice(0, 16) ?? '-'],
    ['Onset tolerance', report.configuration?.onsetToleranceMs ?? null],
  ];
  metadata.forEach(([label, value], index) => {
    const row = 4 + index;
    sheet.getCell(row, 1).value = label;
    sheet.getCell(row, 1).font = { bold: true, color: { argb: COLORS.slate } };
    sheet.getCell(row, 2).value = value;
    sheet.getCell(row, 2).alignment = { wrapText: true };
  });

  const headerRow = sheet.getRow(10);
  headerRow.values = [
    'Case', 'Track', 'Start (ms)', 'Duration (ms)', 'References', 'Detected',
    'Event F1', 'Strict F1', 'MIDI accuracy', 'Onset mean (ms)', 'Onset P95 (ms)',
    'Offset mean (ms)', 'Offset P95 (ms)', 'Octave errors', 'Polyphonic onsets',
    'Analysis (ms)',
  ];
  styleHeader(headerRow);

  report.results.forEach((result, index) => {
    const metrics = result.metrics;
    const row = sheet.getRow(11 + index);
    row.values = [
      result.name,
      `${result.track?.index ?? '-'} | ${result.track?.name ?? '-'}`,
      result.window?.startMs ?? null,
      result.window?.durationMs ?? null,
      metrics.counts.references,
      metrics.counts.played,
      percentage(metrics.event.f1),
      percentage(metrics.strictNote.f1),
      percentage(metrics.matchedPitch.midiAccuracy),
      metricValue(metrics.timing.absoluteOnsetErrorMs, 'mean'),
      metricValue(metrics.timing.absoluteOnsetErrorMs, 'p95'),
      metricValue(metrics.timing.absoluteOffsetErrorMs, 'mean'),
      metricValue(metrics.timing.absoluteOffsetErrorMs, 'p95'),
      metrics.counts.octaveErrors,
      result.referenceDiagnostics?.polyphonicOnsets ?? null,
      result.elapsedMs,
    ];
  });

  const aggregateRow = sheet.getRow(11 + report.results.length);
  aggregateRow.values = [
    'Aggregate', '-', '-', '-',
    report.aggregate.counts.references,
    report.aggregate.counts.played,
    percentage(report.aggregate.event.f1),
    percentage(report.aggregate.strictNote.f1),
    percentage(report.aggregate.matchedPitch.midiAccuracy),
    metricValue(report.aggregate.timing.absoluteOnsetErrorMs, 'mean'),
    metricValue(report.aggregate.timing.absoluteOnsetErrorMs, 'p95'),
    metricValue(report.aggregate.timing.absoluteOffsetErrorMs, 'mean'),
    metricValue(report.aggregate.timing.absoluteOffsetErrorMs, 'p95'),
    report.aggregate.counts.octaveErrors,
    report.results.reduce(
      (sum, result) => sum + (result.referenceDiagnostics?.polyphonicOnsets ?? 0),
      0,
    ),
    report.results.reduce((sum, result) => sum + result.elapsedMs, 0),
  ];
  aggregateRow.font = { bold: true };
  aggregateRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: COLORS.paleBlue },
  };

  const firstDataRow = 11;
  const lastDataRow = aggregateRow.number;
  for (let column = 7; column <= 9; column += 1) {
    sheet.getColumn(column).numFmt = '0.0%';
  }
  for (let column = 3; column <= 4; column += 1) {
    sheet.getColumn(column).numFmt = '0.00';
  }
  for (let column = 10; column <= 13; column += 1) {
    sheet.getColumn(column).numFmt = '0.00';
  }
  sheet.getColumn(16).numFmt = '0.00';
  styleDataRows(sheet, firstDataRow, lastDataRow - 1);
  sheet.autoFilter = `A10:P${lastDataRow}`;
  [
    28, 42, 14, 15, 12, 11, 12, 12,
    14, 16, 15, 17, 16, 14, 18, 14,
  ].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  ['G', 'H', 'I'].forEach((column) => {
    sheet.addConditionalFormatting({
      ref: `${column}${firstDataRow}:${column}${lastDataRow}`,
      rules: [{
        type: 'colorScale',
        cfvo: [
          { type: 'min' },
          { type: 'percentile', value: 50 },
          { type: 'max' },
        ],
        color: [
          { argb: COLORS.paleRed },
          { argb: 'FEF3C7' },
          { argb: COLORS.paleGreen },
        ],
      }],
    });
  });
}

function addMatchSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Matches', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  const header = sheet.getRow(1);
  header.values = [
    'Case', 'Reference index', 'Detected index', 'Reference MIDI', 'Detected MIDI',
    'MIDI error', 'MIDI match', 'Onset error (ms)', 'Offset error (ms)', 'Cents error',
  ];
  styleHeader(header);

  let rowIndex = 2;
  for (const result of report.results) {
    for (const match of result.metrics.matches) {
      const row = sheet.getRow(rowIndex);
      row.values = [
        result.name,
        match.referenceIndex,
        match.playedIndex,
        match.referenceMidi,
        match.playedMidi,
        match.midiError,
        match.midiMatch,
        match.onsetErrorMs,
        match.offsetErrorMs,
        match.centsError,
      ];
      if (!match.midiMatch) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleRed } };
      }
      rowIndex += 1;
    }
  }
  styleDataRows(sheet, 2, Math.max(1, rowIndex - 1));
  sheet.autoFilter = `A1:J${Math.max(1, rowIndex - 1)}`;
  [28, 16, 15, 16, 15, 12, 12, 17, 17, 14].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  for (let column = 8; column <= 10; column += 1) {
    sheet.getColumn(column).numFmt = '0.00';
  }
}

function addUnmatchedSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Unmatched', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  const header = sheet.getRow(1);
  header.values = ['Case', 'Kind', 'Index', 'Start (ms)', 'End/length (ms)', 'MIDI', 'Hz'];
  styleHeader(header);

  let rowIndex = 2;
  for (const result of report.results) {
    const matchedReferences = new Set(
      result.metrics.matches.map((match) => match.referenceIndex),
    );
    const matchedPlayed = new Set(result.metrics.matches.map((match) => match.playedIndex));
    result.referenceNotes.forEach((note, index) => {
      if (matchedReferences.has(index)) return;
      sheet.addRow([
        result.name, 'missed reference', index, note.timestamp, note.length, note.midi, null,
      ]);
      rowIndex += 1;
    });
    result.playedNotes.forEach((note, index) => {
      if (matchedPlayed.has(index)) return;
      sheet.addRow([
        result.name, 'false positive', index, note.startMs, note.endMs, note.midi, note.hz,
      ]);
      rowIndex += 1;
    });
  }
  styleDataRows(sheet, 2, Math.max(1, rowIndex - 1));
  sheet.autoFilter = `A1:G${Math.max(1, rowIndex - 1)}`;
  [28, 20, 10, 15, 18, 10, 14].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.getColumn(4).numFmt = '0.00';
  sheet.getColumn(5).numFmt = '0.00';
  sheet.getColumn(7).numFmt = '0.00';
}

export async function writeAccuracyWorkbook(report, outputPath) {
  if (path.extname(outputPath).toLowerCase() !== '.xlsx') {
    throw new Error(`Excel report path must end with .xlsx: ${outputPath}`);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Disband accuracy benchmark';
  workbook.created = new Date(report.generatedAt);
  addSummarySheet(workbook, report);
  addMatchSheet(workbook, report);
  addUnmatchedSheet(workbook, report);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}
