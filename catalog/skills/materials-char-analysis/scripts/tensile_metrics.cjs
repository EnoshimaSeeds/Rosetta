#!/usr/bin/env node
'use strict';
/**
 * Tensile / compression curve metrics from a stress-strain CSV. Zero dependencies.
 *
 * Usage:
 *   node tensile_metrics.cjs <data.csv> --fit-range 0.002,0.01 [options]
 *   node tensile_metrics.cjs <data.csv> --auto [options]
 *
 * Options:
 *   --strain-col <name|index>   strain column (default: first column)
 *   --stress-col <name|index>   stress column (default: second column)
 *   --strain-unit frac|percent  unit of the strain column (default: frac)
 *   --fit-range a,b             strain interval (as fractions) for the modulus fit
 *   --auto                      pick the fit interval automatically (always check it on a plot)
 *   --offset <fraction>         offset for the offset-yield method (default: 0.002 = 0.2 %)
 *
 * Output: JSON on stdout. Stress values keep the unit of the input column;
 * strain values are reported as fractions. Exit code 1 on unusable input.
 */
const fs = require('node:fs');

function fail(message) {
  process.stderr.write(JSON.stringify({ error: message }) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { file: null, strainCol: 0, stressCol: 1, strainUnit: 'frac', fitRange: null, auto: false, offset: 0.002 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto') opts.auto = true;
    else if (a === '--strain-col') opts.strainCol = argv[++i];
    else if (a === '--stress-col') opts.stressCol = argv[++i];
    else if (a === '--strain-unit') opts.strainUnit = argv[++i];
    else if (a === '--offset') opts.offset = Number(argv[++i]);
    else if (a === '--fit-range') {
      const parts = String(argv[++i] || '').split(',').map(Number);
      if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v)) || parts[0] >= parts[1]) {
        fail('--fit-range expects "a,b" with a < b, both as strain fractions.');
      }
      opts.fitRange = parts;
    } else if (a.startsWith('--')) fail(`Unknown option: ${a}`);
    else if (!opts.file) opts.file = a;
  }
  if (!opts.file) fail('Usage: node tensile_metrics.cjs <data.csv> (--fit-range a,b | --auto) [options]');
  if (!opts.fitRange && !opts.auto) fail('Give --fit-range a,b (preferred) or --auto.');
  if (!['frac', 'percent'].includes(opts.strainUnit)) fail('--strain-unit must be frac or percent.');
  if (!Number.isFinite(opts.offset) || opts.offset < 0) fail('--offset must be a non-negative number.');
  return opts;
}

function readTable(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`Cannot read file: ${err.message}`);
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 3) fail('File has fewer than 3 non-empty lines.');
  const delim = [',', ';', '\t'].map((d) => [d, lines[0].split(d).length]).sort((p, q) => q[1] - p[1])[0][0];
  const first = lines[0].split(delim).map((c) => c.trim());
  const hasHeader = first.some((c) => c !== '' && !Number.isFinite(Number(c)));
  const header = hasHeader ? first : null;
  const rows = (hasHeader ? lines.slice(1) : lines).map((l) => l.split(delim).map((c) => Number(c.trim())));
  return { header, rows };
}

function resolveColumn(spec, header, label) {
  if (typeof spec === 'number') return spec;
  if (/^\d+$/.test(String(spec))) return Number(spec);
  if (!header) fail(`${label} column "${spec}" given by name but the file has no header row.`);
  const idx = header.findIndex((h) => h.toLowerCase() === String(spec).toLowerCase());
  if (idx < 0) fail(`${label} column "${spec}" not found. Header: ${header.join(', ')}`);
  return idx;
}

