// Procedural "Tree of Souls" (Avatar): arching branches, thousands of hanging
// luminous strands, glowing roots crawling over the ground.
// Every particle has three "homes": tree / expanded galaxy / hidden scatter.
// Death is a shader-side "wither" transform, so no ash positions needed.

import * as THREE from 'three';

const rand = (() => {
  let s = 1337;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
})();

const randRange = (a, b) => a + (b - a) * rand();

function randDirCone(dir, spread) {
  const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
  return dir.clone().addScaledVector(v, Math.tan(spread) * rand()).normalize();
}

export function buildTree() {
  const trunkPts = [];   // {p, r}  bark + roots
  const leafPts = [];    // {p}     small cyan tufts at tips
  const strandPts = [];  // {p, frac}
  const tipEnds = [];
  const skelA = [], skelB = [], skelMeta = [];

  const pushSkel = (a, b, rA, rB) => { skelA.push(a.clone()); skelB.push(b.clone()); skelMeta.push({ rA, rB }); };

  const sampleAlong = (a, b, r) => {
    const density = Math.max(3, Math.round(r * 800));
    for (let k = 0; k < density; k++) {
      const q = a.clone().lerp(b, rand());
      q.x += randRange(-r, r);
      q.y += randRange(-r, r) * 0.4;
      q.z += randRange(-r, r);
      trunkPts.push({ p: q, r });
    }
  };

  // --- arching branches ------------------------------------------------------
  function branch(start, dir, len, radius, depth) {
    const segs = Math.max(4, Math.round(len * 26));
    // arch: rise through the middle, droop toward the end (weeping silhouette)
    const arch = new THREE.Vector3(0, len * (depth === 0 ? 0.05 : 0.3), 0);
    const droop = new THREE.Vector3(0, -len * (depth === 0 ? 0 : 0.12 + depth * 0.1), 0);
    const side = new THREE.Vector3(randRange(-1, 1), 0, randRange(-1, 1)).multiplyScalar(0.18 * len);
    let prev = start.clone(), prevR = radius;
    const end = start.clone().addScaledVector(dir, len).add(droop);

    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      // trunk snakes in a full S-curve like the reference sculptures
      const sideWave = depth === 0 ? Math.sin(t * Math.PI * 2) : Math.sin(t * Math.PI);
      const p = start.clone().lerp(end, t)
        .addScaledVector(arch, Math.sin(t * Math.PI))
        .addScaledVector(side, sideWave * (depth === 0 ? 1.8 : 1));
      const r = radius * (1 - 0.5 * t);
      pushSkel(prev, p, prevR, r);
      sampleAlong(prev, p, r);
      prev = p; prevR = r;
    }

    const tipPos = prev;
    if (depth >= 4 || len < 0.14) {
      tipEnds.push(tipPos.clone());
      return;
    }

    const nChildren = depth === 0 ? 5 : (rand() < 0.7 ? 2 : 3);
    for (let c = 0; c < nChildren; c++) {
      let cdir = randDirCone(dir, 0.4 + depth * 0.13);
      // umbrella: first splits keep climbing, deeper branches level off
      const upness = depth === 0 ? randRange(0.75, 1.1) : randRange(0.15, 0.45) - depth * 0.06;
      cdir.y = 0;
      cdir.normalize().multiplyScalar(1);
      cdir.y = upness;
      cdir.normalize();
      const cstart = tipPos.clone().lerp(start, rand() * 0.2 * (depth > 0 ? 1 : 0.25));
      branch(cstart, cdir, len * randRange(0.66, 0.84), radius * randRange(0.5, 0.66), depth + 1);
    }
    if (depth >= 1 && rand() < 0.75) {
      const mid = start.clone().lerp(tipPos, randRange(0.45, 0.85));
      tipEnds.push(mid.clone()); // strands also hang from mid-branch
    }
  }

  branch(new THREE.Vector3(0, -1.02, 0), new THREE.Vector3(0, 1, 0), 1.15, 0.078, 0);

  // --- glowing roots crawling over the ground --------------------------------
  const nRoots = 9;
  for (let rt = 0; rt < nRoots; rt++) {
    const a = (rt / nRoots) * Math.PI * 2 + randRange(-0.2, 0.2);
    let pos = new THREE.Vector3(Math.cos(a) * 0.06, -1.0, Math.sin(a) * 0.06);
    let ang = a;
    let r = 0.045;
    const steps = Math.round(randRange(26, 44));
    for (let i = 0; i < steps; i++) {
      ang += randRange(-0.35, 0.35);
      const step = 0.028;
      const next = new THREE.Vector3(
        pos.x + Math.cos(ang) * step,
        Math.max(-1.06, pos.y - 0.004),
        pos.z + Math.sin(ang) * step
      );
      pushSkel(pos, next, r, r * 0.96);
      sampleAlong(pos, next, r);
      pos = next;
      r *= 0.965;
    }
  }

  // --- hanging tassels: dense BUNDLES of strands, like wisteria racemes -------
  // (the reference look: thick luminous curtains, not single threads)
  for (const tip of tipEnds) {
    const nStrands = 8 + ((rand() * 6) | 0); // 8–13 strands per bundle — dense, film-like
    let Lbase = randRange(0.5, 1.0);
    Lbase = Math.min(Lbase, tip.y + 0.98); // don't pierce the ground
    if (Lbase < 0.18) continue;
    const bundleFamily = rand(); // color family, picked per bundle below

    for (let s = 0; s < nStrands; s++) {
      const L = Lbase * randRange(0.72, 1.05);
      const n = Math.round(L * 130);
      // strand origin scattered inside the bundle head
      const oa = rand() * Math.PI * 2;
      const or_ = Math.sqrt(rand()) * 0.055;
      const ox = tip.x + Math.cos(oa) * or_;
      const oz = tip.z + Math.sin(oa) * or_;
      // curtains billow slightly outward from the trunk axis as they fall
      const outX = tip.x * 0.1 + Math.cos(oa) * 0.04;
      const outZ = tip.z * 0.1 + Math.sin(oa) * 0.04;
      const curl = randRange(1.5, 4);
      const phase = rand() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const f = k / n;
        strandPts.push({
          p: new THREE.Vector3(
            ox + outX * Math.sin(f * Math.PI * 0.5) + Math.sin(f * curl + phase) * 0.011,
            tip.y - L * f,
            oz + outZ * Math.sin(f * Math.PI * 0.5) + Math.cos(f * curl + phase) * 0.011
          ),
          frac: f,
          fam: bundleFamily
        });
      }
    }
    // small tuft of light where the bundle attaches
    const R = randRange(0.05, 0.09);
    const n = Math.round(R * 900);
    for (let i = 0; i < n; i++) {
      const th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1), rr = R * Math.cbrt(rand());
      leafPts.push({ p: new THREE.Vector3(
        tip.x + rr * Math.sin(ph) * Math.cos(th),
        tip.y + rr * Math.cos(ph) * 0.7,
        tip.z + rr * Math.sin(ph) * Math.sin(th)
      ) });
    }
  }

  const total = trunkPts.length + leafPts.length + strandPts.length;

  const treePos = new Float32Array(total * 3);
  const expandPos = new Float32Array(total * 3);
  const scatterPos = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const attrs = new Float32Array(total * 4); // seed, size, heightNorm, type(+strandFrac)

  let minY = Infinity, maxY = -Infinity;
  const allP = [...trunkPts, ...leafPts, ...strandPts];
  for (const it of allP) { minY = Math.min(minY, it.p.y); maxY = Math.max(maxY, it.p.y); }
  const hNormOf = y => (y - minY) / (maxY - minY);

  // recenter the crown over the trunk base
  let mx = 0, mz = 0;
  for (const l of leafPts) { mx += l.p.x; mz += l.p.z; }
  mx /= (leafPts.length || 1); mz /= (leafPts.length || 1);
  const recenter = p => {
    const f = 0.7 * hNormOf(p.y);
    p.x -= mx * f; p.z -= mz * f;
  };
  for (const it of allP) recenter(it.p);
  for (const p of skelA) recenter(p);
  for (const p of skelB) recenter(p);

  // compress horizontally so the whole tree stays inside the cube
  let maxR = 0;
  for (const it of allP) maxR = Math.max(maxR, Math.hypot(it.p.x, it.p.z));
  if (maxR > 1.02) {
    const s = 1.02 / maxR;
    for (const it of allP) { it.p.x *= s; it.p.z *= s; }
    for (const p of skelA) { p.x *= s; p.z *= s; }
    for (const p of skelB) { p.x *= s; p.z *= s; }
  }

  // --- palette from the reference: teal-emerald trunk, lilac curtains ---------
  const cBarkLow = new THREE.Color(0x0d5a48);   // deep emerald base
  const cBarkHigh = new THREE.Color(0x25a37e);  // teal upper bark
  const cBarkSpark = new THREE.Color(0xa8ffe0); // mint glints
  const cStrandA = new THREE.Color(0xc9a8ff);   // lilac
  const cStrandB = new THREE.Color(0x9f86ff);   // deeper violet
  const cPink = new THREE.Color(0xffb0e8);      // pink accents
  const cLeafA = new THREE.Color(0xd8c2ff);     // pale lavender tufts
  const cWhite = new THREE.Color(0xffffff);

  const tmp = new THREE.Color();
  let i = 0;

  const writeParticle = (p, color, size, type) => {
    treePos.set([p.x, p.y, p.z], i * 3);

    if (type >= 1) {
      const ang = Math.atan2(p.z, p.x) + randRange(-0.6, 0.6);
      const rad = Math.hypot(p.x, p.z) * randRange(1.7, 2.6) + 0.3;
      expandPos.set([
        Math.cos(ang) * rad,
        p.y * 1.15 + randRange(-0.12, 0.3),
        Math.sin(ang) * rad
      ], i * 3);
    } else {
      expandPos.set([p.x * 1.6, p.y * 1.04, p.z * 1.6], i * 3);
    }

    const sv = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1)
      .normalize().multiplyScalar(randRange(2.5, 5));
    sv.y = Math.abs(sv.y) * -0.6 - 1.2;
    scatterPos.set([p.x + sv.x, p.y + sv.y, p.z + sv.z], i * 3);

    colors.set([color.r, color.g, color.b], i * 3);
    attrs.set([rand(), size, hNormOf(p.y), type], i * 4);
    i++;
  };

  for (const t of trunkPts) {
    tmp.copy(cBarkLow).lerp(cBarkHigh, hNormOf(t.p.y)).lerp(cBarkSpark, rand() * 0.2);
    if (rand() < 0.09) tmp.copy(cBarkSpark);
    writeParticle(t.p, tmp, randRange(1.2, 2.6) * (0.7 + t.r * 8), 0);
  }
  for (const l of leafPts) {
    tmp.copy(cLeafA).lerp(cPink, rand() * 0.5);
    if (rand() < 0.04) tmp.copy(cWhite);
    writeParticle(l.p, tmp, randRange(0.7, 1.5), 1);
  }
  for (const s of strandPts) {
    // bundle color families like the references: lilac / pink / white-violet
    if (s.fam < 0.45) tmp.copy(cStrandA).lerp(cStrandB, rand());
    else if (s.fam < 0.75) tmp.copy(cPink).lerp(cStrandA, rand() * 0.6);
    else tmp.set(0xe8ddff).lerp(cStrandB, rand() * 0.45);
    // luminous attachment: the top of every curtain glows brighter (but stays colored)
    tmp.lerp(cWhite, (1 - THREE.MathUtils.smoothstep(s.frac, 0, 0.25)) * 0.45);
    if (s.frac > 0.92) tmp.lerp(cWhite, (s.frac - 0.92) / 0.08 * 0.9); // droplet tips
    writeParticle(s.p, tmp, randRange(0.9, 1.7) * (1 + s.frac * 0.4), 2 + Math.min(s.frac, 0.999));
  }

  // --- skeleton line geometry --------------------------------------------------
  const nSeg = skelA.length;
  const linePos = new Float32Array(nSeg * 2 * 3);
  const lineCol = new Float32Array(nSeg * 2 * 3);
  const lineAttr = new Float32Array(nSeg * 2 * 2);
  for (let s = 0; s < nSeg; s++) {
    const { rA, rB } = skelMeta[s];
    for (const [j, pt, r] of [[0, skelA[s], rA], [1, skelB[s], rB]]) {
      const o = (s * 2 + j);
      linePos.set([pt.x, pt.y, pt.z], o * 3);
      const h = hNormOf(pt.y);
      tmp.copy(cBarkLow).lerp(cBarkHigh, h).lerp(cWhite, Math.min(1, r * 7) * 0.45);
      lineCol.set([tmp.r, tmp.g, tmp.b], o * 3);
      lineAttr.set([h, (s * 7919 % 1000) / 1000], o * 2);
    }
  }

  return {
    treePos, expandPos, scatterPos, colors, attrs, count: total,
    linePos, lineCol, lineAttr, lineCount: nSeg * 2
  };
}
