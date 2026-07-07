import * as THREE from 'three';
import { buildTree } from './tree.js';
import { GestureEngine } from './gestures.js';
import {
  createComposer, createHeartParticles, createTendrils, createShockwave,
  createLightning, createQuasar
} from './fx.js';

// ---------------------------------------------------------------------------
// DOM / params
// ---------------------------------------------------------------------------
const video = document.getElementById('webcam');
const canvas = document.getElementById('scene');
const hudState = document.getElementById('hud-state');
const hudHand = document.getElementById('hud-hand');
const hudGesture = document.getElementById('hud-gesture');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FORCE = {};
for (const k of ['r', 'm', 'death', 'nova', 'heart', 'orbx', 'orby']) {
  FORCE[k] = params.has(k) ? parseFloat(params.get(k)) : null;
}
const ANY_FORCE = Object.values(FORCE).some(v => v !== null);

// ---------------------------------------------------------------------------
// Renderer / composer / scene
// ---------------------------------------------------------------------------
// antialias off: everything renders through the EffectComposer's offscreen
// targets anyway, so MSAA on the canvas only costs performance
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: false, antialias: false, powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 50);
camera.position.set(0, 0.15, 6.4);

const { composer, bloom, grade } = createComposer(renderer, scene, camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- adaptive resolution: hold 60fps by shedding pixels, never particles ----
// additive HDR blending is fill-rate bound; dropping pixelRatio one step cuts
// fragment work quadratically and is barely visible under bloom
const QUALITY_STEPS = [1.5, 1.25, 1.0, 0.8];
let qualityIdx = 0;
let fpsAcc = 0, fpsN = 0, fpsCheckAt = 0, fpsGoodStreak = 0;

function applyQuality() {
  const pr = Math.min(window.devicePixelRatio, QUALITY_STEPS[qualityIdx]);
  renderer.setPixelRatio(pr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(pr);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth / 2, window.innerHeight / 2);
  uniforms.uPixelRatio.value = pr;
  heart.uniforms.uPixelRatio.value = pr;
}

function adaptQuality(now, dt) {
  if (document.hidden) { fpsAcc = 0; fpsN = 0; return; } // rAF is throttled, not our fault
  fpsAcc += dt; fpsN++;
  if (!fpsCheckAt) { fpsCheckAt = now + 3000; return; }  // let the app warm up first
  if (now < fpsCheckAt) return;
  const fps = fpsN / Math.max(fpsAcc, 1e-3);
  if (fps < 52 && qualityIdx < QUALITY_STEPS.length - 1) {
    qualityIdx++; applyQuality(); fpsGoodStreak = 0;
  } else if (fps > 58 && qualityIdx > 0 && ++fpsGoodStreak >= 4) {
    qualityIdx--; applyQuality(); fpsGoodStreak = 0; // recover when there's headroom
  } else if (fps <= 58) fpsGoodStreak = 0;
  fpsAcc = 0; fpsN = 0; fpsCheckAt = now + 1500;
}

// surface runtime errors in the HUD so failures are never silent
window.addEventListener('error', e => { hudGesture.textContent = 'ERR: ' + e.message; });
window.addEventListener('unhandledrejection', e => { hudGesture.textContent = 'ERR: ' + e.reason; });

// ---------------------------------------------------------------------------
// Webcam background quad (inside the scene → goes through bloom/vignette)
// ---------------------------------------------------------------------------
const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
const bgUniforms = {
  uTex: { value: videoTex },
  uUVScale: { value: new THREE.Vector2(1, 1) },
  uReady: { value: 0 },
  uShadowPos: { value: new THREE.Vector2(0.35, 0.5) }, // screen uv of the tree
  uShadowOn: { value: 0 },                             // follows reveal
  uDim: { value: 0.62 },  // room brightness, live-adjustable with [ and ]
  uAspectBG: { value: window.innerWidth / window.innerHeight }
};
const bgQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    uniforms: bgUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      uniform vec2 uUVScale;
      uniform float uReady;
      uniform vec2 uShadowPos;
      uniform float uShadowOn;
      uniform float uDim;
      uniform float uAspectBG;
      varying vec2 vUv;
      void main() {
        vec2 uv = (vUv - 0.5) * uUVScale + 0.5;
        uv.x = 1.0 - uv.x; // mirror
        vec3 c = texture2D(uTex, uv).rgb;
        // gently grade the room; uDim is live-adjustable ([ and ]) so the
        // room/hologram balance can be tuned right before recording
        c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.25) * uDim;
        c *= mix(vec3(1.0), vec3(0.85, 0.95, 1.1), 0.5); // mild cool tint
        // soft elliptical shadow behind the hologram — extra contrast
        vec2 sv = vUv - uShadowPos;
        sv.x *= uAspectBG;
        float sd = length(sv * vec2(1.0, 0.8));
        c *= 1.0 - uShadowOn * 0.22 * exp(-sd * sd * 5.5);
        gl_FragColor = vec4(c * uReady, 1.0);
      }
    `
  })
);
bgQuad.frustumCulled = false;
bgQuad.renderOrder = -10;
scene.add(bgQuad);

function updateBgCover() {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const va = vw / vh, sa = window.innerWidth / window.innerHeight;
  if (va > sa) bgUniforms.uUVScale.value.set(sa / va, 1);
  else bgUniforms.uUVScale.value.set(1, va / sa);
}
window.addEventListener('resize', updateBgCover);

// ---------------------------------------------------------------------------
// Holo group: cube + rotatable tree group
// ---------------------------------------------------------------------------
const holo = new THREE.Group();
holo.position.set(0, 0.1, 0); // x is set by fitCamera (parked left of center)
holo.scale.setScalar(1.18);
scene.add(holo);

// keep the whole tree in frame on any aspect (tall windows push the camera
// back); position + scale come from frameTree() below
let camZBase = 6.4;
function fitCamera() {
  const a = window.innerWidth / window.innerHeight;
  camZBase = a > 1.35 ? 6.4 : a > 0.9 ? 7.4 : 8.6;
  camZTarget = camZBase;
}
window.addEventListener('resize', fitCamera);

// --- drag the hologram with the mouse; position persists across reloads -----
{
  let dragging = false;
  canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    // pixels → world units on the hologram plane (z≈0)
    const wpp = (2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(22.5))) / window.innerHeight;
    holo.position.x += e.movementX * wpp;
    holo.position.y -= e.movementY * wpp;
  });
  canvas.addEventListener('pointerup', () => {
    dragging = false;
    localStorage.setItem('holoPos', JSON.stringify({ x: holo.position.x, y: holo.position.y }));
  });
}

// --- 'O' toggles all overlays (HUD, help, hand dot) for clean filming --------
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'o' || k === 'щ') {
    for (const id of ['hud', 'help', 'handdot']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('ui-hidden');
    }
  }
  // 'B' — blackout mode: hide the webcam feed, tree on pure black.
  // Record the screen in this mode and composite over any footage with a
  // Screen/Add blend — glow layers merge perfectly, no chroma keying needed.
  if (k === 'b' || k === 'и') bgQuad.visible = !bgQuad.visible;
  // [ / ] — room brightness down/up (persisted for the next session)
  if (e.key === '[' || e.key === ']') {
    const v = THREE.MathUtils.clamp(
      bgUniforms.uDim.value + (e.key === ']' ? 0.08 : -0.08), 0.15, 1.15);
    bgUniforms.uDim.value = v;
    localStorage.setItem('bgDim', v.toFixed(2));
    flash(`💡 яркость фона ${Math.round(v * 100)}%`);
  }
});
{
  const savedDim = parseFloat(localStorage.getItem('bgDim'));
  if (!Number.isNaN(savedDim)) bgUniforms.uDim.value = savedDim;
}

// (backdrop removed per user preference)

// no frame around the hologram — pure tree, per the reference
const treeGroup = new THREE.Group(); // rotated/scaled by the potter gesture
holo.add(treeGroup);

// ---------------------------------------------------------------------------
// Particle tree + branch skeleton
// ---------------------------------------------------------------------------
loaderText.textContent = 'Выращиваю дерево…';
const tree = buildTree();
console.log('tree particles:', tree.count, '| line verts:', tree.lineCount);

// vertical extents of the tree (holo-local, at treeGroup scale 1)
let treeMinY = 1e9, treeMaxY = -1e9;
for (let k = 1; k < tree.treePos.length; k += 3) {
  const y = tree.treePos[k];
  if (y < treeMinY) treeMinY = y;
  if (y > treeMaxY) treeMaxY = y;
}

// frame the shot for a TikTok take: the tree stands in the LEFT part of the
// frame, nearly full height, with ~150px of air above and below the crown
function frameTree() {
  const margin = 150;
  const frac = Math.max(0.4, (window.innerHeight - 2 * margin) / window.innerHeight);
  const viewH = 2 * camZBase * Math.tan(THREE.MathUtils.degToRad(22.5));
  const treeH = (treeMaxY - treeMinY) * holo.scale.y;
  // ×0.87: the tree has depth — near branches render ~15% taller than the
  // flat extents predict (measured against real screenshots)
  const s = (viewH * frac) / treeH * 0.87;
  treeScale = treeScaleTarget = s;
  treeGroup.scale.setScalar(s);
  const viewW = viewH * (window.innerWidth / window.innerHeight);
  holo.position.x = -viewW * 0.14; // left of center, nudged 10% rightward
  // camera looks at y≈0.05 — center the tree on that line
  holo.position.y = 0.05 - ((treeMinY + treeMaxY) / 2) * s * holo.scale.y;
}

const uniforms = {
  uTime:    { value: 0 },
  uReveal:  { value: 0 },
  uMix:     { value: 0 },
  uDeath:   { value: 0 },
  uNova:    { value: 0 },
  uHeartLocal: { value: new THREE.Vector3(0, -0.35, 0) },
  uHeartGlow:  { value: 0 },
  uStrain:     { value: 0 }, // tree strains toward the heart being pulled out
  uHandLocal:  { value: new THREE.Vector3(0, 99, 0) }, // hand in treeGroup space
  uHand:       { value: 0 },  // 0..1 — hand present near the tree
  uGust:       { value: 0 },  // wind gust strength envelope
  uGustDir:    { value: new THREE.Vector2(1, 0) },
  uGalaxyNorm: { value: 1 },  // 1/treeScale — the galaxy ignores potter zoom
  uPixelRatio: { value: renderer.getPixelRatio() },
  uScale:   { value: window.innerHeight / 800 }
};
window.addEventListener('resize', () => { uniforms.uScale.value = window.innerHeight / 800; });

const WOBBLE = /* glsl */`
  vec3 wobble(vec3 p, float seed, float amp) {
    return vec3(
      sin(uTime * 1.1 + seed * 37.0 + p.y * 2.0),
      sin(uTime * 0.9 + seed * 61.0 + p.x * 2.0),
      cos(uTime * 1.3 + seed * 23.0 + p.z * 2.0)
    ) * amp;
  }
