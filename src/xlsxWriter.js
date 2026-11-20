// Minimal .xlsx writer (Office Open XML) with native Excel scatter charts.
// Only what this app needs: numbers, inline strings, a few cell styles,
// frozen header row, column widths and one chart per sheet.
import { zipSync, strToU8 } from 'fflate';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Cell style indices (see STYLES_XML below)
export const STYLE = {
  DEFAULT: 0,
  HEADER: 1,   // bold, grey fill
  FIXED4: 2,   // 0.0000
  SCI: 3,      // 0.00E+00
  BOLD: 4
};

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function escapeXml(value) {
  return String(value)
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel sheet names: max 31 chars, none of : \ / ? * [ ]
export function safeSheetName(name) {
  return String(name).replace(/[:\\/?*[\]]/g, '-').slice(0, 31) || 'Sheet';
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numStr = (v) => String(Number(v.toPrecision(8)));

function sheetRef(sheetName, col, firstRow, lastRow) {
  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
  const c = colName(col);
  return lastRow === undefined
    ? `${quoted}!$${c}$${firstRow + 1}`
    : `${quoted}!$${c}$${firstRow + 1}:$${c}$${lastRow + 1}`;
}

// --- Worksheet -------------------------------------------------------------

// cell: number | string | null | { v: number|string, s?: styleIndex }
function cellXml(ref, cell) {
  if (cell === null || cell === undefined) return '';
  let v = cell, s = STYLE.DEFAULT;
  if (typeof cell === 'object') { v = cell.v; s = cell.s ?? STYLE.DEFAULT; }
  if (v === null || v === undefined || v === '') return '';
  const sAttr = s ? ` s="${s}"` : '';
  if (typeof v === 'number') {
    if (!isNum(v)) return '';
    return `<c r="${ref}"${sAttr}><v>${numStr(v)}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
}

function worksheetXml(sheet, isActive) {
  const parts = [];
  parts.push(XML_HEAD, `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`);
  parts.push(`<sheetViews><sheetView workbookViewId="0"${isActive ? ' tabSelected="1"' : ''}>`);
  if (sheet.freezeHeader) {
    parts.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
  }
  parts.push('</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>');

  if (sheet.colWidths && sheet.colWidths.length) {
    parts.push('<cols>');
    sheet.colWidths.forEach(({ min, max, width }) => {
      parts.push(`<col min="${min + 1}" max="${max + 1}" width="${width}" customWidth="1"/>`);
    });
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  sheet.rows.forEach((row, r) => {
    if (!row || row.length === 0) return;
    let cells = '';
    for (let c = 0; c < row.length; c++) cells += cellXml(`${colName(c)}${r + 1}`, row[c]);
    if (cells) parts.push(`<row r="${r + 1}">${cells}</row>`);
  });
  parts.push('</sheetData>');
  if (sheet.chart) parts.push('<drawing r:id="rId1"/>');
  parts.push('</worksheet>');
  return parts.join('');
}

// --- Chart -----------------------------------------------------------------

function richText(text, size, bold) {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

function numRefXml(sheetName, col, firstRow, values, formatCode) {
  const lastRow = firstRow + values.length - 1;
  let pts = '';
  values.forEach((v, i) => {
    if (isNum(v)) pts += `<c:pt idx="${i}"><c:v>${numStr(v)}</c:v></c:pt>`;
  });
  return `<c:numRef><c:f>${escapeXml(sheetRef(sheetName, col, firstRow, lastRow))}</c:f>` +
    `<c:numCache><c:formatCode>${escapeXml(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache></c:numRef>`;
}

function axisXml({ id, crossId, pos, title, min, max, log, gridlines, numFmt }) {
  let scaling = '<c:scaling>';
  if (log) scaling += '<c:logBase val="10"/>';
  scaling += '<c:orientation val="minMax"/>';
  if (isNum(max)) scaling += `<c:max val="${max}"/>`;
  if (isNum(min)) scaling += `<c:min val="${min}"/>`;
  scaling += '</c:scaling>';
  return `<c:valAx><c:axId val="${id}"/>${scaling}<c:delete val="0"/><c:axPos val="${pos}"/>` +
    (gridlines ? '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' : '') +
    `<c:title>${richText(title, 1000, true)}<c:overlay val="0"/></c:title>` +
    `<c:numFmt formatCode="${escapeXml(numFmt)}" sourceLinked="0"/>` +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>' +
    '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></c:spPr>' +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
}

// chart: { title, xTitle, yTitle, xMin, xMax, yMin, logY, yFormat,
//          x: { col, firstRow, values }, series: [{ name, col, values, color, width, dash }] }
function chartXml(sheetName, chart) {
  const parts = [];
  parts.push(XML_HEAD, `<c:chartSpace xmlns:c="${NS_CHART}" xmlns:a="${NS_DRAW}" xmlns:r="${NS_REL}">`);
  parts.push('<c:roundedCorners val="0"/><c:chart>');
  parts.push(`<c:title>${richText(chart.title, 1300, true)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`);
  parts.push('<c:plotArea><c:layout/><c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>');

  const xVal = numRefXml(sheetName, chart.x.col, chart.x.firstRow, chart.x.values, '0.0000');
  chart.series.forEach((s, i) => {
    const dash = s.dash ? `<a:prstDash val="${s.dash}"/>` : '';
    parts.push(`<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${escapeXml(s.name)}</c:v></c:tx>`);
    parts.push(`<c:spPr><a:ln w="${Math.round((s.width || 2) * 12700)}" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>${dash}<a:round/></a:ln></c:spPr>`);
    parts.push('<c:marker><c:symbol val="none"/></c:marker>');
    parts.push(`<c:xVal>${xVal}</c:xVal>`);
    parts.push(`<c:yVal>${numRefXml(sheetName, s.col, chart.x.firstRow, s.values, chart.yFormat || 'General')}</c:yVal>`);
    parts.push('<c:smooth val="0"/></c:ser>');
  });

  parts.push('<c:axId val="500001"/><c:axId val="500002"/></c:scatterChart>');
  parts.push(axisXml({ id: 500001, crossId: 500002, pos: 'b', title: chart.xTitle, min: chart.xMin, max: chart.xMax, log: false, gridlines: true, numFmt: '0.0' }));
  parts.push(axisXml({ id: 500002, crossId: 500001, pos: 'l', title: chart.yTitle, min: chart.yMin, log: chart.logY, gridlines: true, numFmt: chart.logY ? '0.0E+00' : '0.0' }));
  parts.push('<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>');
  parts.push('<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>');
  parts.push('<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>');
  parts.push('</c:chartSpace>');
  return parts.join('');
}

function drawingXml(anchor) {
  const { fromCol, fromRow, toCol, toRow } = anchor;
  return XML_HEAD + `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_DRAW}">` +
    '<xdr:twoCellAnchor editAs="oneCell">' +
    `<xdr:from><xdr:col>${fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    `<a:graphic><a:graphicData uri="${NS_CHART}"><c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_REL}" r:id="rId1"/></a:graphicData></a:graphic>` +
    '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
}

// --- Package ---------------------------------------------------------------

const STYLES_XML = XML_HEAD + `<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0000"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="11" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const rels = (items) => XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` +
  items.map(({ id, type, target }) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') +
  '</Relationships>';

// sheets: [{ name, rows, colWidths?, freezeHeader?, chart?: { ...chartSpec, anchor } }]
export function buildXlsx(sheets, { activeSheet = 0 } = {}) {
  const files = {};
  const overrides = [
    ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml']
  ];

  let chartNo = 0;
  sheets.forEach((sheet, i) => {
    const n = i + 1;
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(worksheetXml(sheet, i === activeSheet));
    overrides.push([`/xl/worksheets/sheet${n}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);

    if (sheet.chart) {
      chartNo++;
      files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = strToU8(rels([
        { id: 'rId1', type: `${REL_TYPE}/drawing`, target: `../drawings/drawing${chartNo}.xml` }
      ]));
      files[`xl/drawings/drawing${chartNo}.xml`] = strToU8(drawingXml(sheet.chart.anchor));
      files[`xl/drawings/_rels/drawing${chartNo}.xml.rels`] = strToU8(rels([
        { id: 'rId1', type: `${REL_TYPE}/chart`, target: `../charts/chart${chartNo}.xml` }
      ]));
      files[`xl/charts/chart${chartNo}.xml`] = strToU8(chartXml(sheet.name, sheet.chart));
      overrides.push([`/xl/drawings/drawing${chartNo}.xml`, 'application/vnd.openxmlformats-officedocument.drawing+xml']);
      overrides.push([`/xl/charts/chart${chartNo}.xml`, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);
    }
  });

  files['xl/workbook.xml'] = strToU8(XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<bookViews><workbookView activeTab="${activeSheet}"/></bookViews><sheets>` +
    sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>');

  files['xl/_rels/workbook.xml.rels'] = strToU8(rels([
    ...sheets.map((_, i) => ({ id: `rId${i + 1}`, type: `${REL_TYPE}/worksheet`, target: `worksheets/sheet${i + 1}.xml` })),
    { id: `rId${sheets.length + 1}`, type: `${REL_TYPE}/styles`, target: 'styles.xml' }
  ]));
  files['xl/styles.xml'] = strToU8(STYLES_XML);

  files['_rels/.rels'] = strToU8(rels([
    { id: 'rId1', type: `${REL_TYPE}/officeDocument`, target: 'xl/workbook.xml' }
  ]));

  files['[Content_Types].xml'] = strToU8(XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
    '</Types>');

  return zipSync(files, { level: 6 });
}
