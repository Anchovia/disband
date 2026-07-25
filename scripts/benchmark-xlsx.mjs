import ExcelJS from 'exceljs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const COLORS = {
  navy: '172554',
  blue: '2563EB',
  paleBlue: 'DBEAFE',
  paleGreen: 'DCFCE7',
  paleRed: 'FEE2E2',
  slate: '475569',
  paleSlate: 'F1F5F9',
  white: 'FFFFFF',
};

function setSectionTitle(cell, text) {
  cell.value = text;
  cell.font = { bold: true, color: { argb: COLORS.white } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.slate } };
  cell.alignment = { vertical: 'middle' };
}

function writeMatrix(worksheet, startRow, startColumn, matrix) {
  matrix.forEach((values, rowOffset) => {
    values.forEach((value, columnOffset) => {
      worksheet.getCell(startRow + rowOffset, startColumn + columnOffset).value = value;
    });
  });
}

function setNumberFormat(worksheet, startRow, endRow, startColumn, endColumn, format) {
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      worksheet.getCell(row, column).numFmt = format;
    }
  }
}

function setColumnWidths(worksheet, widths) {
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
}

function styleKeyValueBlock(worksheet, range) {
  const [start, end] = range.split(':');
  const startCell = worksheet.getCell(start);
  const endCell = worksheet.getCell(end);
  for (let row = startCell.row; row <= endCell.row; row += 1) {
    const keyCell = worksheet.getCell(row, startCell.col);
    const valueCell = worksheet.getCell(row, endCell.col);
    keyCell.font = { bold: true, color: { argb: COLORS.slate } };
    keyCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleSlate } };
    valueCell.alignment = { wrapText: true, vertical: 'top' };
  }
}

function uniqueCountValue(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.length === 1 ? values[0] : values.join('/');
}

function addSummarySheet(workbook, report) {
  const sheet = workbook.addWorksheet('Summary', {
    views: [{ state: 'frozen', ySplit: 14, showGridLines: false }],
    properties: { defaultRowHeight: 18 },
  });

  sheet.mergeCells('A1:N2');
  const title = sheet.getCell('A1');
  title.value = 'Disband Audio Benchmark';
  title.font = { bold: true, size: 20, color: { argb: COLORS.white } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };

  sheet.mergeCells('A4:C4');
  sheet.mergeCells('D4:H4');
  setSectionTitle(sheet.getCell('A4'), 'Run metadata');
  setSectionTitle(sheet.getCell('D4'), 'System');
  for (let row = 5; row <= 11; row += 1) {
    sheet.mergeCells(row, 2, row, 3);
    sheet.mergeCells(row, 5, row, 8);
  }

  const generatedAt = new Date(report.generatedAt);
  writeMatrix(sheet, 5, 1, [
    ['Generated', Number.isNaN(generatedAt.getTime()) ? report.generatedAt : generatedAt],
    ['Branch', report.git.branch ?? 'unknown'],
    ['Commit', report.git.commit?.slice(0, 12) ?? 'unknown'],
    ['Working tree', report.git.dirty ? 'Dirty' : 'Clean'],
    ['Measured runs', report.configuration.iterations],
    ['Warmup runs', report.configuration.warmup],
    ['Analyzer SHA-256', report.analyzer.sha256.slice(0, 12)],
  ]);
  writeMatrix(sheet, 5, 4, [
    ['Platform', report.system.platform],
    ['OS release', report.system.release],
    ['Architecture', report.system.architecture],
    ['CPU', report.system.cpuModel ?? 'unknown'],
    ['Logical CPUs', report.system.logicalCpuCount],
    ['Memory', report.system.totalMemoryBytes / (1024 ** 3)],
    ['Node', report.system.nodeVersion],
  ]);
  styleKeyValueBlock(sheet, 'A5:B11');
  styleKeyValueBlock(sheet, 'D5:E11');
  sheet.getCell('B5').numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.getCell('E10').numFmt = '0.00 "GiB"';

  const summaryRows = report.results.map((result) => [
    result.file,
    result.durationMs / 1000,
    result.measuredRuns,
    result.timing.minMs,
    result.timing.medianMs,
    result.timing.meanMs,
    result.timing.p95Ms,
    result.timing.maxMs,
    result.timing.standardDeviationMs,
    result.realTimeFactor.median,
    result.realTimeFactor.p95,
    uniqueCountValue(result.output.playedNoteCounts),
    uniqueCountValue(result.output.judgmentCounts),
    result.output.deterministic ? 'Yes' : 'No',
  ]);

  sheet.addTable({
    name: 'BenchmarkSummary',
    ref: 'A14',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [
      { name: 'Audio file' },
      { name: 'Duration (s)' },
      { name: 'Runs' },
      { name: 'Min (ms)' },
      { name: 'Median (ms)' },
      { name: 'Mean (ms)' },
      { name: 'P95 (ms)' },
      { name: 'Max (ms)' },
      { name: 'Std dev (ms)' },
      { name: 'Median RTF' },
      { name: 'P95 RTF' },
      { name: 'Notes' },
      { name: 'Judgments' },
      { name: 'Stable' },
    ],
    rows: summaryRows,
  });

  const finalRow = 14 + summaryRows.length;
  if (summaryRows.length > 0) {
    setNumberFormat(sheet, 15, finalRow, 2, 2, '0.00');
    setNumberFormat(sheet, 15, finalRow, 4, 9, '0.00');
    setNumberFormat(sheet, 15, finalRow, 10, 11, '0.0000');
    sheet.addConditionalFormatting({
      ref: `N15:N${finalRow}`,
      rules: [
        {
          type: 'containsText',
          operator: 'containsText',
          text: 'Yes',
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleGreen } },
          },
        },
        {
          type: 'containsText',
          operator: 'containsText',
          text: 'No',
          style: {
            fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleRed } },
          },
        },
      ],
    });
  }

  setColumnWidths(sheet, [
    44, 14, 10, 13, 14, 13, 13, 13, 15, 14, 12, 10, 12, 10,
  ]);
  sheet.getColumn(1).alignment = { vertical: 'top', wrapText: true };
  for (let column = 2; column <= 13; column += 1) {
    sheet.getColumn(column).alignment = { horizontal: 'right', vertical: 'middle' };
  }
  sheet.getColumn(14).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;
  sheet.getRow(2).height = 24;
  for (let row = 15; row <= finalRow; row += 1) {
    sheet.getRow(row).height = 36;
  }

  return sheet;
}

function addRawRunsSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Raw Runs', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  const rows = [];
  for (const result of report.results) {
    result.runTimesMs.forEach((elapsedMs, index) => {
      rows.push([
        result.file,
        index + 1,
        elapsedMs,
        result.durationMs / 1000,
        elapsedMs / result.durationMs,
      ]);
    });
  }

  sheet.addTable({
    name: 'BenchmarkRawRuns',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [
      { name: 'Audio file' },
      { name: 'Run' },
      { name: 'Elapsed (ms)' },
      { name: 'Duration (s)' },
      { name: 'RTF' },
    ],
    rows,
  });

  const finalRow = 1 + rows.length;
  if (rows.length > 0) {
    setNumberFormat(sheet, 2, finalRow, 3, 4, '0.00');
    setNumberFormat(sheet, 2, finalRow, 5, 5, '0.0000');
  }
  setColumnWidths(sheet, [44, 10, 16, 16, 12]);
  sheet.getColumn(1).alignment = { vertical: 'middle', wrapText: true };
  for (let column = 2; column <= 5; column += 1) {
    sheet.getColumn(column).alignment = { horizontal: 'right', vertical: 'middle' };
  }
  for (let row = 2; row <= finalRow; row += 1) {
    sheet.getRow(row).height = 36;
  }
  return sheet;
}

function addMetadataSheet(workbook, report) {
  const sheet = workbook.addWorksheet('Metadata', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
  });
  const rows = [
    ['Generated at', report.generatedAt],
    ['Git branch', report.git.branch ?? 'unknown'],
    ['Git commit', report.git.commit ?? 'unknown'],
    ['Working tree dirty', report.git.dirty],
    ['Analyzer path', report.analyzer.path],
    ['Analyzer SHA-256', report.analyzer.sha256],
    ['Platform', report.system.platform],
    ['OS release', report.system.release],
    ['Architecture', report.system.architecture],
    ['CPU model', report.system.cpuModel ?? 'unknown'],
    ['Logical CPU count', report.system.logicalCpuCount],
    ['Total memory bytes', report.system.totalMemoryBytes],
    ['Node version', report.system.nodeVersion],
  ];
  for (const result of report.results) {
    rows.push([`${result.file} SHA-256`, result.audioSha256]);
    rows.push([`${result.file} reference`, result.referenceFile ?? 'none']);
    rows.push([`${result.file} output SHA-256`, result.output.hashes.join(', ')]);
  }

  sheet.addTable({
    name: 'BenchmarkMetadata',
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [{ name: 'Field' }, { name: 'Value' }],
    rows,
  });
  setColumnWidths(sheet, [76, 100]);
  sheet.getColumn(2).alignment = { vertical: 'top', wrapText: true };
  return sheet;
}

export async function writeBenchmarkWorkbook(report, outputPath) {
  if (path.extname(outputPath).toLowerCase() !== '.xlsx') {
    throw new Error(`Excel report path must end with .xlsx: ${outputPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Disband audio benchmark';
  workbook.created = new Date(report.generatedAt);
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  addSummarySheet(workbook, report);
  addRawRunsSheet(workbook, report);
  addMetadataSheet(workbook, report);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}