`;

const pointsGeo = new THREE.BufferGeometry();
pointsGeo.setAttribute('position', new THREE.BufferAttribute(tree.treePos, 3));
pointsGeo.setAttribute('aExpand', new THREE.BufferAttribute(tree.expandPos, 3));
pointsGeo.setAttribute('aScatter', new THREE.BufferAttribute(tree.scatterPos, 3));
pointsGeo.setAttribute('aColor', new THREE.BufferAttribute(tree.colors, 3));
pointsGeo.setAttribute('aAttr', new THREE.BufferAttribute(tree.attrs, 4));
pointsGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 12);

const pointsMat = new THREE.ShaderMaterial({
  uniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 aExpand;
    attribute vec3 aScatter;
    attribute vec3 aColor;
    attribute vec4 aAttr; // seed, size, heightNorm, type(+strandFrac)

    uniform float uTime, uReveal, uMix, uDeath, uNova, uHeartGlow, uStrain, uHand, uGust, uGalaxyNorm, uPixelRatio, uScale;
    uniform vec3 uHeartLocal, uHandLocal;
    uniform vec2 uGustDir;

    varying vec3 vColor;
    varying float vAlpha;
    varying float vBoost;

    ${WOBBLE}

    void main() {
      float seed = aAttr.x;
      float size = aAttr.y;
      float hNorm = aAttr.z;
      float type = floor(aAttr.w + 0.0005); // 0 bark, 1 leaf, 2 strand
      float frac = aAttr.w - type;

      // --- expand (detail cloud), staggered ------------------------------
      // the galaxy target orbits CONTINUOUSLY; the mix only blends toward it.
      // (multiplying the angle by uMix made particles sweep wildly mid-
      // transition — this is what caused the jittery, overlapping look)
      // uGalaxyNorm cancels the potter zoom: the group matrix scales
      // everything, so pre-dividing keeps the galaxy the SAME size on screen
      // no matter how big the tree is — no more smeared, scattered chaos
      vec3 exp3 = aExpand * uGalaxyNorm;
      if (type > 0.5) {
        float ang = (0.1 + seed * 0.15) * uTime;
        float ca = cos(ang), sa = sin(ang);
        exp3.xz = mat2(ca, -sa, sa, ca) * exp3.xz;
      }
      float m = smoothstep(seed * 0.35, 0.65 + seed * 0.35, uMix);
      vec3 target = mix(position, exp3, m);

      // withering staggers from crown to roots
      float stag = (1.0 - hNorm) * 0.35 + seed * 0.2;
      float dg = smoothstep(stag, stag + 0.45, uDeath);

      // wind sway: strands swing most at their tips; a soulless tree is still
      float swayAmp = type < 0.5 ? 0.006 : (type < 1.5 ? 0.02 : 0.032 * (0.3 + frac));
      target += wobble(target, seed, mix(swayAmp, 0.05, m) * (1.0 - dg * 0.9));

      // wind gusts: a coherent lean that ripples down the strands, tips most
      float gustAmp = type > 1.5 ? (0.04 + 0.18 * frac * frac)
                    : (type > 0.5 ? 0.04 : 0.010);
      float gustWave = 0.65 + 0.35 * sin(uTime * 2.1 + target.y * 1.6 + seed * 9.0);
      target.xz += uGustDir * (uGust * gustAmp * gustWave) * (1.0 - dg);

      // --- reveal ------------------------------------------------------------
      // wood grows bottom-up; strands UNFURL from their anchor down to the tip
      // like wisteria uncoiling, cascading with the branch that carries them
      float hAnchor = hNorm + frac * 0.30; // approx height of the strand anchor
      float gate = type > 1.5
        ? (hAnchor * 0.55 + frac * 0.30 + seed * 0.10) * 0.8
        : (hNorm * 0.78 + seed * 0.22) * 0.8;
      gate = min(gate, 0.80);
      float r = smoothstep(gate, gate + 0.18, uReveal);
      vec3 pos = mix(aScatter, target, r);
      pos += wobble(pos * 1.7, seed + 3.0, 0.12) * (r * (1.0 - r) * 4.0);
      // unfurling strands overshoot downward and spring back into place
      if (type > 1.5) pos.y -= sin(min(r * 1.25, 1.0) * 3.14159) * 0.10 * frac;

      // --- death → wither: the tree shrivels, soulless but still standing.
      // The sag is clamped at ground level — nothing sinks below the roots
      // (unclamped, the strand curtain dropped out of the framed shot)
      vec3 withered = vec3(
        pos.x * 0.84,
        max(pos.y * 0.96 - 0.05 - 0.10 * length(pos.xz) - 0.05 * hNorm, -1.06),
        pos.z * 0.84
      );
      pos = mix(pos, withered, dg);

      // nearby wood strains toward the heart while it's being pulled out
      vec3 toHeart = uHeartLocal - pos;
      float hpd = length(toHeart);
      pos += (toHeart / max(hpd, 0.001))
        * (uStrain * 0.22 * exp(-hpd * hpd * 1.4)) * r;

      // living crown: strands part around the hand like water
      vec3 toHand = pos - uHandLocal;
      float hdd = length(toHand);
      float push = exp(-hdd * hdd * 3.2) * uHand;
      pos += (toHand / max(hdd, 0.001))
        * push * (type > 1.5 ? 0.15 + 0.20 * frac : 0.04) * r;

      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;

      float twinkle = 0.75 + 0.25 * sin(uTime * (2.0 + seed * 6.0) + seed * 80.0);
      gl_PointSize = size * uPixelRatio * uScale * twinkle
        * (1.0 + m * 0.4) * (1.0 + uNova * 0.8) * (13.0 / -mv.z);
      gl_PointSize *= mix(0.3, 1.0, r) * (1.0 - dg * 0.3);

      // soulless: drained ashen grey with a faint dying ember warmth —
      // clearly visible against the darkened room
      vec3 ashen = vec3(0.55, 0.50, 0.44) + vec3(0.1, 0.02, 0.0) * sin(seed * 30.0);
      vColor = mix(aColor, ashen, dg * 0.92);
      // the seed must READ against the glowing crown: instead of spilling
      // light onto nearby wood, it pushes the light BACK — a dark cavity
      // opens around the seed, with only a thin warm rim right at its edge
      float hd = distance(pos, uHeartLocal);
      vColor *= 1.0 - uHeartGlow * 0.8 * exp(-hd * hd * 2.2);
      vColor += vec3(1.0, 0.78, 0.45) * (uHeartGlow * 0.25 * exp(-hd * hd * 6.0));
      // resurrection: a blazing front CLIMBS THE WHOLE TREE root→tips as the
      // wither recedes, plus a radial surge from the implant point
      float wFront = (1.0 - uDeath) * 1.15 - 0.08;
      float wdh = hNorm - wFront;
      float climb = exp(-wdh * wdh * 70.0) * uNova;
      float wd = abs(hd - (1.0 - uDeath) * 3.0);
      float surge = exp(-wd * wd * 7.0) * uNova;
      vColor += vec3(1.0, 0.88, 0.58) * (climb * 5.5 + surge * 2.0);
      gl_PointSize *= 1.0 + climb * 1.6;

      // growth front: each particle ignites white-hot at the moment of its
      // birth, so light visibly crawls root → crown → strand tips
      float ignite = r * (1.0 - r) * 4.0;
      vColor += (aColor * 2.0 + vec3(1.0, 0.9, 0.6)) * ignite * 0.9;
      gl_PointSize *= 1.0 + ignite * 0.4;

      // ambient breath of Eywa: every ~12s a soft wave of light climbs the tree
      float bph = fract(uTime / 12.0);
      float bfr = hNorm - bph * 1.4 + 0.2;
      float breath = exp(-bfr * bfr * 50.0) * smoothstep(0.0, 0.06, bph)
        * (1.0 - m) * (1.0 - dg);
      vColor += aColor * breath * 1.4;
      gl_PointSize *= 1.0 + breath * 0.25;

      // the hand's touch lights the crown: local glow + waves rippling outward
      float ringR = fract(uTime * 0.55) * 1.4;
      float ring = exp(-pow((hdd - ringR) * 6.0, 2.0)) * (1.0 - fract(uTime * 0.55))
        * exp(-hdd * hdd * 0.8) * uHand;
      vColor += (aColor * 1.8 + vec3(0.55, 1.0, 0.85) * 0.6)
        * (push * 1.4 + ring * 0.8) * (1.0 - dg) * r
        * (1.0 - uHeartGlow * 0.8); // mute the hand ripple while the seed shows

      // gusts shake glowing pollen off the strand tips
      vColor *= 1.0 + uGust * 0.6 * smoothstep(0.85, 1.0, frac) * (1.0 - dg);

      vBoost = type < 0.5 ? 2.8 : (type < 1.5 ? 1.1 : 1.9);
      vAlpha = r * twinkle * (1.0 + uNova * 1.6) * (1.0 - dg * 0.25);
      vAlpha *= 0.93 + 0.07 * sin(uTime * 19.0 + hNorm * 40.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    varying float vAlpha;
    varying float vBoost;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      if (d > 0.5) discard;
      float glow = exp(-d * d * 16.0);
      gl_FragColor = vec4(vColor, vAlpha * glow * 0.18 * vBoost);
    }
  `
});
const points = new THREE.Points(pointsGeo, pointsMat);
treeGroup.add(points);

