/*
 * Edgebook's dependency-free XLSX writer.
 *
 * The browser journal is intentionally a static deployment.  This module
 * writes the small, deterministic OOXML subset required by Edgebook exports
 * and stores it in a standards-compliant ZIP container.  All user-provided
 * strings are inline strings (never formulas), while dates and numbers remain
 * typed spreadsheet values.
 */
(function exposeEdgebookXlsx(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EdgebookXlsx = api;
})(typeof globalThis === 'object' ? globalThis : this, function createEdgebookXlsxApi() {
  'use strict';

  const MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const MAX_SHEETS = 20;
  const MAX_ROWS_PER_SHEET = 100000;
  const MAX_COLUMNS_PER_SHEET = 200;
  const MAX_TOTAL_CELLS = 250000;
  const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
  const MAX_CELL_TEXT = 32767;
  const encoder = new TextEncoder();

  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    crcTable[index] = value >>> 0;
  }

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function xmlText(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .slice(0, MAX_CELL_TEXT)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function xmlAttribute(value) {
    return xmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function concatBytes(chunks) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }

  function littleEndian(size, values) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    for (const [offset, width, value] of values) {
      if (width === 2) view.setUint16(offset, value, true);
      else view.setUint32(offset, value >>> 0, true);
    }
    return bytes;
  }

  function zipStore(entries) {
    const encodedEntries = entries.map(entry => ({ name: encoder.encode(entry.name), data: typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data }));
    const uncompressedBytes = encodedEntries.reduce((sum, entry) => sum + entry.name.length + entry.data.length, 0);
    if (uncompressedBytes > MAX_ARCHIVE_BYTES) throw new Error('Workbook exceeds the 50 MiB safe browser export limit');
    const local = [];
    const central = [];
    let offset = 0;
    for (const entry of encodedEntries) {
      const {name,data} = entry;
      const checksum = crc32(data);
      const localHeader = littleEndian(30, [
        [0, 4, 0x04034b50], [4, 2, 20], [6, 2, 0x0800], [8, 2, 0],
        [10, 2, 0], [12, 2, 0x0021], [14, 4, checksum], [18, 4, data.length],
        [22, 4, data.length], [26, 2, name.length], [28, 2, 0],
      ]);
      local.push(localHeader, name, data);

      const centralHeader = littleEndian(46, [
        [0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [8, 2, 0x0800], [10, 2, 0],
        [12, 2, 0], [14, 2, 0x0021], [16, 4, checksum], [20, 4, data.length],
        [24, 4, data.length], [28, 2, name.length], [30, 2, 0], [32, 2, 0],
        [34, 2, 0], [36, 2, 0], [38, 4, 0], [42, 4, offset],
      ]);
      central.push(centralHeader, name);
      offset += localHeader.length + name.length + data.length;
    }
    const centralBytes = concatBytes(central);
    const end = littleEndian(22, [
      [0, 4, 0x06054b50], [4, 2, 0], [6, 2, 0], [8, 2, entries.length],
      [10, 2, entries.length], [12, 4, centralBytes.length], [16, 4, offset], [20, 2, 0],
    ]);
    return concatBytes([...local, centralBytes, end]);
  }

  function columnName(index) {
    let value = index + 1;
    let name = '';
    while (value > 0) { value -= 1; name = String.fromCharCode(65 + (value % 26)) + name; value = Math.floor(value / 26); }
    return name;
  }

  function excelSerial(date) {
    const millis = date instanceof Date ? date.getTime() : Number.NaN;
    if (!Number.isFinite(millis)) return null;
    return millis / 86400000 + 25569;
  }

  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return null;
  }

  function normalizeCell(value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const type = String(value.type || 'text');
      const style = Number.isInteger(value.style) && value.style >= 0 && value.style <= 10 ? value.style : undefined;
      return { type, value: value.value, style };
    }
    if (value instanceof Date) return { type: 'datetime', value };
    if (typeof value === 'number') return { type: 'number', value };
    if (typeof value === 'boolean') return { type: 'boolean', value };
    if (value === null || value === undefined) return { type: 'blank', value: null };
    return { type: 'text', value };
  }

  function cellXml(cell, ref) {
    const normalized = normalizeCell(cell);
    let style = normalized.style;
    if (style === undefined) {
      style = normalized.type === 'exact_text' ? 10
        : normalized.type === 'date' ? 3
        : normalized.type === 'datetime' ? 4
          : normalized.type === 'money' ? 5
            : normalized.type === 'number' ? 6
              : normalized.type === 'integer' ? 7
                : normalized.type === 'header' ? 2
                  : normalized.type === 'title' ? 1 : 0;
    }
    if (normalized.type === 'blank') return '';
    if (normalized.type === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${normalized.value ? 1 : 0}</v></c>`;
    if (normalized.type === 'number' || normalized.type === 'integer' || normalized.type === 'money') {
      const number = finiteNumber(normalized.value);
      return number === null ? '' : `<c r="${ref}" s="${style}" t="n"><v>${String(number)}</v></c>`;
    }
    if (normalized.type === 'date' || normalized.type === 'datetime') {
      const date = normalized.value instanceof Date ? normalized.value : new Date(normalized.value);
      const serial = excelSerial(date);
      return serial === null ? '' : `<c r="${ref}" s="${style}" t="n"><v>${serial}</v></c>`;
    }
    if (normalized.type === 'formula' || normalized.type === 'formula_money') {
      const formula=String(normalized.value||'');
      const functions=[...formula.matchAll(/\b([A-Z][A-Z0-9_]*)\s*\(/gi)].map(match=>match[1].toUpperCase());
      if(!/^=[A-Z0-9_'" !:$+\-*/().,]+$/i.test(formula)||formula.length>8192||functions.some(name=>!['SUM','SUMIF','SUMIFS'].includes(name)))throw new Error(`Unsafe internal formula at ${ref}`);
      const formulaStyle=normalized.type==='formula_money'?5:style;
      return `<c r="${ref}" s="${formulaStyle}"><f>${xmlText(formula.slice(1))}</f></c>`;
    }
    const text = xmlText(normalized.value);
    const preserve = /^\s|\s$|[\r\n\t]/.test(text) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${preserve}>${text}</t></is></c>`;
  }

  function sanitizeSheetName(value, used) {
    const base = String(value || 'Sheet').replace(/[\\/*?:\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    let suffix = 1;
    while (used.has(name.toLowerCase())) {
      suffix += 1;
      const marker = ` ${suffix}`;
      name = `${base.slice(0, 31 - marker.length)}${marker}`;
    }
    used.add(name.toLowerCase());
    return name;
  }

  function normalizeWorkbook(input) {
    const rawSheets = Array.isArray(input?.sheets) ? input.sheets : [];
    if (!rawSheets.length || rawSheets.length > MAX_SHEETS) throw new Error(`XLSX export requires 1-${MAX_SHEETS} sheets`);
    const used = new Set();
    let totalCells = 0;
    const sheets = rawSheets.map((raw, sheetIndex) => {
      const rows = Array.isArray(raw?.rows) ? raw.rows : [];
      if (rows.length > MAX_ROWS_PER_SHEET) throw new Error(`Sheet ${sheetIndex + 1} exceeds ${MAX_ROWS_PER_SHEET} rows`);
      const columnCount = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
      if (columnCount > MAX_COLUMNS_PER_SHEET) throw new Error(`Sheet ${sheetIndex + 1} exceeds ${MAX_COLUMNS_PER_SHEET} columns`);
      totalCells += rows.length * columnCount;
      if (totalCells > MAX_TOTAL_CELLS) throw new Error(`Workbook exceeds ${MAX_TOTAL_CELLS} cells`);
      return {
        name: sanitizeSheetName(raw?.name, used), rows, columnCount,
        widths: Array.isArray(raw?.widths) ? raw.widths.slice(0, columnCount) : [],
        freezeRows: Math.max(0, Math.min(rows.length, Math.trunc(Number(raw?.freezeRows) || 0))),
        autoFilter: raw?.autoFilter === true,
      };
    });
    return { sheets, creator: String(input?.creator || 'Edgebook').slice(0, 255) };
  }

  function worksheetXml(sheet) {
    const rowXml = sheet.rows.map((row, rowIndex) => {
      const values = Array.isArray(row) ? row : [];
      const cells = values.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowIndex + 1}`)).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const cols = sheet.widths.length
      ? `<cols>${sheet.widths.map((width, index) => {
        const safe = Math.max(5, Math.min(80, Number(width) || 12));
        return `<col min="${index + 1}" max="${index + 1}" width="${safe}" customWidth="1"/>`;
      }).join('')}</cols>` : '';
    const lastColumn = columnName(Math.max(0, sheet.columnCount - 1));
    const dimension = `A1:${lastColumn}${Math.max(1, sheet.rows.length)}`;
    const views = sheet.freezeRows
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const filter = sheet.autoFilter && sheet.rows.length > 0 && sheet.columnCount > 0 ? `<autoFilter ref="A1:${lastColumn}${sheet.rows.length}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<dimension ref="${dimension}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml}</sheetData>${filter}</worksheet>`;
  }

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/><numFmt numFmtId="166" formatCode="#,##0.00;[Red]-#,##0.00;0.00"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="15"/><name val="Aptos Display"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF171A2B"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5B5CE2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FFD8DCEE"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  function buildXlsx(input) {
    const workbook = normalizeWorkbook(input);
    const now = new Date().toISOString();
    const sheetsXml = workbook.sheets.map((sheet, index) => `<sheet name="${xmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheetsXml}</sheets><calcPr calcId="191029"/></workbook>`;
    const workbookRels = workbook.sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('') + `<Relationship Id="rId${workbook.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    const contentOverrides = workbook.sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
    const entries = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${contentOverrides}</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
      { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xmlText(workbook.creator)}</dc:creator><cp:lastModifiedBy>${xmlText(workbook.creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
      { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Edgebook</Application></Properties>` },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}</Relationships>` },
      { name: 'xl/styles.xml', data: stylesXml },
      ...workbook.sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheetXml(sheet) })),
    ];
    return zipStore(entries);
  }

  function buildBlob(input) {
    return new Blob([buildXlsx(input)], { type: MIME_TYPE });
  }

  return Object.freeze({ MIME_TYPE, MAX_TOTAL_CELLS, MAX_ARCHIVE_BYTES, buildXlsx, buildBlob, excelSerial });
});
