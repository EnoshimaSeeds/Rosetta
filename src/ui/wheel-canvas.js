'use strict';

window.RosettaWheel = (function () {
  // Deterministic celestial starfield for the astrolabe void
  const STARS = Array.from({ length: 42 }, (_, i) => {
    const s1 = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
    const s2 = Math.sin(i * 78.233 + 1.618) * 24634.6345;
    const s3 = Math.sin(i * 39.425 + 2.718) * 19283.4712;
    const f1 = s1 - Math.floor(s1);
    const f2 = s2 - Math.floor(s2);
    const f3 = s3 - Math.floor(s3);
    return {
      angle: f1 * Math.PI * 2,
      radFrac: 0.42 + f2 * 0.48,
      size: 0.7 + f3 * 1.4,
      phase: f2 * Math.PI * 2,
      speed: 0.85 + f1 * 1.5,
      cool: i % 3 === 0
    };
  });

  // Full-viewport ambient starfield for wide/fullscreen observatory depth
  const FIELD_STARS = Array.from({ length: 34 }, (_, i) => {
    const h1 = Math.sin(i * 45.164 + 1.23) * 19384.231;
    const h2 = Math.sin(i * 91.732 + 6.41) * 31415.926;
    const h3 = Math.sin(i * 19.371 + 3.17) * 27182.818;
    const fx = h1 - Math.floor(h1), fy = h2 - Math.floor(h2), fz = h3 - Math.floor(h3);
    return { nx: 0.03 + fx * 0.94, ny: 0.04 + fy * 0.92, size: 0.65 + fz * 1.15, phase: (fx + fy) * Math.PI * 2, speed: 0.55 + fz * 1.1, cool: i % 3 !== 0 };
  });

  const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
  const LIGHT_DIR = { x: -0.44, y: -0.56, z: 0.7 };

  function parseHexRgb(hex) {
    const clean = String(hex || '#e8742c').replace('#', '').trim();
    if (clean.length === 3) {
      return [
        parseInt(clean[0] + clean[0], 16) || 232,
        parseInt(clean[1] + clean[1], 16) || 116,
        parseInt(clean[2] + clean[2], 16) || 44
      ];
    }
    if (clean.length === 6) {
      return [
        parseInt(clean.slice(0, 2), 16) || 232,
        parseInt(clean.slice(2, 4), 16) || 116,
        parseInt(clean.slice(4, 6), 16) || 44
      ];
    }
    return [232, 116, 44];
  }

  function mixRgb(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function rgba(rgb, a) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  function safeClose(ctx) {
    if (typeof ctx.closePath === 'function') ctx.closePath();
  }

  function computeGeometry(w, h) {
    const projW = Math.max(360, Math.min(660, w * 0.315));
    const projRight = Math.max(28, Math.min(104, w * 0.042));
    const projLeft = w - projRight - projW;
    const bridgeGap = Math.max(46, Math.min(132, w * 0.052));
    const availWheelRight = projLeft - bridgeGap;
    const rIn = Math.max(196, Math.min(450, h * 0.355, availWheelRight * 0.39));
    const cardW = Math.max(246, Math.min(448, availWheelRight * 0.37, w * 0.235));
    const cardH = Math.round(Math.max(92, Math.min(136, h * 0.132)));
    const gap = Math.round(Math.max(14, Math.min(22, h * 0.017)));
    const rOut = rIn + cardW;
    const idealCx = availWheelRight - rOut;
    const minCx = Math.max(166, Math.min(rIn + 36, w * 0.255));
    const cx = Math.max(166, Math.min(availWheelRight - rOut, Math.max(minCx, idealCx)));
    const cy = h * 0.5;
    const step = (cardH + gap) / (rIn + cardW * 0.45);
    const hubScale = Math.max(0.95, Math.min(1.42, rIn / 260));
    return { w, h, cardW, cardH, rIn, rOut, cx, cy, step, projW, projRight, projLeft, hubScale };
  }

  function drawObservatoryFieldAndBridge(ctx, geom, t, phi, accentRgb, pulse, reducedMotion) {
    const { w, h, cx, cy, rOut, projLeft } = geom;

    // 1. Subtle full-viewport stardust & hairline astronomical coordinate axes
    for (let i = 0; i < FIELD_STARS.length; i++) {
      const s = FIELD_STARS[i];
      const sx = s.nx * w, sy = s.ny * h;
      const dx = sx - cx, dy = sy - cy;
      if (dx * dx + dy * dy < rOut * rOut * 0.72) continue;
      const twinkle = reducedMotion ? 0.55 : 0.28 + 0.72 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
      ctx.beginPath();
      ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
      ctx.fillStyle = s.cool ? `rgba(206, 220, 242, ${(0.24 * twinkle).toFixed(3)})` : rgba(accentRgb, 0.22 * twinkle);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(255, 214, 170, 0.052)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
    ctx.stroke();

    // Faint extended outer orbital arcs grounding wide/2K screens
    for (const oa of [{ r: rOut + 86, alpha: 0.085, ticks: 24 }, { r: rOut + 204, alpha: 0.048, ticks: 18 }]) {
      ctx.beginPath();
      ctx.arc(cx, cy, oa.r, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(accentRgb, oa.alpha);
      ctx.lineWidth = 0.8;
      ctx.stroke();
      for (let k = 0; k < oa.ticks; k++) {
        const a = (k / oa.ticks) * Math.PI * 2 - phi * 0.12;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (oa.r - 4), cy + Math.sin(a) * (oa.r - 4));
        ctx.lineTo(cx + Math.cos(a) * (oa.r + 4), cy + Math.sin(a) * (oa.r + 4));
        ctx.strokeStyle = 'rgba(255, 214, 170, 0.09)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    // 2. Luminous Optical Projection Conduit linking active 3-o'clock card -> right glass slab
    const x0 = cx + rOut + 10;
    const x1 = projLeft - 14;
    const span = x1 - x0;
    if (span <= 22) return;
    const midX = (x0 + x1) * 0.5;
    const glowR = Math.max(70, span * 0.85);
    const conduitGlow = ctx.createRadialGradient(midX, cy, 4, midX, cy, glowR);
    conduitGlow.addColorStop(0, rgba(accentRgb, 0.14 + pulse * 0.1));
    conduitGlow.addColorStop(0.55, rgba(accentRgb, 0.045));
    conduitGlow.addColorStop(1, 'rgba(15, 11, 9, 0)');
    ctx.fillStyle = conduitGlow;
    ctx.beginPath(); ctx.arc(midX, cy, glowR, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = rgba(accentRgb, 0.42 + pulse * 0.22);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 214, 168, 0.14)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(x0 + 4, cy - 12); ctx.lineTo(x1, cy - 34);
    ctx.moveTo(x0 + 4, cy + 12); ctx.lineTo(x1, cy + 34);
    ctx.stroke();

    for (const f of (span > 80 ? [0.24, 0.5, 0.76] : [0.5])) {
      ctx.save();
      ctx.translate(x0 + span * f, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = f === 0.5 ? 'rgba(255, 230, 194, 0.72)' : rgba(accentRgb, 0.48);
      const s = f === 0.5 ? 2.6 : 1.7;
      if (typeof ctx.fillRect === 'function') ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.restore();
    }

    if (!reducedMotion) {
      const px = x0 + span * ((t * 0.38) % 1);
      const pGlow = ctx.createRadialGradient(px, cy, 0.5, px, cy, 12);
      pGlow.addColorStop(0, 'rgba(255, 244, 224, 0.85)');
      pGlow.addColorStop(0.45, rgba(accentRgb, 0.36));
      pGlow.addColorStop(1, rgba(accentRgb, 0));
      ctx.fillStyle = pGlow;
      ctx.beginPath(); ctx.arc(px, cy, 12, 0, Math.PI * 2); ctx.fill();
    }
  }

  // 3x3 Rotation matrix helpers for genuine nested hierarchical gimbal transforms
  function matMul(A, B) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        out[r * 3 + c] =
          A[r * 3 + 0] * B[0 * 3 + c] +
          A[r * 3 + 1] * B[1 * 3 + c] +
          A[r * 3 + 2] * B[2 * 3 + c];
      }
    }
    return out;
  }

  function rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, -s, 0, s, c];
  }

  function rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, 0, s, 0, 1, 0, -s, 0, c];
  }

  function rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, -s, 0, s, c, 0, 0, 0, 1];
  }

  function applyMat(m, x, y, z) {
    return {
      x: m[0] * x + m[1] * y + m[2] * z,
      y: m[3] * x + m[4] * y + m[5] * z,
      z: m[6] * x + m[7] * y + m[8] * z
    };
  }

  function projectPoint(p, focal) {
    const scale = focal / (focal - p.z);
    return { x: p.x * scale, y: p.y * scale, z: p.z, scale };
  }

  // Build silky seamless cylindrical 3D armillary strap segments into shared Z-sorted queue
  function pushGimbalRing(items, mat, cfg, focal) {
    const { R, halfW, segCount, faceRgb, edgeRgb, rearRgb, tickStep, kind } = cfg;
    const overlap = (Math.PI * 2) / segCount * 0.14;
    for (let i = 0; i < segCount; i++) {
      const u0 = (i / segCount) * Math.PI * 2;
      const u1 = ((i + 1) / segCount) * Math.PI * 2;
      const u1Pad = u1 + overlap;
      const uMid = (u0 + u1) * 0.5;
      const c0 = Math.cos(u0), s0 = Math.sin(u0);
      const c1 = Math.cos(u1), s1 = Math.sin(u1);
      const c1p = Math.cos(u1Pad), s1p = Math.sin(u1Pad);

      const q00 = applyMat(mat, c0 * R, s0 * R, -halfW);
      const q10 = applyMat(mat, c1 * R, s1 * R, -halfW);
      const q11 = applyMat(mat, c1 * R, s1 * R, halfW);
      const q01 = applyMat(mat, c0 * R, s0 * R, halfW);
      const q10p = applyMat(mat, c1p * R, s1p * R, -halfW);
      const q11p = applyMat(mat, c1p * R, s1p * R, halfW);

      const nWorld = applyMat(mat, Math.cos(uMid), Math.sin(uMid), 0);
      const ndl = Math.abs(nWorld.x * LIGHT_DIR.x + nWorld.y * LIGHT_DIR.y + nWorld.z * LIGHT_DIR.z);

      const p00 = projectPoint(q00, focal);
      const p10 = projectPoint(q10, focal);
      const p11 = projectPoint(q11, focal);
      const p01 = projectPoint(q01, focal);
      const p10p = projectPoint(q10p, focal);
      const p11p = projectPoint(q11p, focal);
      const zAvg = (q00.z + q10.z + q11.z + q01.z) * 0.25;

      items.push({
        type: 'quad',
        kind,
        idx: i,
        tickStep,
        R,
        p00, p10, p11, p01, p10p, p11p,
        z: zAvg,
        ndl,
        faceRgb,
        edgeRgb,
        rearRgb
      });
    }
  }

  // Push physical gimbal pivot pins joining outer ring -> inner nested ring
  function pushPivotPins(items, mat, rOuter, rInner, angleOffsets, pinRgb, focal) {
    for (let k = 0; k < angleOffsets.length; k++) {
      const a = angleOffsets[k];
      const ca = Math.cos(a), sa = Math.sin(a);
      const qA = applyMat(mat, ca * rOuter, sa * rOuter, 0);
      const qB = applyMat(mat, ca * rInner, sa * rInner, 0);
      const pA = projectPoint(qA, focal);
      const pB = projectPoint(qB, focal);
      items.push({
        type: 'pin',
        pA,
        pB,
        z: (qA.z + qB.z) * 0.5,
        rgb: pinRgb
      });
    }
  }

  function drawStarfieldAndDialBase(ctx, rIn, t, phi, accentRgb, reducedMotion) {
    const slow = reducedMotion ? 0 : t * 0.045;

    ctx.save();
    ctx.rotate(slow * 0.35 - phi * 0.2);

    // Subtle inscribed celestial octagram & 12 house lines
    for (let sq = 0; sq < 2; sq++) {
      ctx.save();
      ctx.rotate((sq * Math.PI) / 4);
      const sideR = rIn * 0.77;
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        const px = Math.cos(a) * sideR;
        const py = Math.sin(a) * sideR;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      safeClose(ctx);
      ctx.strokeStyle = 'rgba(243, 211, 161, 0.065)';
      ctx.lineWidth = 0.85;
      ctx.stroke();
      ctx.restore();
    }

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (rIn * 0.44), Math.sin(a) * (rIn * 0.44));
      ctx.lineTo(Math.cos(a) * (rIn * 0.9), Math.sin(a) * (rIn * 0.9));
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(245, 208, 156, 0.1)' : 'rgba(166, 144, 128, 0.048)';
      ctx.lineWidth = i % 3 === 0 ? 0.95 : 0.65;
      ctx.stroke();
    }

    // Antique brass Roman numerals along outer engraved track
    if (typeof ctx.fillText === 'function') {
      ctx.font = `500 ${Math.max(8.5, Math.round(rIn * 0.039))}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const numR = rIn * 0.835;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
        ctx.save();
        ctx.translate(Math.cos(a) * numR, Math.sin(a) * numR);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillStyle = i % 3 === 0 ? 'rgba(255, 214, 165, 0.34)' : 'rgba(186, 162, 140, 0.21)';
        ctx.fillText(ROMAN[i], 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();

    // Twinkling celestial stardust
    for (let i = 0; i < STARS.length; i++) {
      const st = STARS[i];
      const a = st.angle + slow * (st.cool ? -0.35 : 0.25) - phi * 0.14;
      const rr = rIn * st.radFrac;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      const pulse = reducedMotion ? 0.6 : 0.32 + 0.68 * (0.5 + 0.5 * Math.sin(t * st.speed + st.phase));
      ctx.beginPath();
      ctx.arc(px, py, st.size, 0, Math.PI * 2);
      ctx.fillStyle = st.cool
        ? `rgba(218, 229, 246, ${(0.42 * pulse).toFixed(3)})`
        : rgba(accentRgb, 0.36 * pulse);
      ctx.fill();
    }
  }

  function renderSortedScenePass(ctx, items, frontPass, rIn, t, reducedMotion) {
    const filtered = items
      .filter((it) => (frontPass ? it.z >= 0 : it.z < 0))
      .sort((a, b) => a.z - b.z);

    for (let i = 0; i < filtered.length; i++) {
      const it = filtered[i];

      if (it.type === 'quad') {
        const depthNorm = Math.max(0, Math.min(1, (it.z + rIn * 0.8) / (rIn * 1.6)));

        // Smooth brushed metallic translucency: front ring visibly crosses IN FRONT OF ROSETTA
        // like smoked-gold / brushed-silver glass-metal so the core feels truly enclosed inside!
        const fillAlpha = frontPass
          ? 0.24 + depthNorm * 0.22 + it.ndl * 0.16
          : 0.06 + depthNorm * 0.1 + it.ndl * 0.05;
        const fillRgb = frontPass ? mixRgb(it.faceRgb, it.edgeRgb, it.ndl * 0.35) : it.rearRgb;

        ctx.beginPath();
        ctx.moveTo(it.p00.x, it.p00.y);
        ctx.lineTo(it.p10p.x, it.p10p.y);
        ctx.lineTo(it.p11p.x, it.p11p.y);
        ctx.lineTo(it.p01.x, it.p01.y);
        safeClose(ctx);
        ctx.fillStyle = rgba(fillRgb, fillAlpha);
        ctx.fill();

        // Crisp machined double bevel rims along top & bottom edges of the metal strap
        const rimAlpha = frontPass
          ? 0.42 + depthNorm * 0.38 + it.ndl * 0.18
          : 0.11 + depthNorm * 0.17;
        ctx.strokeStyle = rgba(frontPass ? it.edgeRgb : it.rearRgb, rimAlpha);
        ctx.lineWidth = frontPass ? (it.kind === 'outer' ? 1.45 : 1.2) : 0.8;

        ctx.beginPath();
        ctx.moveTo(it.p00.x, it.p00.y);
        ctx.lineTo(it.p10.x, it.p10.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(it.p01.x, it.p01.y);
        ctx.lineTo(it.p11.x, it.p11.y);
        ctx.stroke();

        // Delicate rim micro-notches (subtle watchmaker tick without blocky stripes)
        if (frontPass && it.idx % it.tickStep === 0) {
          const major = it.idx % (it.tickStep * 2) === 0;
          const frac = major ? 0.34 : 0.2;
          const nx = it.p00.x + (it.p01.x - it.p00.x) * frac;
          const ny = it.p00.y + (it.p01.y - it.p00.y) * frac;
          ctx.beginPath();
          ctx.moveTo(it.p00.x, it.p00.y);
          ctx.lineTo(nx, ny);
          ctx.strokeStyle = rgba(it.edgeRgb, major ? 0.46 : 0.24);
          ctx.lineWidth = major ? 1 : 0.65;
          ctx.stroke();
        }
      } else if (it.type === 'pin') {
        const a = frontPass ? 0.78 : 0.32;
        ctx.beginPath();
        ctx.moveTo(it.pA.x, it.pA.y);
        ctx.lineTo(it.pB.x, it.pB.y);
        ctx.strokeStyle = rgba(it.rgb, a);
        ctx.lineWidth = frontPass ? 2.1 : 1.3;
        ctx.stroke();

        // Rivet jewel cap on the gimbal hinge
        ctx.beginPath();
        ctx.arc((it.pA.x + it.pB.x) * 0.5, (it.pA.y + it.pB.y) * 0.5, frontPass ? 2.6 : 1.8, 0, Math.PI * 2);
        ctx.fillStyle = rgba([255, 240, 214], a);
        ctx.fill();
      } else if (it.type === 'mote') {
        const a = frontPass ? 0.85 : 0.32;
        const rad = (frontPass ? 6.5 : 4.2) * it.p.scale;
        const g = ctx.createRadialGradient(it.p.x, it.p.y, 0.5, it.p.x, it.p.y, rad);
        g.addColorStop(0, rgba([255, 248, 232], a));
        g.addColorStop(0.45, rgba(it.rgb, a * 0.48));
        g.addColorStop(1, rgba(it.rgb, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(it.p.x, it.p.y, rad, 0, Math.PI * 2);
        ctx.fill();
      } else if (it.type === 'sol') {
        const depthAlpha = frontPass ? 1 : 0.48;
        const rad = 21 * it.p.scale;
        const solGlow = ctx.createRadialGradient(it.p.x, it.p.y, 1, it.p.x, it.p.y, rad);
        solGlow.addColorStop(0, `rgba(255, 248, 224, ${(0.98 * depthAlpha).toFixed(3)})`);
        solGlow.addColorStop(0.32, `rgba(245, 174, 88, ${(0.72 * depthAlpha).toFixed(3)})`);
        solGlow.addColorStop(0.68, `rgba(232, 116, 44, ${(0.22 * depthAlpha).toFixed(3)})`);
        solGlow.addColorStop(1, 'rgba(232, 116, 44, 0)');
        ctx.fillStyle = solGlow;
        ctx.beginPath();
        ctx.arc(it.p.x, it.p.y, rad, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.translate(it.p.x, it.p.y);
        ctx.rotate(reducedMotion ? 0 : t * 0.48);
        for (let r = 0; r < 8; r++) {
          const ra = (r * Math.PI) / 4;
          const major = r % 2 === 0;
          const len = (major ? 12 : 7.5) * it.p.scale;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ra) * 4, Math.sin(ra) * 4);
          ctx.lineTo(Math.cos(ra) * len, Math.sin(ra) * len);
          ctx.strokeStyle = major
            ? `rgba(255, 234, 188, ${(0.88 * depthAlpha).toFixed(3)})`
            : `rgba(255, 198, 134, ${(0.56 * depthAlpha).toFixed(3)})`;
          ctx.lineWidth = major ? 1.15 : 0.85;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(0, 0, 4.4 * it.p.scale, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 245, 217, ${depthAlpha.toFixed(3)})`;
        ctx.fill();
        ctx.restore();
      } else if (it.type === 'luna') {
        const depthAlpha = frontPass ? 1 : 0.45;
        const rad = 17 * it.p.scale;
        const moonGlow = ctx.createRadialGradient(it.p.x, it.p.y, 1, it.p.x, it.p.y, rad);
        moonGlow.addColorStop(0, `rgba(234, 243, 255, ${(0.82 * depthAlpha).toFixed(3)})`);
        moonGlow.addColorStop(0.42, `rgba(168, 196, 236, ${(0.28 * depthAlpha).toFixed(3)})`);
        moonGlow.addColorStop(1, 'rgba(168, 196, 236, 0)');
        ctx.fillStyle = moonGlow;
        ctx.beginPath();
        ctx.arc(it.p.x, it.p.y, rad, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.translate(it.p.x, it.p.y);
        ctx.rotate(it.angle + 0.8);
        ctx.beginPath();
        ctx.arc(0, 0, 5.2 * it.p.scale, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(235, 242, 255, ${depthAlpha.toFixed(3)})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(2.3 * it.p.scale, -1.1 * it.p.scale, 4.3 * it.p.scale, 0, Math.PI * 2);
        ctx.fillStyle = '#140f0c';
        ctx.fill();
        ctx.restore();
      }
    }
  }

  function syncCanvasSize(canvas, w, h, dpr) {
    const targetW = Math.floor(w * dpr);
    const targetH = Math.floor(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
  }

  function drawDisc(canvas, geom, phi, accentColor, fx = {}) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    syncCanvasSize(canvas, geom.w, geom.h, dpr);

    const frontCanvas = fx.frontCanvas || null;
    if (frontCanvas) {
      syncCanvasSize(frontCanvas, geom.w, geom.h, dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, geom.w, geom.h);

    const { cx, cy, rIn, rOut, cardH, w, h } = geom;
    const accentRgb = parseHexRgb(accentColor);
    const t = typeof fx.time === 'number' ? fx.time : 0;
    const velocity = typeof fx.velocity === 'number' ? fx.velocity : 0;
    const pointerX = typeof fx.pointerX === 'number' ? fx.pointerX : 0;
    const pointerY = typeof fx.pointerY === 'number' ? fx.pointerY : 0;
    const pulse = typeof fx.pulse === 'number' ? fx.pulse : 0;
    const reducedMotion = Boolean(fx.reducedMotion);

    // Living optical caustic pools behind the right-hand Maglev Frosted Thick-Slab Panel
    const rightGlowX = geom.projLeft + geom.projW * 0.48;
    const rightGlowY = h * 0.46 + (reducedMotion ? 0 : Math.sin(t * 0.45) * 26);
    const rightGlowR = Math.max(360, geom.projW * 0.72);
    const rightAura = ctx.createRadialGradient(rightGlowX, rightGlowY, 18, rightGlowX, rightGlowY, rightGlowR);
    rightAura.addColorStop(0, rgba(accentRgb, 0.22));
    rightAura.addColorStop(0.42, 'rgba(255, 198, 138, 0.085)');
    rightAura.addColorStop(0.72, 'rgba(176, 200, 238, 0.045)');
    rightAura.addColorStop(1, 'rgba(15, 11, 9, 0)');
    ctx.fillStyle = rightAura;
    ctx.beginPath();
    ctx.arc(rightGlowX, rightGlowY, rightGlowR, 0, Math.PI * 2);
    ctx.fill();

    const rightLowX = geom.projLeft + geom.projW * 0.76;
    const rightLowY = h * 0.72 + (reducedMotion ? 0 : Math.cos(t * 0.38) * 18);
    const lowAura = ctx.createRadialGradient(rightLowX, rightLowY, 10, rightLowX, rightLowY, 240);
    lowAura.addColorStop(0, 'rgba(255, 210, 162, 0.15)');
    lowAura.addColorStop(0.55, rgba(accentRgb, 0.07));
    lowAura.addColorStop(1, 'rgba(15, 11, 9, 0)');
    ctx.fillStyle = lowAura;
    ctx.beginPath();
    ctx.arc(rightLowX, rightLowY, 240, 0, Math.PI * 2);
    ctx.fill();

    // Wide-field observatory hairlines, outer orbital arcs, and optical projection bridge
    drawObservatoryFieldAndBridge(ctx, geom, t, phi, accentRgb, pulse, reducedMotion);

    ctx.translate(cx, cy);

    // Deep obsidian astrolabe cavity
    const grad = ctx.createRadialGradient(0, 0, rIn * 0.1, 0, 0, rOut + 46);
    grad.addColorStop(0, rgba(accentRgb, 0.1));
    grad.addColorStop(0.36, 'rgba(26, 18, 13, 0.62)');
    grad.addColorStop(0.75, 'rgba(18, 13, 10, 0.34)');
    grad.addColorStop(1, 'rgba(15, 11, 9, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, rOut + 46, 0, Math.PI * 2);
    ctx.fill();

    // 1. Engraved Roman dial base & twinkling celestial stardust
    drawStarfieldAndDialBase(ctx, rIn, t, phi, accentRgb, reducedMotion);

    // 2. Build true hierarchical 3-Axis Interlocking Gimbal Armillary Sphere
    const focal = rIn * 3.1;
    const baseTime = reducedMotion ? 0.85 : t;
    const velBoost = Math.max(-0.4, Math.min(0.4, velocity * 1.4));

    // Base view frame responds smoothly to cursor parallax
    const viewMat = matMul(rotX(0.32 + pointerY * 0.28 + velBoost * 0.3), rotY(-0.22 + pointerX * 0.32));

    // Ring 1 (Outer Antique Copper Gimbal): rolls smoothly along X + slow Z precession
    const mRing1 = matMul(
      viewMat,
      matMul(rotZ(baseTime * 0.16 - phi * 0.5), rotX(0.72 + baseTime * 0.42))
    );

    // Ring 2 (Middle Champagne-Gold Ecliptic Gimbal): mounted INSIDE Ring 1 via orthogonal Y-axis pivots!
    const mRing2 = matMul(
      mRing1,
      matMul(rotY(1.08 + baseTime * 0.58 - phi * 0.65), rotZ(0.24))
    );

    // Ring 3 (Inner Lunar Pearl-Silver Gimbal): mounted INSIDE Ring 2 via orthogonal X-axis pivots!
    const mRing3 = matMul(
      mRing2,
      matMul(rotX(1.22 - baseTime * 0.74 + phi * 0.8), rotZ(baseTime * 0.22))
    );

    const R1 = rIn * 0.765;
    const R2 = rIn * 0.645;
    const R3 = rIn * 0.525;

    const copperFace = [212, 148, 94];
    const copperEdge = [255, 214, 166];
    const copperRear = [126, 80, 50];

    const goldFace = mixRgb([242, 198, 138], accentRgb, 0.26);
    const goldEdge = mixRgb([255, 232, 192], accentRgb, 0.22);
    const goldRear = [142, 98, 62];

    const silverFace = [204, 218, 240];
    const silverEdge = [242, 248, 255];
    const silverRear = [106, 118, 142];

    const sceneItems = [];

    pushGimbalRing(sceneItems, mRing1, {
      R: R1,
      halfW: rIn * 0.044,
      segCount: 96,
      faceRgb: copperFace,
      edgeRgb: copperEdge,
      rearRgb: copperRear,
      tickStep: 6,
      kind: 'outer'
    }, focal);

    pushGimbalRing(sceneItems, mRing2, {
      R: R2,
      halfW: rIn * 0.036,
      segCount: 84,
      faceRgb: goldFace,
      edgeRgb: goldEdge,
      rearRgb: goldRear,
      tickStep: 7,
      kind: 'mid'
    }, focal);

    pushGimbalRing(sceneItems, mRing3, {
      R: R3,
      halfW: rIn * 0.028,
      segCount: 72,
      faceRgb: silverFace,
      edgeRgb: silverEdge,
      rearRgb: silverRear,
      tickStep: 6,
      kind: 'inner'
    }, focal);

    // Physical gimbal hinge pins welding Ring 1 <-> Ring 2 (along Ring 1's local Y axis: ±π/2)
    pushPivotPins(sceneItems, mRing1, R1, R2, [Math.PI * 0.5, Math.PI * 1.5], copperEdge, focal);
    // Physical gimbal hinge pins welding Ring 2 <-> Ring 3 (along Ring 2's local X axis: 0 & π)
    pushPivotPins(sceneItems, mRing2, R2, R3, [0, Math.PI], goldEdge, focal);

    // Sol (Golden Sun) riding the tumbling Middle Ecliptic Ring (Ring 2)
    const solAngle = baseTime * 0.52 + 0.4;
    const solWorld = applyMat(mRing2, Math.cos(solAngle) * R2, Math.sin(solAngle) * R2, 0);
    sceneItems.push({ type: 'sol', p: projectPoint(solWorld, focal), z: solWorld.z });

    // Luna (Silver Crescent Moon) riding the orthogonal Inner Lunar Ring (Ring 3)
    const moonAngle = -baseTime * 0.64 + 2.3;
    const moonWorld = applyMat(mRing3, Math.cos(moonAngle) * R3, Math.sin(moonAngle) * R3, 0);
    sceneItems.push({ type: 'luna', p: projectPoint(moonWorld, focal), z: moonWorld.z, angle: moonAngle });

    // 4 luminous perpetual stardust motes racing along the interlocking gimbal tracks
    const moteSpecs = [
      { mat: mRing1, R: R1, a: baseTime * 0.72, rgb: copperEdge },
      { mat: mRing1, R: R1, a: baseTime * 0.72 + Math.PI, rgb: accentRgb },
      { mat: mRing2, R: R2, a: -baseTime * 0.88 + 1.1, rgb: goldEdge },
      { mat: mRing3, R: R3, a: baseTime * 1.05 + 0.6, rgb: silverEdge }
    ];
    for (let m = 0; m < moteSpecs.length; m++) {
      const ms = moteSpecs[m];
      const mw = applyMat(ms.mat, Math.cos(ms.a) * ms.R, Math.sin(ms.a) * ms.R, 0);
      sceneItems.push({ type: 'mote', p: projectPoint(mw, focal), z: mw.z, rgb: ms.rgb });
    }

    // 3. Unified Z-Sorted Back Pass (all ring segments, pins, sun/moon BEHIND #wheelHub)
    renderSortedScenePass(ctx, sceneItems, false, rIn, t, reducedMotion);

    // 4. Recessed Obsidian Sphere Core behind ROSETTA (soft halo grounding the core inside the cage)
    const coreR = rIn * 0.42;
    const coreGrad = ctx.createRadialGradient(0, 0, coreR * 0.12, 0, 0, coreR);
    coreGrad.addColorStop(0, 'rgba(20, 14, 11, 0.86)');
    coreGrad.addColorStop(0.68, 'rgba(15, 11, 9, 0.56)');
    coreGrad.addColorStop(1, 'rgba(15, 11, 9, 0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.fill();

    // 5. Outer fixed concentric astrolabe rings & ticks on Back Canvas (framing the card slots)
    const rings = [
      { r: rIn - 18, stroke: rgba(accentRgb, 0.28), width: 1.2 },
      { r: rIn, stroke: 'rgba(84, 63, 48, 0.9)', width: 1.5 },
      { r: rOut, stroke: 'rgba(72, 54, 42, 0.7)', width: 1.2 },
      { r: rOut + 14, stroke: rgba(accentRgb, 0.18), width: 1 }
    ];
    for (const ring of rings) {
      ctx.beginPath();
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = ring.stroke;
      ctx.lineWidth = ring.width;
      ctx.stroke();
    }

    // 6. Mechanically coupled rotating outer degree ticks & cardinal diamond jewels
    ctx.save();
    ctx.rotate(-phi);
    const tickCount = 72;
    for (let i = 0; i < tickCount; i++) {
      const a = (i / tickCount) * Math.PI * 2;
      const major = i % 6 === 0;
      const r1 = rIn - (major ? 16 : 10);
      const r2 = rIn - 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.strokeStyle = major ? 'rgba(255, 196, 142, 0.46)' : 'rgba(145, 122, 106, 0.22)';
      ctx.lineWidth = major ? 1.45 : 0.95;
      ctx.stroke();

      if (major) {
        const dx = Math.cos(a) * (rIn - 23);
        const dy = Math.sin(a) * (rIn - 23);
        ctx.save();
        ctx.translate(dx, dy);
        ctx.rotate(a + Math.PI / 4);
        ctx.fillStyle = i % 18 === 0 ? 'rgba(255, 214, 168, 0.65)' : rgba(accentRgb, 0.4);
        const s = i % 18 === 0 ? 2.6 : 1.7;
        if (typeof ctx.fillRect === 'function') ctx.fillRect(-s, -s, s * 2, s * 2);
        ctx.restore();
      }
    }
    ctx.restore();

    // 7. Harmonic pulse ripple on sector/card transition
    if (pulse > 0.01) {
      const pr = rIn * (0.3 + (1 - pulse) * 0.75);
      ctx.beginPath();
      ctx.arc(0, 0, pr, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(accentRgb, pulse * 0.44);
      ctx.lineWidth = 1.6 * pulse;
      ctx.stroke();
    }

    // 8. Active 3 o'clock pointer reticle & reading gate brackets
    ctx.beginPath();
    ctx.moveTo(rIn - 20, 0);
    ctx.lineTo(rIn - 6, -4.5);
    ctx.lineTo(rIn - 6, 4.5);
    safeClose(ctx);
    ctx.fillStyle = rgba(accentRgb, 0.8);
    ctx.fill();

    ctx.strokeStyle = accentColor || 'rgba(255, 178, 122, 0.88)';
    ctx.lineWidth = 1.6;
    const halfGate = cardH / 2 + 9;
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(rIn - 6, sign * (halfGate - 8));
      ctx.lineTo(rIn - 6, sign * halfGate);
      ctx.lineTo(rOut + 4, sign * halfGate);
      ctx.lineTo(rOut + 4, sign * (halfGate - 8));
      ctx.stroke();
    }

    // 9. Unified Z-Sorted Front Pass (rendered on #wheelCanvasFront PHYSICALLY OVER #wheelHub!)
    if (frontCanvas) {
      const fctx = frontCanvas.getContext('2d');
      fctx.save();
      fctx.scale(dpr, dpr);
      fctx.clearRect(0, 0, geom.w, geom.h);
      fctx.translate(cx, cy);
      renderSortedScenePass(fctx, sceneItems, true, rIn, t, reducedMotion);
      fctx.restore();
    } else {
      renderSortedScenePass(ctx, sceneItems, true, rIn, t, reducedMotion);
    }

    ctx.restore();
  }

  // Interactive Maglev Thick-Slab Glass pointer tracking (specular edge + gentle 3D tilt)
  function bindMaglevPanel(dockEl) {
    if (!dockEl || typeof dockEl.addEventListener !== 'function') return;
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };

    dockEl.addEventListener('pointermove', (e) => {
      const rect = dockEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      dockEl.style.setProperty('--mx', `${(nx * 100).toFixed(1)}%`);
      dockEl.style.setProperty('--my', `${(ny * 100).toFixed(1)}%`);
      if (!mq.matches) {
        const tiltY = ((nx - 0.5) * 2.4).toFixed(2);
        const tiltX = ((0.5 - ny) * 2.2).toFixed(2);
        dockEl.style.setProperty('--tilt-x', `${tiltX}deg`);
        dockEl.style.setProperty('--tilt-y', `${tiltY}deg`);
      }
      dockEl.classList.add('is-hovering');
    });

    dockEl.addEventListener('pointerleave', () => {
      dockEl.classList.remove('is-hovering');
      dockEl.style.setProperty('--tilt-x', '0deg');
      dockEl.style.setProperty('--tilt-y', '0deg');
      dockEl.style.setProperty('--mx', '50%');
      dockEl.style.setProperty('--my', '18%');
    });
  }

  return { computeGeometry, drawDisc, bindMaglevPanel };
})();