// glowing branch skeleton — makes the silhouette read as a real tree
const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.BufferAttribute(tree.linePos, 3));
lineGeo.setAttribute('aCol', new THREE.BufferAttribute(tree.lineCol, 3));
lineGeo.setAttribute('aLA', new THREE.BufferAttribute(tree.lineAttr, 2)); // hNorm, seed
lineGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 12);

const linesMat = new THREE.ShaderMaterial({
  uniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 aCol;
    attribute vec2 aLA;
    uniform float uTime, uReveal, uMix, uDeath, uNova;
    varying vec3 vColor;
    varying float vAlpha;
    ${WOBBLE}
    void main() {
      float hNorm = aLA.x, seed = aLA.y;
      float dg = smoothstep((1.0 - hNorm) * 0.35, (1.0 - hNorm) * 0.35 + 0.4, uDeath);
      vec3 pos = position + wobble(position, seed, (0.008 + hNorm * 0.012) * (1.0 - dg));
      // wither: the skeleton shrivels with the particles but keeps standing
      pos = mix(pos, vec3(pos.x * 0.84,
        max(pos.y * 0.96 - 0.05 - 0.10 * length(pos.xz), -1.06), pos.z * 0.84), dg);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      float gate = (hNorm * 0.78 + seed * 0.22) * 0.8;
      float r = smoothstep(gate, gate + 0.15, uReveal);
      float wdh = hNorm - ((1.0 - uDeath) * 1.15 - 0.08);
      float climb = exp(-wdh * wdh * 70.0) * uNova;
      float ignite = r * (1.0 - r) * 4.0; // growth front crawls up the wood
      float bph = fract(uTime / 12.0);
      float bfr = hNorm - bph * 1.4 + 0.2;
      float breath = exp(-bfr * bfr * 50.0) * smoothstep(0.0, 0.06, bph) * (1.0 - dg);
      vColor = mix(aCol * 1.4, vec3(0.5, 0.45, 0.38), dg * 0.9) * (1.0 + uNova * 1.2)
        + vec3(1.0, 0.88, 0.58) * climb * 4.0
        + (aCol * 1.6 + vec3(1.0, 0.9, 0.6) * 0.4) * ignite
        + aCol * breath * 1.2;
      vAlpha = r * (1.0 - uMix * 0.85) * (1.0 - dg * 0.3)
        * (0.85 + 0.15 * sin(uTime * 7.0 + seed * 30.0));
    }
  `,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(vColor, vAlpha); }
  `
});
treeGroup.add(new THREE.LineSegments(lineGeo, linesMat));

