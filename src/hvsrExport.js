// Builds the HVSR results workbook: one sheet per data-table option
// (SDOF/FFT x Sx/Sv, Sy/Sv, H/V, Sx, Sy, Sv), each with its mean ± 1σ chart,
// plus an Info sheet with the processing parameters and record penalties.
import { buildXlsx, safeSheetName, STYLE } from './xlsxWriter.js';

export const DOMAINS = ['SDOF', 'FFT'];

// Shared with the data table dropdown in App.jsx
export const TABLE_OPTIONS = [
  { key: 'H1', label: 'Sx/Sv', sheet: 'Sx-Sv', ratio: true },
  { key: 'H2', label: 'Sy/Sv', sheet: 'Sy-Sv', ratio: true },
  { key: 'Comb', label: 'H/V', sheet: 'H-V', ratio: true },
  { key: 'X', label: 'Sx', sheet: 'Sx', ratio: false, color: '0284C7' },
  { key: 'Y', label: 'Sy', sheet: 'Sy', ratio: false, color: 'DC2626' },
  { key: 'Z', label: 'Sv', sheet: 'Sv', ratio: false, color: '57534E' }
];

const DOMAIN_COLORS = { SDOF: '2563EB', FFT: '059669' };
const COMBINATION_LABELS = { 1: '(Sx / Sv)^p', 2: '(Sy / Sv)^p', 3: '(sqrt(Sx*Sy) / Sv)^p' };

// Sheet layout: summary in A:D, chart over F:P, individual records from column R
const RECORDS_FIRST_COL = 17;
const CHART_ANCHOR = { fromCol: 5, fromRow: 1, toCol: 16, toRow: 25 };

export function getSeries(computedData, domain, key) {
  if (!computedData) return null;
  return computedData.ratios[domain][key] || computedData.comps[domain][key] || null;
}

function resultSheet({ computedData, domain, option, selectedIdx, maxFre, totalRecords }) {
  const series = getSeries(computedData, domain, option.key);
  const freqs = domain === 'SDOF' ? computedData.sdofFreqs : computedData.fftFreqs;
  const valStyle = option.ratio ? STYLE.FIXED4 : STYLE.SCI;
  const name = safeSheetName(`${domain} ${option.sheet}`);

  const mean = [], plus = [], minus = [];
  for (let i = 0; i < freqs.length; i++) {
    const m = series.mean[i], s = series.std[i];
    mean.push(m);
    plus.push(m + s);
    // Ratio sheets match the app table (clamped at 0); spectra use a log axis, so non-positive values are left blank
    minus.push(option.ratio ? Math.max(0, m - s) : (m - s > 0 ? m - s : null));
  }

  const header = [
    { v: 'Frequency (Hz)', s: STYLE.HEADER },
    { v: 'Mean', s: STYLE.HEADER },
    { v: 'Mean + 1σ', s: STYLE.HEADER },
    { v: 'Mean - 1σ', s: STYLE.HEADER }
  ];
  header[RECORDS_FIRST_COL - 1] = null;
  selectedIdx.forEach((rec, j) => { header[RECORDS_FIRST_COL + j] = { v: `R ${rec + 1}`, s: STYLE.HEADER }; });

  const rows = [header];
  for (let i = 0; i < freqs.length; i++) {
    const row = [
      { v: freqs[i], s: STYLE.FIXED4 },
      { v: mean[i], s: valStyle },
      { v: plus[i], s: valStyle },
      { v: minus[i], s: valStyle }
    ];
    selectedIdx.forEach((rec, j) => { row[RECORDS_FIRST_COL + j] = { v: series.data[i][rec], s: valStyle }; });
    rows.push(row);
  }

  const color = option.ratio ? DOMAIN_COLORS[domain] : option.color;
  return {
    name,
    rows,
    freezeHeader: true,
    colWidths: [
      { min: 0, max: 3, width: 15 },
      { min: 4, max: 4, width: 3 },
      ...(selectedIdx.length ? [{ min: RECORDS_FIRST_COL, max: RECORDS_FIRST_COL + selectedIdx.length - 1, width: 11 }] : [])
    ],
    chart: {
      anchor: CHART_ANCHOR,
      title: `${domain} ${option.label}: mean ± 1σ (${selectedIdx.length} of ${totalRecords} records)`,
      xTitle: 'Frequency (Hz)',
      yTitle: option.ratio ? `Spectral ratio ${option.label}` : `${option.label} amplitude`,
      xMin: 0,
      xMax: maxFre,
      yMin: option.ratio ? 0 : undefined,
      logY: !option.ratio,
      yFormat: option.ratio ? '0.0000' : '0.00E+00',
      x: { col: 0, firstRow: 1, values: freqs },
      series: [
        { name: 'Mean', col: 1, values: mean, color, width: 2.5 },
        { name: 'Mean + 1σ', col: 2, values: plus, color, width: 1.25, dash: 'dash' },
        { name: 'Mean - 1σ', col: 3, values: minus, color, width: 1.25, dash: 'dash' }
      ]
    }
  };
}

