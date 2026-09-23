const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'contractors.csv');
const CALENDAR_RANGE = Object.freeze({ min: '2026-09-23', max: '2026-12-31' });

function parseCsv(source) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && source[i + 1] === '\n') i += 1; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(Boolean)) rows.push(row); }
  const headers = (rows.shift() || []).map((x) => x.replace(/^\uFEFF/, '').trim());
  return rows.map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ''])));
}
const list = (value) => value ? value.split('|').map((x) => x.trim()).filter(Boolean) : [];
function loadCatalog(file = DATA_FILE) {
  return parseCsv(fs.readFileSync(file, 'utf8')).map((r) => ({
    id: r.id, name: r.anon_name, categories: list(r.categories), city: r.city,
    cityImputed: r.city_imputed.toLowerCase() === 'true', synthetic: r.synthetic.toLowerCase() === 'true',
    priceFromKzt: Number(r.price_from_kzt), priceImputed: r.price_imputed.toLowerCase() === 'true',
    eventFormats: list(r.event_formats), languages: list(r.languages),
    maxHours: r.max_hours === '' ? null : Number(r.max_hours), busyDates: new Set(list(r.busy_dates)), description: r.description,
  }));
}
module.exports = { ROOT, DATA_FILE, CALENDAR_RANGE, parseCsv, loadCatalog };
