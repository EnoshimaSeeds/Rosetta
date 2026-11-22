'use strict';

function buildUserAgent() {
  const contact = process.env.ROSETTA_CONTACT_EMAIL
    ? ` (mailto:${String(process.env.ROSETTA_CONTACT_EMAIL).trim()})`
    : '';
  return `RosettaLiteratureVerifier/1.0.0${contact}`;
}

/**
 * Shared Crossref DOI & OpenAlex Search Verifier (zero external dependencies).
 * Enforces network timeout and HTTP status checks.
 */
async function verifyOrSearchLiterature(mode, query, timeoutMs = 8000) {
  const q = String(query || '').trim();
  if (!q) {
    throw new Error('Query cannot be empty.');
  }

  const headers = { 'User-Agent': buildUserAgent() };
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  if (mode === 'doi') {
    const cleanDoi = q.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const url = 'https://api.crossref.org/works/' + encodeURIComponent(cleanDoi);
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      return { verified: false, doi: cleanDoi, httpStatus: res.status };
    }
    const data = await res.json();
    const m = data.message || {};
    return {
      verified: true,
      doi: m.DOI || cleanDoi,
      title: Array.isArray(m.title) ? m.title[0] : (m.title || ''),
      journal: Array.isArray(m['container-title']) ? m['container-title'][0] : '',
      year: m.issued && m.issued['date-parts'] && m.issued['date-parts'][0] ? m.issued['date-parts'][0][0] : null,
      authors: (m.author || []).slice(0, 6).map((a) => [a.given, a.family].filter(Boolean).join(' '))
    };
  }

  const url = 'https://api.openalex.org/works?per-page=8&search=' + encodeURIComponent(q);
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`OpenAlex request failed with HTTP ${res.status}`);
  }
  const data = await res.json();
  const works = (data.results || []).map((w) => ({
    title: w.display_name,
    year: w.publication_year,
    doi: w.doi,
    citedBy: w.cited_by_count,
    venue: w.primary_location && w.primary_location.source ? w.primary_location.source.display_name : '',
    openAccessUrl: w.open_access ? w.open_access.oa_url : null
  }));
  return { query: q, count: works.length, works };
}

module.exports = { verifyOrSearchLiterature };