function linearFit(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

function autoFitWindow(strain, stress, utsIdx) {
  const limit = utsIdx + 1;
  const width = Math.max(5, Math.floor(limit * 0.1));
  if (limit < width + 1) return null;
  let best = null;
  let bestAny = null;
  for (let start = 0; start + width <= limit; start++) {
    const fit = linearFit(strain.slice(start, start + width), stress.slice(start, start + width));
    if (!fit || fit.slope <= 0) continue;
    const cand = { start, end: start + width - 1, fit };
    if (!bestAny || fit.r2 > bestAny.fit.r2) bestAny = cand;
    if (fit.r2 >= 0.995 && (!best || fit.slope > best.fit.slope)) best = cand;
  }
  return best || bestAny;
}

function round(v, sig = 6) {
  return Number.isFinite(v) ? Number(v.toPrecision(sig)) : null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { header, rows } = readTable(opts.file);
  const sc = resolveColumn(opts.strainCol, header, 'Strain');
  const tc = resolveColumn(opts.stressCol, header, 'Stress');
  const scale = opts.strainUnit === 'percent' ? 0.01 : 1;

  const strain = [];
  const stress = [];
  let dropped = 0;
  for (const r of rows) {
    const e = r[sc] * scale;
    const s = r[tc];
    if (Number.isFinite(e) && Number.isFinite(s)) { strain.push(e); stress.push(s); } else dropped++;
  }
  if (strain.length < 10) fail(`Only ${strain.length} usable rows; need at least 10.`);

  const warnings = [];
  if (dropped > 0) warnings.push(`${dropped} row(s) skipped because strain or stress was not numeric.`);
  for (let i = 1; i < strain.length; i++) {
    if (strain[i] < strain[i - 1]) {
      warnings.push('Strain is not monotonically increasing (unloading or noise); check the raw curve.');
      break;
    }
  }

  let utsIdx = 0;
  for (let i = 1; i < stress.length; i++) if (stress[i] > stress[utsIdx]) utsIdx = i;

  let fitIdx;
  let fitSource;
  if (opts.fitRange) {
    const [a, b] = opts.fitRange;
    const idx = [];
    for (let i = 0; i < strain.length; i++) if (strain[i] >= a && strain[i] <= b) idx.push(i);
    if (idx.length < 5) fail(`Only ${idx.length} point(s) inside --fit-range ${a},${b}; need at least 5.`);
    fitIdx = { start: idx[0], end: idx[idx.length - 1], points: idx };
    fitSource = 'user';
  } else {
    const win = autoFitWindow(strain, stress, utsIdx);
    if (!win) fail('Automatic fit window not found; give --fit-range a,b.');
    const points = [];
    for (let i = win.start; i <= win.end; i++) points.push(i);
    fitIdx = { start: win.start, end: win.end, points };
    fitSource = 'auto';
    warnings.push('Fit interval was chosen automatically; confirm it on a plot before reporting the modulus.');
  }

  const fit = linearFit(fitIdx.points.map((i) => strain[i]), fitIdx.points.map((i) => stress[i]));
  if (!fit || fit.slope <= 0) fail('Modulus fit failed (zero strain span or non-positive slope).');
  if (fit.r2 < 0.99) warnings.push(`Fit R^2 is ${round(fit.r2, 4)}; the interval may not be linear.`);

  // Offset yield: first crossing of the data with the line through
  // (toe-corrected origin + offset) with slope = modulus.
  const strainAtZeroStress = -fit.intercept / fit.slope;
  const offsetLine = (e) => fit.slope * (e - strainAtZeroStress - opts.offset);
  let yieldPoint = null;
  for (let i = Math.max(fitIdx.end, 1); i < strain.length; i++) {
    const dPrev = stress[i - 1] - offsetLine(strain[i - 1]);
    const dCur = stress[i] - offsetLine(strain[i]);
    if (dPrev > 0 && dCur <= 0) {
      const t = dPrev / (dPrev - dCur);
      yieldPoint = {
        strain: strain[i - 1] + t * (strain[i] - strain[i - 1]),
        stress: stress[i - 1] + t * (stress[i] - stress[i - 1])
      };
      break;
    }
  }
  if (!yieldPoint) warnings.push('No offset-yield crossing found (brittle or elastomeric response); do not report an offset yield.');

  let area = 0;
  for (let i = 1; i < strain.length; i++) area += 0.5 * (stress[i] + stress[i - 1]) * (strain[i] - strain[i - 1]);

  const out = {
    file: opts.file,
    pointsUsed: strain.length,
    modulus: {
      value: round(fit.slope),
      r2: round(fit.r2, 5),
      fitStrainRange: [round(strain[fitIdx.start]), round(strain[fitIdx.end])],
      fitPoints: fit.n,
      fitRangeSource: fitSource,
      method: 'least-squares line over the stated strain interval'
    },
    toeCorrection: { strainAtZeroStress: round(strainAtZeroStress) },
    offsetYield: yieldPoint
      ? { offset: opts.offset, stress: round(yieldPoint.stress), strain: round(yieldPoint.strain) }
      : null,
    ultimate: { stress: round(stress[utsIdx]), strain: round(strain[utsIdx]) },
    lastPoint: { stress: round(stress[stress.length - 1]), strain: round(strain[strain.length - 1]) },
    areaUnderCurve: { value: round(area), note: 'trapezoid rule to the last point; unit = stress unit (strain is dimensionless)' },
    units: { strain: 'fraction', stress: 'same as the input column' },
    warnings
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
