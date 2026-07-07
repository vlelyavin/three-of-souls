// Post-processing (bloom + vignette) and the "heart" effect kit:
// pulsing orb, elastic light tendrils, shockwave ring.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ---------------------------------------------------------------------------
export function createComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // half-resolution bloom: big perf win, and softer glow that doesn't drown
  // individual particles
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
    0.65,  // strength — glow accents the particles instead of swallowing them
    0.45,  // radius
    0.62   // threshold — only genuinely hot pixels bloom
  );
  composer.addPass(bloom);

  // final pass: ACES tone mapping (the composer runs in HDR half-float —
  // additive particles stack way past 1.0, without this everything clips
  // to flat white) + vignette + full-screen supernova flash
  const grade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uStrength: { value: 0.55 },
      uFlash: { value: 0 },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      uWarpProg: { value: 1 },                     // 0→1 ripple; ≥1 = off
      uWarpCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uAspect: { value: window.innerWidth / window.innerHeight }
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse;
      uniform float uStrength;
      uniform float uFlash;
      uniform vec3 uFlashColor;
      uniform float uWarpProg;
      uniform vec2 uWarpCenter;
      uniform float uAspect;
      varying vec2 vUv;
      vec3 aces(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      void main() {
        // space itself ripples outward from the blast — refraction ring
        vec2 uv = vUv;
        if (uWarpProg < 1.0) {
          vec2 dv = uv - uWarpCenter;
          dv.x *= uAspect;
          float wd = length(dv);
          float frontR = uWarpProg * 1.1;
          float band = exp(-pow((wd - frontR) * 7.0, 2.0));
          float ripple = sin((wd - frontR) * 42.0) * band * (1.0 - uWarpProg);
          uv += normalize(dv + 1e-5) * ripple * 0.028 * vec2(1.0 / uAspect, 1.0);
        }
        vec4 c = texture2D(tDiffuse, uv);
        float d = distance(vUv, vec2(0.5));
        c.rgb += uFlashColor * uFlash * (1.3 - smoothstep(0.0, 0.95, d));
        c.rgb = aces(c.rgb * 1.05);
        c.rgb *= 1.0 - uStrength * smoothstep(0.35, 0.85, d);
        gl_FragColor = c;
      }
    `
  });
  composer.addPass(grade);

  window.addEventListener('resize', () => {
    composer.setSize(window.innerWidth, window.innerHeight);
    // composer.setSize just resized every pass to FULL device resolution —
    // re-pin bloom to half CSS size or it silently becomes ~9× more expensive
    bloom.setSize(window.innerWidth / 2, window.innerHeight / 2);
    grade.uniforms.uAspect.value = window.innerWidth / window.innerHeight;
  });

  return { composer, bloom, grade };
}

// ---------------------------------------------------------------------------
// The Heart: a beating anatural-shaped cluster of red particles + an orbiting
// ember ring. `uBurst` (0→1) detonates it into a newborn galaxy on resurrect.
// ---------------------------------------------------------------------------
export function createHeartParticles() {
  // the Seed of Eywa (atokirina): glowing kernel, a feathery umbrella of
  // luminous cilia arching up and out, long drifting tendrils below
  const N_KERNEL = 320, N_STALKS = 38, PTS_STALK = 26, N_DROP = 16, PTS_DROP = 30;
  const N_BODY = N_KERNEL + N_STALKS * PTS_STALK + N_DROP * PTS_DROP;
  const N_RINGDUST = 480, N_SAT = 9;
  const total = N_BODY + N_RINGDUST + N_SAT;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const attr = new Float32Array(total * 4); // seed, size, type, stalkPhase
  // types: 0 = seed body, 1 = orbit dust, 2 = orbit satellites

  const cWhiteS = new THREE.Color(0xffffff);
  const cGoldS = new THREE.Color(0xffe9c0);
  const cCyanTip = new THREE.Color(0xd8f4ff);
  const cEmber = new THREE.Color(0xffe2b0);
  const cRed = new THREE.Color(0xffc98a); // warm gold for orbit dust blend
  const cSat = new THREE.Color(0xfff2d8);
  const tmp = new THREE.Color();

  let i = 0;
  // kernel: dense glowing grain
  for (let k = 0; k < N_KERNEL; k++, i++) {
    const th = Math.random() * Math.PI * 2, ph2 = Math.acos(2 * Math.random() - 1);
    const rr = Math.cbrt(Math.random()) * 0.28;
    pos.set([rr * Math.sin(ph2) * Math.cos(th), rr * Math.cos(ph2) * 0.85, rr * Math.sin(ph2) * Math.sin(th)], i * 3);
    tmp.copy(cWhiteS).lerp(cGoldS, Math.random() * 0.6);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 1.6 + Math.random() * 2.4, 0, Math.random()], i * 4);
  }
  // umbrella cilia: arcs of light fanning up and outward
  for (let st = 0; st < N_STALKS; st++) {
    const az = (st / N_STALKS) * Math.PI * 2 + Math.random() * 0.25;
    const elev = 0.15 + Math.random() * 0.95; // radians above horizontal
    const L = 0.9 + Math.random() * 0.45;
    const phase = Math.random();
    for (let k = 0; k < PTS_STALK; k++, i++) {
      const t = (k + Math.random() * 0.5) / PTS_STALK;
      const r = t * L * Math.cos(elev);
      const up = t * L * Math.sin(elev) + Math.sin(t * Math.PI) * 0.18; // gentle arc
      pos.set([
        Math.cos(az) * r + (Math.random() - 0.5) * 0.02,
        up + (Math.random() - 0.5) * 0.02,
        Math.sin(az) * r + (Math.random() - 0.5) * 0.02
      ], i * 3);
      tmp.copy(cGoldS).lerp(cWhiteS, t * 0.6);
      if (t > 0.85) tmp.lerp(cCyanTip, (t - 0.85) / 0.15); // cool sparkling tips
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
      attr.set([Math.random(), (0.8 + Math.random()) * (1 + t * 0.8), 0, phase], i * 4);
    }
  }
  // drifting tendrils below, like the woodsprite's dangling cilia
  for (let dr = 0; dr < N_DROP; dr++) {
    const az = (dr / N_DROP) * Math.PI * 2 + Math.random() * 0.4;
    const L = 1.2 + Math.random() * 0.55;
    const phase = Math.random();
    const swirl = 2 + Math.random() * 3;
    for (let k = 0; k < PTS_DROP; k++, i++) {
      const t = k / PTS_DROP;
      const r = 0.12 + t * 0.35 + Math.sin(t * swirl) * 0.05;
      pos.set([
        Math.cos(az + t * 1.2) * r,
        -0.1 - t * L,
        Math.sin(az + t * 1.2) * r
      ], i * 3);
      tmp.copy(cGoldS).lerp(cCyanTip, t * 0.7);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
      attr.set([Math.random(), (0.7 + Math.random() * 0.9) * (1 + t * 0.5), 0, phase], i * 4);
    }
  }
  // three electron rings, atom-style ⚛: same radius, one shared center,
  // planes tilted 60° apart so the orbits visibly intersect
  const RINGS = [2.0, 2.05, 2.1];
  for (let k = 0; k < N_RINGDUST; k++, i++) {
    const ringId = k % 3;
    pos.set([RINGS[ringId] + (Math.random() - 0.5) * 0.1, ringId, 0], i * 3);
    tmp.copy(cEmber).lerp(cRed, Math.random());
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 0.6 + Math.random() * 0.9, 1, Math.random() * Math.PI * 2], i * 4);
  }
  for (let k = 0; k < N_SAT; k++, i++) {
    const ringId = k % 3;
    pos.set([RINGS[ringId], ringId, 0], i * 3);
    col.set([cSat.r, cSat.g, cSat.b], i * 3);
    attr.set([Math.random(), 3.2 + Math.random() * 1.4, 2, (k / N_SAT) * Math.PI * 2], i * 4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAttr', new THREE.BufferAttribute(attr, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);

  const uniforms = {
    uTime: { value: 0 },
    uGlow: { value: 0 },
    uBurst: { value: 0 },   // 0 intact → 1 exploded into a galaxy
    uTension: { value: 0 }, // 0..1 while being pulled: racing pulse, brighter
    uPixelRatio: { value: 1 },
    uScale: { value: 1 }
  };

  const SCALE = 0.13;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aCol;
      attribute vec4 aAttr; // seed, size, type, phase
      uniform float uTime, uGlow, uBurst, uTension, uPixelRatio, uScale;
      varying vec3 vColor;
      varying float vAlpha;

      mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1., 0., 0., 0., c, -s, 0., s, c); }
      mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0., s, 0., 1., 0., -s, 0., c); }
      mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, -s, 0., s, c, 0., 0., 0., 1.); }

      void main() {
        float seed = aAttr.x, size = aAttr.y, type = aAttr.z, phase = aAttr.w;

        // slow luminous breathing; quickens and trembles when pulled
        float beat = 0.5 + 0.5 * sin(uTime * (2.1 + uTension * 4.5) + phase * 6.283);
        float pulse = 1.0 + (0.07 + 0.07 * uTension) * beat;

        vec3 p = position;
        if (type < 0.5) {
          p *= pulse;
          // cilia sway: outer parts of the seed drift like underwater plumes
          float reachL = length(position);
          p += vec3(
            sin(uTime * 1.3 + phase * 6.283 + reachL * 3.0),
            cos(uTime * 1.05 + phase * 7.1),
            sin(uTime * 1.6 + phase * 5.2)
          ) * 0.05 * reachL;
          p = rotY(uTime * 0.35) * p; // the seed slowly revolves
          // burst: fly outward with a spiral twist — a star going supernova
          float bAng = uBurst * (4.0 + seed * 6.0);
          float ca = cos(bAng), sa = sin(bAng);
          p.xz = mat2(ca, -sa, sa, ca) * p.xz;
          p += normalize(position + vec3(0.0001)) * uBurst * (5.0 + seed * 8.0);
        } else {
          // electron rings: three inclined orbits around the heart
          float ringId = position.y;
          float speed = (type > 1.5 ? 1.1 : 0.5) * (0.75 + seed * 0.5) * (1.0 + ringId * 0.25);
          float ang = phase + uTime * speed + uBurst * (4.0 + seed * 3.0);
          float rad = position.x * (1.0 + uBurst * (8.0 + seed * 6.0)) * (1.0 + beat * 0.04);
          vec3 rp = vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
          rp.y += sin(seed * 47.0 + uTime * 1.3) * 0.05; // dust shimmer off-plane
          // atom ⚛: all orbits share the heart's center, planes 60° apart
          rp = rotY(ringId * 2.094) * rotX(1.25) * rp;
          p = rotZ(sin(uTime * 0.21) * 0.25) * rp; // slow precession of the whole atom
        }
        // materialize: motes condense out of the root one by one — each has
        // its own moment on the uGlow ramp and swells outward from the core,
        // so the seed assembles instead of popping in at full shape
        float mtr = smoothstep(seed * 0.5, seed * 0.5 + 0.5, uGlow);
        p *= mix(0.06, 1.0, mtr);
        p *= ${SCALE};

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float twinkle = 0.8 + 0.2 * sin(uTime * (3.0 + seed * 8.0) + seed * 60.0);
        float birth = mtr * (1.0 - mtr) * 4.0; // shimmer at the moment of birth
        gl_PointSize = size * uPixelRatio * uScale * twinkle * (0.4 + 0.6 * mtr)
          * (1.0 + beat * 0.25) * (1.0 + uBurst * 1.5) * (13.0 / -mv.z);
        vColor = aCol * (1.0 + beat * 0.5 + uBurst * 2.2 + uTension * 0.8
          + birth * 1.4 + (type > 1.5 ? 0.7 : 0.0));
        vAlpha = mtr * twinkle * 0.85 * (1.0 - smoothstep(0.55, 1.0, uBurst));
        // the kernel stacks hundreds of additive points; cool the core hard so
        // the HDR sum stays out of the bloom's coarse mips (their bilinear
        // upsampling reads as a SQUARE halo). Filaments are spread out — keep.
        if (type < 0.5)
          vAlpha *= mix(0.18, 1.0, smoothstep(0.25, 0.6, length(position)));
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float g = exp(-d * d * 10.0);
        gl_FragColor = vec4(vColor, vAlpha * g);
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;

  // wide glow: an honest radial-gradient billboard behind the seed — perfectly
  // round at any brightness, unlike bloom-generated halos. The parent object
  // is camera-billboarded by main.js, so a +z plane child always faces us.
  const haloMat = new THREE.ShaderMaterial({
    uniforms, // shares uGlow / uBurst / uTension
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform float uGlow, uBurst, uTension, uTime;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float g = exp(-d * d * 4.5) * (1.0 - smoothstep(0.75, 1.0, d));
        float breathe = 1.0 + 0.08 * sin(uTime * (2.1 + uTension * 4.5));
        vec3 col = mix(vec3(1.0, 0.9, 0.68), vec3(1.0, 0.98, 0.92), g);
        gl_FragColor = vec4(col, g * breathe * uGlow * uGlow * 0.45 * (1.0 - uBurst));
      }
    `
  });
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
  halo.scale.setScalar(0.85);
  halo.renderOrder = 4; // behind the seed particles
  points.add(halo);

  return { object: points, uniforms };
}

