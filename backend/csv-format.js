// Pure CSV dialect + formatting helpers. No DB, no fs. Shared by csv-export.
const BOM = '﻿';
const CRLF = '\r\n';

const DIALECTS = {
  de:  { key: 'de',  delimiter: ';', decimal: ',', label: 'Deutsch (Excel)' },
  rfc: { key: 'rfc', delimiter: ',', decimal: '.', label: 'International (RFC)' },
};

function getDialect(name) {
  return DIALECTS[name] || DIALECTS.de;
}

// Shortest round-trip number string, decimal separator per dialect, no thousands separator.
function formatNumber(value, dialect) {
  if (value === null || value === undefined || typeof value !== 'number' || Number.isNaN(value)) return '';
  let s = String(value); // shortest round-trip representation, always uses '.'
  if (dialect.decimal !== '.') s = s.replace('.', dialect.decimal);
  return s;
}

const INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

// Escape a TEXT cell: CSV-injection guard, then RFC-4180 quoting if needed.
function escapeField(text, dialect) {
  let s = (text === null || text === undefined) ? '' : String(text);
  if (s.length > 0 && INJECTION_CHARS.has(s[0])) s = "'" + s;
  const needsQuote = s.includes(dialect.delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
  if (needsQuote) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Join already-escaped/formatted cells into one CSV line.
function joinRow(cells, dialect) {
  return cells.join(dialect.delimiter) + CRLF;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// From a UTC epoch (ms), produce ISO-8601-with-offset and a local Excel-friendly string,
// both in the host's local timezone (DST-correct via getTimezoneOffset).
function formatTimestamps(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear(), mo = pad2(d.getMonth() + 1), da = pad2(d.getDate());
  const h = pad2(d.getHours()), mi = pad2(d.getMinutes()), se = pad2(d.getSeconds());
  const offMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  return {
    iso: `${y}-${mo}-${da}T${h}:${mi}:${se}${offset}`,
    local: `${y}-${mo}-${da} ${h}:${mi}:${se}`,
  };
}

module.exports = { DIALECTS, getDialect, formatNumber, escapeField, joinRow, formatTimestamps, BOM, CRLF };
