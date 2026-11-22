#!/usr/bin/env node
'use strict';
/**
 * LaTeX Citation Integrity Gate
 * Supports \cite, \parencite, \textcite, \autocite, \citep, \citet, optional [prenote][postnote],
 * strips unescaped % comments, and detects both English & Chinese placeholder markers.
 */
const fs = require('node:fs');

const [texPath, bibPath] = process.argv.slice(2);
if (!texPath || !bibPath) {
  console.error('Usage: node check_tex_citations.cjs <manuscript.tex> <references.bib>');
  process.exit(1);
}

const rawTex = fs.readFileSync(texPath, 'utf8');
const bib = fs.readFileSync(bibPath, 'utf8');

// Strip unescaped % comments line-by-line
const strippedTex = rawTex
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map((line) => line.replace(/(?<!\\)%.*$/, ''))
  .join('\n');

const bibKeys = new Set();
for (const m of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) {
  const key = m[1].trim();
  if (key && !['comment', 'preamble', 'string'].includes(key.toLowerCase())) {
    bibKeys.add(key);
  }
}

const CITE_RE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g;
const citedKeys = new Set();
for (const m of strippedTex.matchAll(CITE_RE)) {
  for (const part of m[1].split(',')) {
    const k = part.trim();
    if (k && k !== '*') citedKeys.add(k);
  }
}

const missingInBib = [...citedKeys].filter((k) => !bibKeys.has(k));
const unusedInBib = [...bibKeys].filter((k) => !citedKeys.has(k));
const TODO_RE = /\b(?:TODO|FIXME)\b|citation\s+needed|待补引用|待核实引用/gi;
const todoMarkers = (strippedTex.match(TODO_RE) || []).length;

const passed = missingInBib.length === 0 && todoMarkers === 0;
console.log(JSON.stringify({
  passed,
  citedCount: citedKeys.size,
  bibCount: bibKeys.size,
  missingInBib,
  unusedInBib,
  todoMarkers
}, null, 2));
process.exit(passed ? 0 : 1);