// ---------------------------------------------------------------------------
// Tendrils: N elastic light threads from the orb to trunk anchors.
// CPU-updated bezier curves — trivially cheap (N × SEGS points).
// ---------------------------------------------------------------------------
const T_SEGS = 22;

export function createTendrils(anchors) {
  const group = new THREE.Group();
  const items = anchors.map((anchor, i) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(T_SEGS * 3), 3));
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color().lerpColors(
        new THREE.Color(0xffd9a0), new THREE.Color(0x5ee6c8), i / anchors.length
      ),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);
    return {
      line, anchor: anchor.clone(),
      snapDist: 0.5 + (i / anchors.length) * 0.45 + Math.random() * 0.08,
      alive: true, flick: Math.random() * 10
    };
  });

  const tmp = new THREE.Vector3();
  const mid = new THREE.Vector3();

  return {
    group,
    reset() { for (const t of items) { t.alive = true; t.line.material.opacity = 0; } },
    // returns number of tendrils still alive
    update(orbLocal, strength, time) {
      let alive = 0;
      for (const t of items) {
        const dist = orbLocal.distanceTo(t.anchor);
        if (t.alive && dist > t.snapDist) t.alive = false;
        const on = t.alive && strength > 0.01;
        t.line.material.opacity = on
          ? strength * (0.35 + 0.3 * Math.sin(time * 13.0 + t.flick)) * (1 - dist / (t.snapDist + 0.15)) * 2.0
          : Math.max(0, t.line.material.opacity - 0.12);
        if (!on && t.line.material.opacity <= 0) continue;
        alive += t.alive ? 1 : 0;

        const pos = t.line.geometry.attributes.position;
        const slack = Math.max(0, 1 - dist / 1.1);
        mid.lerpVectors(orbLocal, t.anchor, 0.5);
        mid.y -= slack * 0.22;
        for (let k = 0; k < T_SEGS; k++) {
          const u = k / (T_SEGS - 1);
          // quadratic bezier + noise wiggle
          tmp.set(
            (1-u)*(1-u)*orbLocal.x + 2*(1-u)*u*mid.x + u*u*t.anchor.x,
            (1-u)*(1-u)*orbLocal.y + 2*(1-u)*u*mid.y + u*u*t.anchor.y,
            (1-u)*(1-u)*orbLocal.z + 2*(1-u)*u*mid.z + u*u*t.anchor.z
          );
          const w = Math.sin(u * Math.PI) * 0.02;
          tmp.x += Math.sin(time * 9 + t.flick + u * 14) * w;
          tmp.y += Math.cos(time * 11 + t.flick * 2 + u * 10) * w;
          pos.setXYZ(k, tmp.x, tmp.y, tmp.z);
        }
        pos.needsUpdate = true;
      }
      return alive;
    }
  };
}