// (ground glow removed per user preference)

// ---------------------------------------------------------------------------
// Heart FX
// ---------------------------------------------------------------------------
const HEART_ANCHOR = new THREE.Vector3(0, -0.78, 0); // in the ROOT crown, on the rotation axis
const heart = createHeartParticles();
heart.uniforms.uPixelRatio.value = renderer.getPixelRatio();
scene.add(heart.object);
let heartBurstAt = -1; // simTime when the resurrection burst started

const _handW = new THREE.Vector3(); // hand → tree-shader uniform scratch

// wind gust scheduler state
let gustNextAt = 6, gustStartAt = -10, gustPeak = 0;

// veins anchored around the ROOT crown: lower trunk + root tips, so they
// stretch and tear one by one as the heart is pulled out
const tendrilAnchors = [];
for (let i = 0; i < 10; i++) {
  if (i < 5) {
    tendrilAnchors.push(new THREE.Vector3(
      Math.sin(i * 2.4) * 0.07, -0.92 + (i / 4) * 0.45, Math.cos(i * 1.9) * 0.07
    ));
  } else {
    const a = i * 1.256;
    tendrilAnchors.push(new THREE.Vector3(
      Math.cos(a) * 0.36, -0.97, Math.sin(a) * 0.36
    ));
  }
}
const tendrils = createTendrils(tendrilAnchors);
treeGroup.add(tendrils.group);

// three staggered shockwave rings = one "stellar explosion"
const shocks = [createShockwave(), createShockwave(), createShockwave()];
for (const s of shocks) scene.add(s.object);
let pendingShocks = [];
function fireShockBurst(pos, big) {
  const t = clockReal.elapsedTime;
  const delays = big ? [0, 0.15, 0.34] : [0, 0.18];
  const scales = big ? [1.5, 2.6, 4.0] : [1.1, 1.9];
  delays.forEach((d, i) =>
    pendingShocks.push({ at: t + d, pos: pos.clone(), scale: scales[i], idx: i % shocks.length }));
}

// lightning bolts radiating from impact points
const lightning = createLightning();
scene.add(lightning.group);

// the Gargantua moment: micro-black-hole with accretion disk + lensed halo
const quasar = createQuasar();
scene.add(quasar.object);