function infoSheet({ fileName, fileData, params, computedData, selectedRecords }) {
  const selectedIdx = selectedRecords.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
  const label = (v) => ({ v, s: STYLE.BOLD });
  const rows = [
    [{ v: 'Parameter', s: STYLE.HEADER }, { v: 'Value', s: STYLE.HEADER }],
    [label('Source file'), fileName],
    [label('Exported'), new Date().toLocaleString('en-GB')],
    [label('Records (total)'), fileData.records],
    [label('Records (selected)'), selectedIdx.length],
    [label('Selected records'), selectedIdx.map(i => i + 1).join(', ')],
    [label('Points per record'), fileData.npoints],
    [label('dt (s)'), params.dt],
    [label('Duration (s)'), Number((fileData.npoints * params.dt).toFixed(6))],
    [label('Vertical channel (Sv)'), `Ch ${params.chV + 1}`],
    [label('Horizontal 1 channel (Sx)'), `Ch ${params.chH1 + 1}`],
    [label('Horizontal 2 channel (Sy)'), `Ch ${params.chH2 + 1}`],
    [label('Max frequency (Hz)'), Number(params.maxfre)],
    [label('SDOF spectral points'), Number(params.nspec)],
    [label('Damping ratio'), Number(params.dratio)],
    [label('Horizontal gain (SDOF)'), Number(params.horGain)],
    [label('SDOF input'), params.sdofInput === 'acceleration' ? 'Acceleration (derivative)' : 'Velocity'],
    [label('FFT window'), params.windowType === 'None' ? 'Rectangular' : params.windowType],
    [label('FFT smoothing (points)'), Number(params.fftSmoothWindow)],
    [label('Exponent p'), Number(params.power)],
    [label('Main plot combination'), COMBINATION_LABELS[params.option] || String(params.option)],
    [label('Penalty range (Hz)'), `${params.penMinF} - ${params.penMaxF}`],
    [label('Penalty domain / ratio'), `${params.penDomain} ${TABLE_OPTIONS.find(o => o.key === params.penRatio)?.label || params.penRatio}`],
    [],
    [{ v: 'Record', s: STYLE.HEADER }, { v: 'Selected', s: STYLE.HEADER }, { v: 'Penalty', s: STYLE.HEADER }]
  ];
  for (let rec = 0; rec < fileData.records; rec++) {
    rows.push([`R ${rec + 1}`, selectedRecords[rec] ? 'Yes' : 'No', { v: computedData.penalties[rec], s: STYLE.FIXED4 }]);
  }
  return {
    name: 'Info',
    rows,
    colWidths: [{ min: 0, max: 0, width: 28 }, { min: 1, max: 1, width: 40 }, { min: 2, max: 2, width: 12 }]
  };
}

// Returns the .xlsx file as a Uint8Array.
// activeDomain / activeKey: the data table's current selection, opened as the active sheet.
export function buildHvsrWorkbook({ fileName, fileData, params, computedData, selectedRecords, activeDomain, activeKey }) {
  const selectedIdx = selectedRecords.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
  const maxFre = Number(params.maxfre) || 20;

  const sheets = [infoSheet({ fileName, fileData, params, computedData, selectedRecords })];
  let activeSheet = 0;
  DOMAINS.forEach(domain => {
    TABLE_OPTIONS.forEach(option => {
      if (domain === activeDomain && option.key === activeKey) activeSheet = sheets.length;
      sheets.push(resultSheet({ computedData, domain, option, selectedIdx, maxFre, totalRecords: fileData.records }));
    });
  });

  return buildXlsx(sheets, { activeSheet });
}