// ---------------------------------------------------------------------------
// Supernova: THE event for ripping out / implanting the heart.
// Staged like a real stellar explosion: a blinding core ignition, then the
// blast tears OUTWARD sideways in an equatorial sheet, then twin polar jets
// erupt straight up and down. World-oriented (not billboarded) so the stages
// read as "в стороны, потом вверх и вниз".
// ---------------------------------------------------------------------------
export function createQuasar() {
  const N_CORE = 320, N_EQ = 2600, N_SHELL = 1700, N_BEAM = 340;
  const total = N_CORE + N_EQ + N_SHELL + N_BEAM;
  const pos = new Float32Array(total * 3);   // packed per-type params
  const col = new Float32Array(total * 3);
  const attr = new Float32Array(total * 4);  // seed, size, type, aux

  const cWhite = new THREE.Color(0xfff6e4);
  const cGold = new THREE.Color(0xffd9a0);
  const cOrange = new THREE.Color(0xff9a55);
  const cJetTip = new THREE.Color(0xbfe8ff);
  const tmp = new THREE.Color();

  let i = 0;
  // core: a tight kernel that swells and goes blinding
  for (let k = 0; k < N_CORE; k++, i++) {
    const th = Math.random() * Math.PI * 2, ph2 = Math.acos(2 * Math.random() - 1);
    const rr = Math.cbrt(Math.random()) * 0.16;
    pos.set([rr * Math.sin(ph2) * Math.cos(th), rr * Math.cos(ph2), rr * Math.sin(ph2) * Math.sin(th)], i * 3);
    tmp.copy(cWhite).lerp(cGold, Math.random() * 0.4);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 2.5 + Math.random() * 5, 0, 0], i * 4);
  }
  // equatorial blast: packed as (angle, speed, zJitter)
  for (let k = 0; k < N_EQ; k++, i++) {
    const speed = 0.55 + Math.pow(Math.random(), 0.6) * 0.45; // front-heavy
    pos.set([Math.random() * Math.PI * 2, speed, (Math.random() - 0.5)], i * 3);
    tmp.copy(cWhite).lerp(cGold, THREE.MathUtils.smoothstep(speed, 0.55, 0.8))
       .lerp(cOrange, THREE.MathUtils.smoothstep(speed, 0.8, 1.0));
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 0.9 + Math.random() * 1.8, 1, (Math.random() - 0.5)], i * 4);
  }
  // filamentary nebula shell (the reference photo): clumpy expanding remnant
  const clumps = [];
  for (let c = 0; c < 46; c++) {
    const th = Math.random() * Math.PI * 2, ph2 = Math.acos(2 * Math.random() - 1);
    clumps.push([
      Math.sin(ph2) * Math.cos(th), Math.cos(ph2), Math.sin(ph2) * Math.sin(th),
      0.5 + Math.random() * 0.5 // clump brightness
    ]);
  }
  for (let k = 0; k < N_SHELL; k++, i++) {
    const cl = clumps[(Math.random() * clumps.length) | 0];
    // scatter around the clump centre → torn, filamentary look
    let dx = cl[0] + (Math.random() - 0.5) * 0.36;
    let dy = cl[1] + (Math.random() - 0.5) * 0.36;
    let dz = cl[2] + (Math.random() - 0.5) * 0.36;
    const dl = Math.hypot(dx, dy, dz) || 1;
    pos.set([dx / dl, dy / dl, dz / dl], i * 3);
    tmp.copy(cWhite).lerp(cGold, Math.random()).lerp(cOrange, Math.random() * 0.5);
    tmp.multiplyScalar(cl[3]);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 0.8 + Math.random() * 1.6, 2, 0.75 + Math.random() * 0.45], i * 4);
  }
  // light streak: a razor-thin beam piercing the core (the reference's flare)
  for (let k = 0; k < N_BEAM; k++, i++) {
    const sgn = Math.random() * 2 - 1;
    const along = Math.sign(sgn) * Math.pow(Math.abs(sgn), 1.6); // dense center
    pos.set([along, (Math.random() - 0.5), (Math.random() - 0.5)], i * 3);
    tmp.copy(cWhite).lerp(cGold, Math.random() * 0.3);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
    attr.set([Math.random(), 0.8 + Math.random() * 2.4 * (1 - Math.abs(along) * 0.7), 3, 0], i * 4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAttr', new THREE.BufferAttribute(attr, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);

  const uniforms = {
    uTime: { value: 0 },
    uProg: { value: 1 },   // 0→1 event timeline; ≥1 inactive
    uMode: { value: 0 },   // 0 = explosion (implant), 1 = IMPLOSION (rip)
    uSize: { value: 1 },
    uPixelRatio: { value: 1 },
    uScale: { value: 1 }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 aCol;
      attribute vec4 aAttr; // seed, size, type, aux
      uniform float uTime, uProg, uMode, uSize, uPixelRatio, uScale;
      varying vec3 vColor;
      varying float vAlpha;
      float easeOut(float x) { x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 3.0); }
      void main() {
        float seed = aAttr.x, size = aAttr.y, type = aAttr.z, aux = aAttr.w;
        float p = uProg;
        vec3 pp;
        float alpha = 0.0;
        float sizeMul = 1.0;

        if (type < 0.5) {
          float swell;
          if (uMode > 0.5) {
            // IMPLODE: the core charges up as light falls in, dark pop at 0.5
            swell = mix(0.3, 1.7, smoothstep(0.1, 0.48, p));
            pp = position * swell * uSize;
            pp += position * sin(uTime * 6.0 + seed * 40.0) * 0.15;
            alpha = smoothstep(0.08, 0.2, p) * (1.0 - smoothstep(0.52, 0.66, p));
            sizeMul = swell * (1.0 + 3.0 * exp(-pow((p - 0.5) * 14.0, 2.0)));
          } else {
          // CORE: swells 0→0.12, goes blinding, collapses by 0.35
          swell = mix(0.25, 2.2, smoothstep(0.0, 0.13, p));
          pp = position * swell * uSize;
          pp += position * sin(uTime * 6.0 + seed * 40.0) * 0.15;
          alpha = smoothstep(0.0, 0.06, p) * (1.0 - smoothstep(0.16, 0.38, p));
          sizeMul = swell * (1.0 + 2.5 * exp(-pow((p - 0.13) * 12.0, 2.0))); // the flash
          }
        } else if (type < 1.5) {
          float ang = position.x, speed = position.y;
          float t, rad, drift;
          if (uMode > 0.5) {
            // IMPLODE: light rushes INWARD from all sides, spiralling down the drain
            t = 1.0 - easeOut(p / 0.5);
            rad = t * 2.3 * uSize * speed + 0.04;
            drift = ang - (1.0 - t) * (seed + 0.6) * 2.6; // vortex swirl inward
            pp = vec3(cos(drift) * rad, position.z * 0.10 * uSize * t, sin(drift) * rad);
            alpha = smoothstep(0.02, 0.1, p) * (1.0 - smoothstep(0.42, 0.52, p));
            sizeMul = 1.0 + (1.0 - t) * 1.6; // accelerating, brightening as it falls
          } else {
          // EQUATORIAL blast: tears outward sideways, decelerating front
          t = easeOut((p - 0.10) / 0.62);
          rad = t * 2.3 * uSize * speed;
          rad *= 1.0 + 0.06 * sin(uTime * 4.0 + seed * 60.0);       // turbulence
          drift = ang + t * (seed - 0.5) * 1.2;               // shear swirl
          pp = vec3(cos(drift) * rad, position.z * 0.10 * uSize * (1.0 + t), sin(drift) * rad);
          alpha = smoothstep(0.10, 0.15, p) * (1.0 - smoothstep(0.6, 0.92, p));
          sizeMul = 1.0 + (1.0 - speed) * 0.8 + (1.0 - t) * 1.2;    // hot young front
          }
        } else if (type < 2.5) {
          float speed = aux;
          float t, rad;
          if (uMode > 0.5) {
            // IMPLODE: after the collapse — one short, tight copper pop
            t = easeOut((p - 0.52) / 0.45);
            rad = (0.12 + t * 0.85) * uSize * speed;
            pp = position * rad;
            alpha = smoothstep(0.52, 0.58, p) * (1.0 - smoothstep(0.78, 1.0, p)) * 0.8;
            sizeMul = 1.0 + t;
          } else {
          // NEBULA SHELL: torn filamentary remnant billowing outward,
          // smouldering as it expands (like the reference photo)
          t = easeOut((p - 0.24) / 0.72);
          rad = (0.25 + t * 1.75) * uSize * speed;
          pp = position * rad;
          pp += vec3(
            sin(uTime * 1.8 + seed * 51.0),
            sin(uTime * 1.5 + seed * 77.0),
            cos(uTime * 2.1 + seed * 33.0)
          ) * 0.05 * uSize * (0.3 + t); // slow billowing turbulence
          alpha = smoothstep(0.24, 0.34, p) * (1.0 - smoothstep(0.7, 1.0, p));
          alpha *= 0.85 - t * 0.35; // cools and dims as it expands
          sizeMul = 1.0 + t * 0.9;  // puffs up like smoke
          }
        } else {
          // LIGHT STREAK: razor beam piercing the core at detonation
          float along = position.x;
          vec3 dir3 = normalize(vec3(0.86, 0.48, 0.0)); // diagonal, like the photo
          float pk = uMode > 0.5 ? 0.5 : 0.12;          // implode flashes at collapse
          float reach = mix(0.4, uMode > 0.5 ? 1.4 : 2.1, smoothstep(pk - 0.04, pk + 0.08, p)) * uSize;
          pp = dir3 * along * reach
             + vec3(-dir3.y, dir3.x, 0.0) * position.y * 0.02 * uSize
             + vec3(0.0, 0.0, 1.0) * position.z * 0.02 * uSize;
          alpha = smoothstep(pk - 0.04, pk, p) * (1.0 - smoothstep(pk + 0.23, pk + 0.45, p));
          alpha *= 1.0 - abs(along) * 0.55; // brightest at the core
          sizeMul = 1.2 + exp(-pow((p - pk - 0.02) * 9.0, 2.0)) * 1.8;
        }

        vec4 mv = modelViewMatrix * vec4(pp, 1.0);
        gl_Position = projectionMatrix * mv;
        float twinkle = 0.85 + 0.15 * sin(uTime * (5.0 + seed * 9.0) + seed * 70.0);
        gl_PointSize = size * sizeMul * uPixelRatio * uScale * twinkle * (10.0 / -mv.z);
        vColor = aCol * (1.4 + (type < 0.5 ? 2.0 * exp(-pow((p - (uMode > 0.5 ? 0.5 : 0.13)) * 10.0, 2.0)) : 0.0));
        vColor *= mix(vec3(1.0), vec3(1.0, 0.62, 0.38), uMode * 0.8); // dark copper when ripping
        vAlpha = alpha * twinkle * 0.75;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, vAlpha * exp(-d * d * 10.0));
      }
    `
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 7;

  const group = new THREE.Group();
  group.add(points);
  group.visible = false;

  let t0 = -1;
  let dur = 2.6;
  return {
    object: group,
    uniforms,
    fire(worldPos, nowSec, size = 1, mode = 0) {
      group.position.copy(worldPos);
      uniforms.uSize.value = size;
      uniforms.uMode.value = mode;
      dur = mode ? 1.8 : 2.6; // implosion is snappier
      // slight random tilt so no two explosions are identical
      group.rotation.set((Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3);
      group.visible = true;
      t0 = nowSec;
    },
    update(nowSec, camera, simTime) {
      if (!group.visible) return;
      const p = (nowSec - t0) / dur;
      if (p >= 1) { group.visible = false; uniforms.uProg.value = 1; return; }
      uniforms.uProg.value = p;
      uniforms.uTime.value = simTime;
    }
  };
}

// ---------------------------------------------------------------------------
// Lightning: a pool of jagged additive bolts radiating from an impact point.
// strike() regenerates them; they flicker violently and die in ~0.3s.
// ---------------------------------------------------------------------------
const BOLT_SEGS = 14;

export function createLightning() {
  const group = new THREE.Group();
  const bolts = [];
  for (let i = 0; i < 12; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_SEGS * 3), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);
    bolts.push({ line, t0: -1, dur: 0.3 });
  }

  const dir = new THREE.Vector3(), perp1 = new THREE.Vector3(), perp2 = new THREE.Vector3();

  return {
    group,
    strike(origin, nowSec, color, count = 6, reach = 1.2) {
      let used = 0;
      for (const b of bolts) {
        if (used >= count) break;
        if (b.t0 >= 0 && nowSec - b.t0 < b.dur) continue; // busy bolt
        used++;
        b.t0 = nowSec;
        b.dur = 0.22 + Math.random() * 0.2;
        b.line.material.color.set(color);
        const ang = Math.random() * Math.PI * 2;
        dir.set(Math.cos(ang), (Math.random() - 0.5) * 1.6, Math.sin(ang)).normalize();
        perp1.set(-dir.y, dir.x, dir.z * 0.4).normalize();
        perp2.crossVectors(dir, perp1);
        const len = reach * (0.55 + Math.random() * 0.9);
        const pos = b.line.geometry.attributes.position;
        for (let k = 0; k < BOLT_SEGS; k++) {
          const f = k / (BOLT_SEGS - 1);
          // jitter is strongest mid-bolt, both ends stay anchored-ish
          const jag = Math.sin(f * Math.PI) * 0.14 * len;
          const o1 = (Math.random() - 0.5) * 2 * jag;
          const o2 = (Math.random() - 0.5) * 2 * jag;
          pos.setXYZ(k,
            origin.x + dir.x * len * f + perp1.x * o1 + perp2.x * o2,
            origin.y + dir.y * len * f + perp1.y * o1 + perp2.y * o2,
            origin.z + dir.z * len * f + perp1.z * o1 + perp2.z * o2);
        }
        pos.needsUpdate = true;
      }
    },
    update(nowSec) {
      for (const b of bolts) {
        if (b.t0 < 0) continue;
        const p = (nowSec - b.t0) / b.dur;
        if (p >= 1) { b.line.material.opacity = 0; b.t0 = -1; continue; }
        // violent flicker: bolts blink in and out as they die
        b.line.material.opacity = (Math.random() < 0.7 ? 1 : 0.15) * (1 - p);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Shockwave: expanding additive ring billboard
// ---------------------------------------------------------------------------
export function createShockwave() {
  const uniforms = {
    uProg: { value: 1 },  // 0 → 1, ≥1 = invisible
    uSeed: { value: 0 },  // per-blast randomness → asymmetric, organic ring
    uColor: { value: new THREE.Color(0xffb0c0) }
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uProg;
      uniform float uSeed;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        if (uProg >= 1.0) discard;
        vec2 dv = vUv - 0.5;
        float d = length(dv) * 2.0;                 // 0 center → 1 edge
        float a = atan(dv.y, dv.x);
        // jagged, uneven front — a real blast, not a compass circle
        float front = uProg * (1.0
          + 0.16 * sin(a * 3.0 + uSeed)
          + 0.11 * sin(a * 7.0 - uSeed * 1.7)
          + 0.07 * sin(a * 13.0 + uSeed * 3.1));
        float ring = exp(-pow((d - front) * 9.0, 2.0));
        // hot filaments streaking along the ring
        ring *= 0.75 + 0.45 * sin(a * 17.0 + uSeed * 5.0);
        float fade = pow(1.0 - uProg, 1.6);
        gl_FragColor = vec4(uColor, ring * fade * 1.7);
      }
    `
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), mat);
  mesh.visible = false;
  mesh.renderOrder = 6;

  let t0 = -1;
  const DUR = 0.75;
  return {
    object: mesh,
    fire(worldPos, nowSec, scale = 1) {
      mesh.position.copy(worldPos);
      mesh.scale.setScalar(scale);
      mesh.visible = true;
      uniforms.uSeed.value = Math.random() * 20;
      t0 = nowSec;
    },
    update(nowSec, camera) {
      if (!mesh.visible) return;
      const p = (nowSec - t0) / DUR;
      if (p >= 1) { mesh.visible = false; uniforms.uProg.value = 1; return; }
      uniforms.uProg.value = p;
      mesh.quaternion.copy(camera.quaternion); // billboard
    }
  };
}
