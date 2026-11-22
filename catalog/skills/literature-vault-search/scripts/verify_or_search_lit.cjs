#!/usr/bin/env node
'use strict';
/**
 * Crossref DOI & OpenAlex Scholarly Literature Verifier
 * Usage:
 *   node scripts/verify_or_search_lit.cjs doi <DOI>
 *   node scripts/verify_or_search_lit.cjs search "<keywords>"
 */
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2] || 'search';
const query = process.argv.slice(3).join(' ').trim();

if (!query) {
  console.error('Usage: node verify_or_search_lit.cjs <doi|search> <query>');
  process.exit(1);
}

// Resolve shared verifier when inside Rosetta repo, with standalone fallback when synced to external host
const sharedPath = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'core', 'literature-verifier.cjs');

async function standaloneVerify(m, q) {
  const contact = process.env.ROSETTA_CONTACT_EMAIL ? ` (mailto:${process.env.ROSETTA_CONTACT_EMAIL.trim()})` : '';
  const headers = { 'User-Agent': `RosettaLiteratureVerifier/0.5.1${contact}` };
  const signal = AbortSignal.timeout(8000);
  if (m === 'doi') {
    const cleanDoi = q.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const res = await fetch('https://api.crossref.org/works/' + encodeURIComponent(cleanDoi), { headers, signal });
    if (!res.ok) return { verified: false, doi: cleanDoi, httpStatus: res.status };
    const msg = (await res.json()).message || {};
    return {
      verified: true,
      doi: msg.DOI || cleanDoi,
      title: Array.isArray(msg.title) ? msg.title[0] : (msg.title || ''),
      journal: Array.isArray(msg['container-title']) ? msg['container-title'][0] : '',
      year: msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0] ? msg.issued['date-parts'][0][0] : null,
      authors: (msg.author || []).slice(0, 6).map((a) => [a.given, a.family].filter(Boolean).join(' '))
    };
  }
  const res = await fetch('https://api.openalex.org/works?per-page=8&search=' + encodeURIComponent(q), { headers, signal });
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  const data = await res.json();
  return {
    query: q,
    count: (data.results || []).length,
    works: (data.results || []).map((w) => ({
      title: w.display_name,
      year: w.publication_year,
      doi: w.doi,
      citedBy: w.cited_by_count
    }))
  };
}

const fn = fs.existsSync(sharedPath)
  ? require(sharedPath).verifyOrSearchLiterature
  : standaloneVerify;

fn(mode, query)
  .then((res) => {
    console.log(JSON.stringify(res, null, 2));
    if (mode === 'doi' && !res.verified) process.exit(1);
  })
  .catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