// full-screen flash + camera shake + space-ripple — the "big deal" kit
let shakeAmp = 0;
let warpStart = -1;
let pendingImpacts = [];
function scheduleImpact(delay, color, power, shake, origin) {
  pendingImpacts.push({
    at: clockReal.elapsedTime + delay, color, power, shake,
    origin: origin ? origin.clone() : null
  });
}
function bigImpact(color, flashPower, shake, warpOrigin) {
  grade.uniforms.uFlashColor.value.set(color);
  grade.uniforms.uFlash.value = flashPower;
  shakeAmp = Math.max(shakeAmp, shake);
  if (warpOrigin) {
    const s = worldToScreen(warpOrigin);
    grade.uniforms.uWarpCenter.value.set(s.x, 1 - s.y); // shader uv is bottom-up
    warpStart = clockReal.elapsedTime;
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
const S = {
  HIDDEN: 'HIDDEN', SUMMON: 'SUMMON', GROWING: 'GROWING', TREE: 'TREE',
  EXPANDED: 'EXPANDED', GRABBED: 'GRABBED', RIPPED: 'RIPPED', DEAD: 'DEAD',
  RESURRECT: 'RESURRECT'
};
const stateNames = {
  HIDDEN: 'СКРЫТО — подержи кулак и раскрой ✊…🖐', SUMMON: 'СЕМЯ ЛЕТИТ ☄️',
  GROWING: 'ПРОРАСТАЕТ 🌱',
  TREE: 'ДРЕВО ДУШ', EXPANDED: 'ЧАСТИЦЫ / ДЕТАЛИ',
  GRABBED: 'СЕМЯ ЭЙВЫ СХВАЧЕНО — ТЯНИ!', RIPPED: 'ДРЕВО ССЫХАЕТСЯ…',
  DEAD: 'поднеси семя к корню и раскрой ладонь', RESURRECT: 'ВОЗРОЖДЕНИЕ'
};

let state = S.HIDDEN;
let revealTarget = 0, mixTarget = 0, deathTarget = 0;
let autoGrow = false;
let heartGlowTarget = 0;
let timeScale = 1, timeScaleTarget = 1, slowmoUntil = 0;
let camZTarget = 6.4;
let gestureFlashUntil = 0;

const orbWorld = new THREE.Vector3();
const orbTargetW = new THREE.Vector3();
const anchorWorld = new THREE.Vector3();
let rotVel = 0;
let treeScale = 1, treeScaleTarget = 1; // real values come from frameTree()
// one-hand controls: turntable twist (rotate) + thumb-index pinch (scale)
const pinchZoom = { active: false, primeAt: 0, base: 1, baseScale: 1, releasedAt: 0 };
window.addEventListener('resize', frameTree); // fitCamera runs first (registered earlier)

function setState(s) {
  if (state === s) return;
  state = s;
  hudState.textContent = stateNames[s];
}
function flash(name) {
  hudGesture.textContent = name;
  gestureFlashUntil = performance.now() + 1400;
}

// --- coordinate mapping ----------------------------------------------------
// landmarks are in unmirrored video space (y down); the display is mirrored
// and cover-cropped, so map video → screen-uv before any spatial reasoning
function videoToScreen(vx, vy) {
  const s = bgUniforms.uUVScale.value;
  return { x: (0.5 - vx) / s.x + 0.5, y: (vy - 0.5) / s.y + 0.5 }; // y: 0 top
}
const _proj = new THREE.Vector3();
function worldToScreen(w) {
  _proj.copy(w).project(camera);
  return { x: (_proj.x + 1) / 2, y: (1 - _proj.y) / 2 };
}
const _ray = new THREE.Vector3();
function screenToWorldOnPlane(sx, syTop, planeZ, out) {
  _ray.set(sx * 2 - 1, -(syTop * 2 - 1), 0.5).unproject(camera);
  _ray.sub(camera.position).normalize();
  const t = (planeZ - camera.position.z) / _ray.z;
  return out.copy(camera.position).addScaledVector(_ray, t);
}
function screenDist(a, b) {
  const aspect = window.innerWidth / window.innerHeight;
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

// --- heart sequence triggers ------------------------------------------------
const clockReal = new THREE.Clock();
let simTime = 0;

function doRip() {
  setState(S.RIPPED);
  deathTarget = 1;
  tension = 0;
  orbSnapUntil = performance.now() + 340; // elastic release: heart whips to the hand
  quasar.fire(anchorWorld, clockReal.elapsedTime, 1.0, 1); // IMPLOSION: light sucked into the root
  lightning.strike(anchorWorld, clockReal.elapsedTime, 0xffb287, 4, 1.0);
  uniforms.uNova.value = 0.7;                              // death-front sweeps down the tree
  bigImpact(0xffc9a0, 0.25, 0.3);                          // dim ignition…
  scheduleImpact(0.9, 0xffd9b0, 0.9, 1.2, anchorWorld);    // …the dark POP at collapse
  timeScaleTarget = 0.22;
  slowmoUntil = performance.now() + 950;
  camZTarget = camZBase - 0.55;
  flash('💔 ВЫРВАНО');
}
function doResurrect() {
  setState(S.RESURRECT);
  deathTarget = 0;
  uniforms.uNova.value = 1;
  heartBurstAt = simTime; // the heart detonates into a newborn galaxy
  quasar.fire(orbWorld, clockReal.elapsedTime, 1.35); // full supernova at the root
  lightning.strike(orbWorld, clockReal.elapsedTime, 0xffe2c0, 7, 1.7);
  bigImpact(0xffedd2, 0.4, 0.5);                       // ignition glow…
  scheduleImpact(0.32, 0xfff6e8, 1.4, 1.5, orbWorld);  // …then the blinding peak
  timeScaleTarget = 0.35;                  // brief slow-mo to savour the moment
  slowmoUntil = performance.now() + 750;
  tendrils.reset();
  camZTarget = camZBase - 0.3;
  flash('✨ ВЗРЫВ СВЕРХНОВОЙ');
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------
const gestures = new GestureEngine(video, {
  onSnap() {
    // snap only SUMMONS — it also launches the comet, from the snapping hand
    if (state !== S.HIDDEN) return;
    flash('🫰 ЩЕЛЧОК');
    const tr = gestures.hands[0];
    if (tr) doSummon(videoToScreen(tr.x, tr.y));
    else { autoGrow = true; revealTarget = 1; setState(S.GROWING); }
  }
});

let fistNearStart = 0;   // closed-hand dwell near the heart → grab
let seedLostAt = 0;      // when the hand holding the seed vanished from frame

// --- summon: the seed of Eywa flies from the gesture to the planting spot ---
const summonFrom = new THREE.Vector3();
let summonPhase = 'birth'; // birth (condensing in the palm) → impact
let summonPhaseAt = 0;
let hiddenAt = 0;    // when the tree was hidden — summon cooldown
let budPrime = null; // two hands pressed together, waiting to spread apart

function doSummon(spawnScreen) {
  screenToWorldOnPlane(spawnScreen.x, spawnScreen.y, holo.position.z, summonFrom);
  orbWorld.copy(summonFrom);
  orbTargetW.copy(summonFrom);
  summonPhase = 'birth';
  summonPhaseAt = performance.now();
  heartGlowTarget = 1;
  actionHandId = null;
  budPrime = null;
  setState(S.SUMMON);
  flash('✨ СЕМЯ ЗАРОЖДАЕТСЯ…');
}

// the hand left the frame with the seed torn out — after a short grace
// (tracking dropouts are common) it slowly floats home to the root
function seedFloatHome(now) {
  if (!seedLostAt) { seedLostAt = now; return; }
  if (now - seedLostAt > 1200) orbTargetW.lerp(anchorWorld, 0.03);
}
let grabAt = 0;          // when the heart was grabbed (rip needs a hold first)
let tension = 0;         // 0..1 — how far the heart is stretched out of the root
let orbSnapUntil = 0;    // after the tear the heart whips to the hand briefly
const _handPoint = new THREE.Vector3();
let treeLockAt = 0;      // when the tree finished growing (hide-swipe grace)

// oldest history sample within the window — measures NET displacement of the
// hand, which is far more reliable than instantaneous (EMA-damped) velocity
function swipeSample(h, now, windowMs) {
  for (const s of (h.hist || [])) if (now - s.t <= windowMs) return s;
  return null;
}
let actionHandId = null; // the hand driving the current interaction — others ignored
let lastSh = null;       // debug: where the app thinks hands[0] is on screen

function handleHands(now) {
  // only tracks confirmed over several frames count as hands at all
  const real = gestures.hands.filter(t => t.hits >= 3);

  // primary hand: whoever is mid-action keeps priority; otherwise the most
  // established (longest-tracked, largest) hand wins
  let h = actionHandId != null ? real.find(t => t.id === actionHandId) : null;
  if (!h) h = real.slice().sort((a, b) => (b.hits - a.hits) || (b.size - a.size))[0] || null;

  // while an interaction is running, the second hand is IGNORED completely —
  // a phantom (or a stray real hand) can never hijack or block the action
  const busy = state === S.GROWING || state === S.SUMMON || state === S.GRABBED ||
    state === S.RIPPED || state === S.DEAD || state === S.RESURRECT ||
    uniforms.uHeartGlow.value > 0.15;
  const second = !busy && h
    ? real.find(t => t !== h && t.hits >= 5 && now - t.bornAt > 250) : null;
  const hands = second ? [h, second] : (h ? [h] : []);
  const two = hands.length >= 2;

  // hand HUD
  hudHand.textContent = hands.length === 0 ? 'не видно'
    : hands.length === 1
      ? (h.palm === 'open' ? '🖐 открыта' : h.palm === 'fist' ? '✊ кулак' : '· рука')
      : '🤲 две руки';

  // --- hide: a DELIBERATE downward palm swipe. Judged by NET displacement
  // over the last ~0.45s (velocity thresholds miss real swipes because both
  // the EMA filter and detection dropouts flatten the peaks), plus the hand
  // must still be moving down and mostly vertically. Crucially the swipe must
  // START FROM STILLNESS: a hand settling down after raising the tree descends
  // continuously and therefore was never still — it can't kill the tree.
  if (!two && h && (state === S.TREE || state === S.EXPANDED) &&
      now - treeLockAt > 1300 && now - h.bornAt > 650) {
    const s = swipeSample(h, now, 450);
    const pre = swipeSample(h, now, 700);
    const dy = s ? h.y - s.y : 0;
    const dx = s ? Math.abs(h.x - s.x) : 1e9;
    const wasStill = s && pre && Math.abs(s.y - pre.y) < 0.09;
    // current openness is NOT checked hard — a fast hand blurs and misreads
    // as half-closed right when the swipe should fire; the start pose plus
    // the trajectory are discriminative enough
    if (s && wasStill && dy > 0.18 && dx < dy * 1.2 && h.vy > 0.4 &&
        s.open > 1.15 && h.openness > 0.95) {
      revealTarget = 0;
      mixTarget = 0;
      hiddenAt = now; // arm the summon cooldown — no instant re-summon
      setState(S.HIDDEN);
      flash('🖐⬇ ПОГАШЕНО');
      return;
    }
  }

  // --- one-hand controls (tree shown) ---------------------------------------
  // TEMPORARILY DISABLED for filming — flip to true to bring rotate/scale back
  const CONTROLS_ON = false;
  if (CONTROLS_ON && h && (state === S.TREE || state === S.EXPANDED)) {
    // pinch-zoom: touch thumb+index together, then spread/close to resize.
    // Engaged by the touch (held ~150ms), released by opening the hand.
    if (!pinchZoom.active) {
      if (h.pinchIdx < 0.45 && h.openness < 1.5) {
        if (!pinchZoom.primeAt) pinchZoom.primeAt = now;
        if (now - pinchZoom.primeAt > 150) {
          pinchZoom.active = true;
          pinchZoom.base = Math.max(h.pinchIdx, 0.2);
          pinchZoom.baseScale = treeScaleTarget;
        }
      } else pinchZoom.primeAt = 0;
    } else if (h.openness > 1.6) {
      pinchZoom.active = false;
      pinchZoom.primeAt = 0;
      pinchZoom.releasedAt = now; // suppress the galaxy for a beat (see TREE)
    } else {
      treeScaleTarget = THREE.MathUtils.clamp(
        pinchZoom.baseScale * Math.pow(h.pinchIdx / pinchZoom.base, 0.9),
        0.7, 2.2);
      hudHand.textContent = '🤏 масштаб';
    }

    // turntable: an open, spread hand TWISTING in place spins the tree like
    // a plate. Angular velocity of the hand tilt drives it; a hand that is
    // merely translating (swipes) barely changes tilt and is ignored.
    if (!pinchZoom.active && h.openness > 1.25 &&
        Math.hypot(h.vx, h.vy) < 0.7 && Math.abs(h.angVel) > 0.7) {
      rotVel += (-h.angVel * 1.1 - rotVel) * 0.3;
      hudHand.textContent = '🖐↻ вращение';
    }
  } else {
    pinchZoom.active = false;
    pinchZoom.primeAt = 0;
  }

  // --- one-hand logic per state --------------------------------------------
  const sh = h ? videoToScreen(h.x, h.y) : null;
  lastSh = sh;
  anchorWorld.copy(HEART_ANCHOR).applyMatrix4(treeGroup.matrixWorld);
  const anchorScreen = worldToScreen(anchorWorld);
  const trunkDist = sh ? screenDist(sh, anchorScreen) : 1e9;
  const nearTrunk = trunkDist < 0.28;

  switch (state) {
    case S.HIDDEN: {
      heartGlowTarget = 0;
      // --- summon 1: a fist opening into a palm births the seed at the hand.
      // No pose/speed/height guards — they killed reliability. The only
      // protection is a short cooldown after a hide, which is when the
      // post-swipe hand flickers fist→open and used to re-summon falsely.
      if (h && h.justOpened && sh && now - hiddenAt > 1200) { doSummon(sh); break; }
      // --- summon 2: the monk bud — palms pressed together, then spread
      // apart. Detection keys on the DYNAMICS (two tracks born close and
      // flying apart), not on pose: pressed palms confuse the tracker,
      // separation doesn't.
      if (two) {
        const d = Math.hypot(hands[0].x - hands[1].x, hands[0].y - hands[1].y);
        if (!budPrime && d < 0.38) {
          budPrime = {
            at: now, d,
            mid: videoToScreen(
              (hands[0].x + hands[1].x) / 2, (hands[0].y + hands[1].y) / 2)
          };
        }
        if (budPrime && now - budPrime.at < 900 && d > budPrime.d + 0.18 &&
            now - hiddenAt > 1000) {
          doSummon(budPrime.mid);
          break;
        }
        if (budPrime && now - budPrime.at >= 900) budPrime = null;
      } else budPrime = null;
      break;
    }

    case S.SUMMON: {
      heartGlowTarget = summonPhase === 'impact' ? 0 : 1;
      if (summonPhase === 'birth') {
        // the seed CONDENSES out of the open palm — mote by mote — drifting
        // slightly upward, and follows the hand until it is fully formed.
        // (for the two-hand bud it stays where it was born, between the palms)
        if (h && sh && !two) screenToWorldOnPlane(sh.x, sh.y, holo.position.z, orbTargetW);
        orbTargetW.y += 0.14 * Math.min((now - summonPhaseAt) / 900, 1);
        if (now - summonPhaseAt > 900) {
          // no flight — the seed DETONATES right in the palm: an implosion,
          // light sucked in, and the tree erupts at its spot an instant later
          quasar.fire(orbWorld, clockReal.elapsedTime, 0.9, 1);
          lightning.strike(orbWorld, clockReal.elapsedTime, 0xffe2c0, 4, 1.0);
          bigImpact(0xffe9c9, 0.3, 0.4);
          scheduleImpact(0.6, 0xffedd6, 0.9, 1.1, orbWorld); // dark pop
          timeScaleTarget = 0.5;                // a breath of slow-mo
          slowmoUntil = performance.now() + 450;
          summonPhase = 'impact';
          summonPhaseAt = now;
          flash('🌌 ИМПУЛЬС');
        }
      } else if (now - summonPhaseAt > 650) {
        // the implosion has collapsed — the tree erupts from its afterglow
        uniforms.uNova.value = Math.max(uniforms.uNova.value, 0.6);
        autoGrow = true;
        revealTarget = 1;
        setState(S.GROWING);
        flash('🌱 ПРОРАСТАЕТ');
      }
      break;
    }

    case S.GROWING: {
      revealTarget = 1;
      if (uniforms.uReveal.value > 0.96) {
        treeLockAt = now; // arm the hide-swipe only after a grace period
        actionHandId = null;
        setState(S.TREE);
      }
      break;
    }

    case S.TREE: {
      // the heart reveals itself ONLY for a clenched hand at the root —
      // an open hand passing by keeps it hidden
      // a pinching hand is scaling, not grabbing — never wake the seed then
      const closedish = h && !pinchZoom.active &&
        (h.palm === 'fist' || h.openness < 1.28);
      heartGlowTarget = h && nearTrunk && closedish
        ? THREE.MathUtils.clamp(1 - trunkDist / 0.28, 0, 1) : 0;
      // grab: hand near the heart, fingers at least half-curled, held 300ms
      // AND nearly stationary — a hand just passing through never grabs
      const handSpeed = h ? Math.hypot(h.vx, h.vy) : 9;
      const grabbing = closedish && trunkDist < 0.28 && handSpeed < 0.45;
      if (grabbing && !fistNearStart) fistNearStart = now;
      if (!grabbing) fistNearStart = 0;
      if (h && ((h.justClosed && nearTrunk && handSpeed < 0.6) ||
                (fistNearStart && now - fistNearStart > 300))) {
        fistNearStart = 0;
        grabAt = now;
        actionHandId = h.id; // this hand owns the heart now
        setState(S.GRABBED);
        tendrils.reset();
        flash('🫀 СХВАТИЛ');
      } else if (h && h.justOpened && !nearTrunk &&
                 now - pinchZoom.releasedAt > 500) {
        // (opening the hand is also how a pinch-zoom ends — grace period)
        mixTarget = 1; setState(S.EXPANDED); flash('🖐 РАСКРЫТИЕ');
      }
      break;
    }

    case S.EXPANDED:
      if (h && h.justClosed) { mixTarget = 0; setState(S.TREE); flash('✊ СБОРКА'); }
      break;

    case S.GRABBED: {
      heartGlowTarget = 1;
      if (!h) {
        // the hand left the frame mid-pull — the seed springs back into
        // the root on its own (with a grace for tracking dropouts)
        if (!seedLostAt) seedLostAt = now;
        if (now - seedLostAt > 800) {
          seedLostAt = 0;
          tension = 0;
          actionHandId = null;
          setState(S.TREE); flash('🌳 ОТПУСТИЛ');
        }
        break;
      }
      seedLostAt = 0;
      {
        // elastic root: the heart resists, stretching out of the trunk like
        // it's held by living veins — tanh gives soft rubber-band feel
        screenToWorldOnPlane(sh.x, sh.y, holo.position.z, _handPoint);
        const v = _handPoint.sub(anchorWorld);
        const d = Math.max(v.length(), 1e-4);
        const stretch = 0.82 * Math.tanh(d / 0.85);
        tension = THREE.MathUtils.clamp(stretch / 0.82, 0, 1);
        orbTargetW.copy(anchorWorld).addScaledVector(v.divideScalar(d), stretch);
        // trembling grows with tension
        orbTargetW.x += Math.sin(simTime * 31.0) * 0.035 * tension * tension;
        orbTargetW.y += Math.cos(simTime * 37.0) * 0.035 * tension * tension;

        if (h.palm === 'open') {
          // opening the hand before the rip releases the heart — it springs
          // back into the root on its own
          tension = 0;
          actionHandId = null;
          setState(S.TREE); flash('🌳 ОТПУСТИЛ');
        } else if (d > 1.45 && now - grabAt > 350) {
          doRip();
        }
      }
      break;
    }

    case S.RIPPED: {
      heartGlowTarget = 1;
      if (h) { seedLostAt = 0; screenToWorldOnPlane(sh.x, sh.y, holo.position.z, orbTargetW); }
      else seedFloatHome(now); // no hand → the seed drifts back to the root
      if (uniforms.uDeath.value > 0.93) setState(S.DEAD);
      break;
    }

    case S.DEAD: {
      heartGlowTarget = 1;
      if (h) {
        seedLostAt = 0;
        screenToWorldOnPlane(sh.x, sh.y, holo.position.z, orbTargetW);
        // implant: bring the heart back TO THE ROOT and release it there
        const atRoot = trunkDist < 0.24;
        if (atRoot && (h.justOpened || (h.palm === 'open' && now - h.palmChangedAt > 200))) {
          doResurrect();
        }
      } else seedFloatHome(now); // no hand → the seed drifts back to the root
      break;
    }

    case S.RESURRECT: {
      heartGlowTarget = Math.max(0, heartGlowTarget - 0.02);
      orbTargetW.copy(anchorWorld);
      if (uniforms.uDeath.value < 0.05) {
        setState(S.TREE);
        camZTarget = camZBase;
        heartGlowTarget = 0;
        actionHandId = null;
      }
      break;
    }
  }

  if (state === S.TREE || state === S.GRABBED || state === S.RIPPED || state === S.DEAD) {
    if (state === S.TREE) orbTargetW.copy(anchorWorld);
  }
}

// ---------------------------------------------------------------------------
// Keyboard fallback / debug
// ---------------------------------------------------------------------------
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 't' || k === 'е') { autoGrow = true; revealTarget = 1; setState(S.GROWING); }
  if (k === 'h' || k === 'р') { revealTarget = 0; mixTarget = 0; deathTarget = 0; setState(S.HIDDEN); }
  if (k === 'e' || k === 'у') {
    mixTarget = state === S.EXPANDED ? 0 : 1;
    setState(state === S.EXPANDED ? S.TREE : S.EXPANDED);
  }
  if (k === 'r' || k === 'к') {
    orbTargetW.copy(anchorWorld).add(new THREE.Vector3(1.1, 0.2, 0));
    heartGlowTarget = 1;
    doRip();
  }
  if (k === 'n' || k === 'т') doResurrect();
});

if (ANY_FORCE) { loader.classList.add('hidden'); loader.style.display = 'none'; }
if (params.get('ui') === '0') {
  for (const id of ['hud', 'help', 'handdot']) document.getElementById(id).classList.add('ui-hidden');
}
{
  const forced = params.get('state');
  if (forced === 'tree') { revealTarget = 1; autoGrow = true; setState(S.GROWING); }
  if (forced === 'expanded') { revealTarget = 1; mixTarget = 1; setState(S.EXPANDED); }
}

fitCamera();
frameTree();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  loaderText.textContent = 'Запрашиваю доступ к камере…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await new Promise(res => (video.onloadedmetadata = res));
    await video.play();
    updateBgCover();
    bgUniforms.uReady.value = 1;
  } catch (e) {
    loaderText.textContent = 'Нет доступа к камере: ' + e.message;
    if (!ANY_FORCE) return;
  }

  loaderText.textContent = 'Загрузка нейронки трекинга рук…';
  try {
    await gestures.init();
  } catch (e) {
    hudGesture.textContent = 'ERR трекинга: ' + e.message;
  }

  loader.classList.add('hidden');
  hudState.textContent = stateNames[state];
  hudGesture.textContent = '🫰 щёлкни или подними ладонь';
}
boot();

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
function ease(cur, target, dt, speed) {
  return cur + (target - cur) * (1 - Math.exp(-speed * dt));
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clockReal.getDelta(), 0.05);
  const now = performance.now();
  adaptQuality(now, dt);

  // slow-mo recovery
  if (slowmoUntil && now > slowmoUntil) { timeScaleTarget = 1; slowmoUntil = 0; }
  timeScale = ease(timeScale, timeScaleTarget, dt, 3.5);
  const dts = dt * timeScale; // cinematic time
  simTime += dts;

  gestures.update(now);
  handleHands(now);
  gestures.consumeEvents();

  // uniforms easing (cinematic clock)
  uniforms.uTime.value = simTime;
  const rv = uniforms.uReveal.value;
  const revealSpeed = state === S.GROWING && !autoGrow ? 5.0 : (revealTarget > rv ? 1.6 : 2.2);
  let nr = ease(rv, revealTarget, dts, revealSpeed);
  // the growth cascade must be SEEN: however fast the hand shoots up, the
  // rise is rate-capped so root→crown→strands takes ~2s. Hiding stays fast.
  if (nr > rv) nr = Math.min(nr, rv + 0.5 * dts);
  uniforms.uReveal.value = nr;
  uniforms.uMix.value = ease(uniforms.uMix.value, mixTarget, dts, 2.4);
  uniforms.uDeath.value = ease(uniforms.uDeath.value, deathTarget,
    dts, deathTarget > uniforms.uDeath.value ? 0.55 : 0.7);
  uniforms.uNova.value *= Math.exp(-1.1 * dts);
  // slow rise → the seed materializes mote by mote; fast fall → dissolves away
  uniforms.uHeartGlow.value = ease(uniforms.uHeartGlow.value, heartGlowTarget, dt,
    heartGlowTarget > uniforms.uHeartGlow.value ? 3.2 : 7);

  // debug forces
  if (FORCE.r !== null) uniforms.uReveal.value = FORCE.r;
  if (FORCE.m !== null) uniforms.uMix.value = FORCE.m;
  if (FORCE.death !== null) uniforms.uDeath.value = FORCE.death;
  if (FORCE.nova !== null) uniforms.uNova.value = FORCE.nova;
  if (FORCE.heart !== null) {
    uniforms.uHeartGlow.value = FORCE.heart;
    anchorWorld.copy(HEART_ANCHOR).applyMatrix4(treeGroup.matrixWorld);
    orbTargetW.copy(anchorWorld);
    if (FORCE.orbx !== null) orbTargetW.x += FORCE.orbx;
    if (FORCE.orby !== null) orbTargetW.y += FORCE.orby;
    orbWorld.lerp(orbTargetW, 1);
  }

  // tree rotation / scale (turntable twist + inertia)
  rotVel *= Math.exp(-0.9 * dt); // long inertia after a spin
  treeGroup.rotation.y += rotVel * dt + 0.045 * dts; // idle slow spin
  treeScale = ease(treeScale, treeScaleTarget, dt, 5);
  treeGroup.scale.setScalar(treeScale);
  uniforms.uGalaxyNorm.value = 1 / treeScale;

  // strain: smoothed tension drives tree deformation + faster heartbeat
  if (state !== S.GRABBED) tension = 0;
  uniforms.uStrain.value = ease(uniforms.uStrain.value, tension, dt, 8);
  heart.uniforms.uTension.value = uniforms.uStrain.value;

  // heart follows its target (real time — must track the hand tightly);
  // right after the tear it WHIPS to the hand like a released elastic
  if (FORCE.heart === null) {
    if (orbWorld.lengthSq() === 0) orbWorld.copy(anchorWorld);
    const orbSpeed = state === S.SUMMON ? 30 : (now < orbSnapUntil ? 28 : 14);
    orbWorld.lerp(orbTargetW, 1 - Math.exp(-orbSpeed * dt));
  }
  heart.object.position.copy(orbWorld);
  heart.object.quaternion.copy(camera.quaternion); // heart shape faces the viewer
  heart.uniforms.uTime.value = simTime;
  heart.uniforms.uGlow.value = uniforms.uHeartGlow.value;
  heart.uniforms.uScale.value = uniforms.uScale.value;
  quasar.uniforms.uScale.value = uniforms.uScale.value;
  quasar.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  heart.uniforms.uBurst.value = heartBurstAt < 0 ? 0
    : THREE.MathUtils.smoothstep((simTime - heartBurstAt) / 1.6, 0, 1);
  if (heartBurstAt > 0 && simTime - heartBurstAt > 3) heartBurstAt = -1; // re-arm

  // --- wind gusts: random swells every 6–14s, smooth attack and decay -------
  if (simTime > gustNextAt) {
    gustNextAt = simTime + 6 + Math.random() * 8;
    gustStartAt = simTime;
    gustPeak = 0.5 + Math.random() * 0.5;
    const ga = Math.random() * Math.PI * 2;
    uniforms.uGustDir.value.set(Math.cos(ga), Math.sin(ga) * 0.4);
  }
  const gt = (simTime - gustStartAt) / 3.5;
  uniforms.uGust.value = gt < 1 ? Math.sin(gt * Math.PI) * gustPeak : 0;

  // --- living crown: feed the primary hand into the tree shader -------------
  let handTarget = 0;
  if (lastSh && (state === S.TREE || state === S.EXPANDED)) {
    screenToWorldOnPlane(lastSh.x, lastSh.y, holo.position.z, _handW);
    uniforms.uHandLocal.value.copy(treeGroup.worldToLocal(_handW.clone()));
    handTarget = 1;
  }
  uniforms.uHand.value = ease(uniforms.uHand.value, handTarget, dt, 5);

  // tendrils operate in treeGroup-local space
  const orbLocal = treeGroup.worldToLocal(orbWorld.clone());
  uniforms.uHeartLocal.value.copy(orbLocal);
  const tendrilStrength =
    (state === S.GRABBED || state === S.RIPPED) ? uniforms.uHeartGlow.value : 0;
  tendrils.update(orbLocal, tendrilStrength, simTime);

  // staggered shockwaves + flash decay + camera shake
  const tR = clockReal.elapsedTime;
  pendingShocks = pendingShocks.filter(p => {
    if (tR >= p.at) { shocks[p.idx].fire(p.pos, tR, p.scale); return false; }
    return true;
  });
  for (const s of shocks) s.update(tR, camera);
  lightning.update(tR);
  quasar.update(tR, camera, simTime);
  pendingImpacts = pendingImpacts.filter(p => {
    if (tR >= p.at) { bigImpact(p.color, p.power, p.shake, p.origin); return false; }
    return true;
  });
  grade.uniforms.uFlash.value *= Math.exp(-5.5 * dt);
  grade.uniforms.uWarpProg.value = warpStart < 0 ? 1
    : Math.min((tR - warpStart) / 0.8, 1);
  shakeAmp *= Math.exp(-3.2 * dt);

  // camera: slight drift + push-in on rip + impact shake
  camera.position.z = ease(camera.position.z, camZTarget, dt, 2.0);
  camera.position.x = Math.sin(simTime * 0.15) * 0.06
    + (Math.sin(tR * 51.7) + Math.sin(tR * 33.1)) * 0.035 * shakeAmp;
  camera.position.y = 0.15
    + (Math.cos(tR * 43.9) + Math.sin(tR * 27.3)) * 0.028 * shakeAmp;
  camera.lookAt(0, 0.05, 0);


  if (gestureFlashUntil && now > gestureFlashUntil) {
    hudGesture.textContent = '—';
    gestureFlashUntil = 0;
  }
  if (DEBUG) {
    const h0 = gestures.hands[0];
    hudGesture.textContent =
      `r=${uniforms.uReveal.value.toFixed(2)} m=${uniforms.uMix.value.toFixed(2)} ` +
      `px=${renderer.getPixelRatio().toFixed(2)} ` +
      `d=${uniforms.uDeath.value.toFixed(2)} hg=${uniforms.uHeartGlow.value.toFixed(2)} st=${state}` +
      (h0 ? ` | o=${h0.openness.toFixed(2)} p=${h0.pinch.toFixed(2)} ${h0.palm}` : ' | нет руки');
    const dot = document.getElementById('handdot');
    if (dot) {
      if (lastSh) {
        dot.style.display = 'block';
        dot.style.left = (lastSh.x * 100) + '%';
        dot.style.top = (lastSh.y * 100) + '%';
      } else dot.style.display = 'none';
    }
  }

  composer.render();
});
