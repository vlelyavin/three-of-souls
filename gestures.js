// Hand tracking on top of MediaPipe HandLandmarker (2 hands).
// Philosophy: continuous state polled every frame (positions, velocities,
// openness) + a minimal set of discrete events (snap, stable palm changes).
// All positions are in video-normalized coords (0..1, unmirrored, y down).

import {
  HandLandmarker,
  FilesetResolver
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const PALM_OPEN_T = 1.35;  // openness hysteresis
const PALM_FIST_T = 1.12;
const STABLE_FRAMES = 4;   // raw palm class must hold N frames to commit
const TRACK_TTL = 250;     // ms a track survives without detection
const DEDUPE_DIST = 0.22;  // two detections this close = the same physical hand

export class GestureEngine {
  constructor(video, callbacks) {
    this.video = video;
    this.cb = callbacks; // { onSnap() }
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.tracks = [];
    this.lastSnapAt = 0;
    this._nextId = 1;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4
    });
  }

  get hands() {
    return this.tracks;
  }

  update(now) {
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const res = this.landmarker.detectForVideo(this.video, now);
    let detected = (res.landmarks || []).map((lm, k) => {
      const m = this._measure(lm);
      m.score = res.handednesses?.[k]?.[0]?.score ?? 1;
      return m;
    });
    // weak detections are usually ghosts of the same hand — drop them
    detected = detected.filter(m => m.score > 0.7);

    // MediaPipe sometimes reports the same physical hand twice — drop clones
    detected = detected.filter((m, k) =>
      !detected.some((o, j) => j < k && Math.hypot(o.x - m.x, o.y - m.y) < DEDUPE_DIST));

    const unmatched = new Set(detected.map((_, k) => k));
    for (const tr of this.tracks) {
      // match against the PREDICTED position — a fast swipe moves the hand far
      // between detections and would otherwise spawn a fresh (unconfirmed) track
      const dtP = Math.min((now - tr.seenAt) / 1000, 0.2);
      const px = tr.x + tr.vx * dtP, py = tr.y + tr.vy * dtP;
      let best = -1, bestD = 0.5;
      for (const k of unmatched) {
        const d = Math.hypot(detected[k].x - px, detected[k].y - py);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best >= 0) {
        unmatched.delete(best);
        this._feed(tr, detected[best], now);
      }
    }
    for (const k of unmatched) {
      const m = detected[k];
      this.tracks.push({
        id: this._nextId++,
        x: m.x, y: m.y, vx: 0, vy: 0,
        size: m.size, openness: m.openness,
        palm: 'unknown', rawPalm: 'unknown', rawCount: 0,
        palmChangedAt: now, prevPalmDur: 0,
        justOpened: false, justClosed: false,
        pinch: m.pinch, pinchPrimedAt: 0, primedFrames: 0,
        pinchIdx: m.pinchIdx, ang: m.ang, angVel: 0,
        hist: [{ x: m.x, y: m.y, t: now, open: m.openness }],
        seenAt: now, bornAt: now, hits: 1
      });
    }
    this.tracks = this.tracks.filter(t => now - t.seenAt < TRACK_TTL);
  }

  consumeEvents() {
    for (const t of this.tracks) { t.justOpened = false; t.justClosed = false; }
  }

  _measure(lm) {
    const wrist = lm[0], midMcp = lm[9];
    const scale = Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y) + 1e-6;
    const tips = [8, 12, 16, 20];
    let openness = 0;
    for (const t of tips) openness += Math.hypot(lm[t].x - wrist.x, lm[t].y - wrist.y);
    openness = openness / tips.length / scale;
    const pinch = Math.hypot(lm[4].x - lm[12].x, lm[4].y - lm[12].y) / scale;
    const pinchIdx = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / scale;
    const ang = Math.atan2(midMcp.y - wrist.y, midMcp.x - wrist.x); // hand tilt
    const cx = (wrist.x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
    const cy = (wrist.y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
    return { x: cx, y: cy, size: scale, openness, pinch, pinchIdx, ang };
  }

  _feed(tr, m, now) {
    const dt = Math.max((now - tr.seenAt) / 1000, 1e-3);
    // adaptive smoothing: small jitter is filtered hard, big jumps (deliberate
    // swipes) pass through almost raw so the track never lags a fast hand
    const a = Math.min(0.5 + Math.hypot(m.x - tr.x, m.y - tr.y) * 3.0, 0.9);
    const nx = tr.x + (m.x - tr.x) * a;
    const ny = tr.y + (m.y - tr.y) * a;
    tr.vx = tr.vx * 0.6 + ((nx - tr.x) / dt) * 0.4;
    tr.vy = tr.vy * 0.6 + ((ny - tr.y) / dt) * 0.4;
    tr.x = nx; tr.y = ny;
    tr.hist.push({ x: nx, y: ny, t: now, open: tr.openness });
    while (tr.hist.length && now - tr.hist[0].t > 700) tr.hist.shift();
    tr.size += (m.size - tr.size) * 0.35;
    tr.openness += (m.openness - tr.openness) * 0.4;
    tr.pinchIdx += (m.pinchIdx - tr.pinchIdx) * 0.5;
    // hand tilt: angular velocity of the wrist→knuckles vector (turntable)
    let dA = m.ang - tr.ang;
    if (dA > Math.PI) dA -= 2 * Math.PI;
    else if (dA < -Math.PI) dA += 2 * Math.PI;
    tr.angVel = tr.angVel * 0.6 + (dA / dt) * 0.4;
    tr.ang = m.ang;
    tr.seenAt = now;
    tr.hits++;

    // --- stable palm classification with hysteresis ------------------------
    let raw = tr.rawPalm;
    if (tr.openness > PALM_OPEN_T) raw = 'open';
    else if (tr.openness < PALM_FIST_T) raw = 'fist';
    if (raw === tr.rawPalm) tr.rawCount++;
    else { tr.rawPalm = raw; tr.rawCount = 1; }

    if (tr.rawCount >= STABLE_FRAMES && raw !== tr.palm && raw !== 'unknown') {
      if (tr.palm === 'fist' && raw === 'open') tr.justOpened = true;
      if (tr.palm === 'open' && raw === 'fist') tr.justClosed = true;
      tr.prevPalmDur = now - tr.palmChangedAt; // how long the previous pose held
      tr.palm = raw;
      tr.palmChangedAt = now;
    }

    // --- snap: thumb+middle held in contact (other fingers half-open),
    // then a FAST separation. Guards against fist→open false positives:
    //  * priming requires ≥2 contact frames and a non-fist pose
    //  * firing requires high separation velocity within a short window
    //  * suppressed right after any palm state change
    const pinchVel = (m.pinch - tr.pinch) / dt; // units/s
    if (m.pinch < 0.4 && tr.openness > 1.0 && tr.openness < 1.85 && tr.palm !== 'fist') {
      tr.primedFrames++;
      tr.pinchPrimedAt = now;
    }
    if (
      tr.primedFrames >= 2 &&
      m.pinch > 1.0 &&
      now - tr.pinchPrimedAt < 260 &&
      pinchVel > 5.0 &&
      now - tr.palmChangedAt > 350 &&
      now - this.lastSnapAt > 1200
    ) {
      tr.primedFrames = 0;
      tr.pinchPrimedAt = 0;
      this.lastSnapAt = now;
      this.cb.onSnap?.();
    }
    if (now - tr.pinchPrimedAt > 400) tr.primedFrames = 0;
    tr.pinch = m.pinch;
  }
}
