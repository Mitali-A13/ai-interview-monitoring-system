/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   ai/eyeTracking.js — Gaze Direction & Look-Away Detector

   ┌─────────────────────────────────────────────────────────────┐
   │  HOW IT WORKS                                               │
   │                                                             │
   │  MediaPipe FaceMesh (refineLandmarks: true) provides 478    │
   │  normalised landmarks per face.  This module computes the   │
   │  horizontal and vertical iris position relative to the eye  │
   │  socket corners, producing a gaze ratio in [0, 1] for each  │
   │  axis.  Both eyes are measured and averaged to cancel out   │
   │  asymmetry caused by natural head tilt.                     │
   │                                                             │
   │  GAZE RATIO (horizontal)                                    │
   │  ──────────────────────                                     │
   │  ratio = (iris.x - outerCorner.x)                          │
   │          ────────────────────────                           │
   │          (innerCorner.x - outerCorner.x)                   │
   │                                                             │
   │  0.0 ─── looking hard left                                  │
   │  0.5 ─── looking straight at screen  (normal)              │
   │  1.0 ─── looking hard right                                 │
   │                                                             │
   │  SMOOTHING                                                  │
   │  ─────────                                                  │
   │  A rolling window of the last SMOOTH_WINDOW raw direction   │
   │  results is kept.  A direction is declared only when it     │
   │  appears in > 60 % of the window, preventing single-frame   │
   │  spikes from counting as "away".                            │
   │                                                             │
   │  VIOLATION LOGIC                                            │
   │  ───────────────                                            │
   │  A wall-clock timer tracks how long the smoothed gaze has   │
   │  been "away".  Only after 5 continuous seconds away does    │
   │  registerViolation("Looking away from screen") fire.        │
   │  Glances shorter than 1 s are completely ignored.           │
   └─────────────────────────────────────────────────────────────┘

   Landmark indices used  (per MediaPipe FaceMesh canonical map)
   ─────────────────────────────────────────────────────────────
   Left eye  : outer 33, inner 133, top 160, bottom 144,
               also: 158, 153 (EAR calculation)
   Right eye : outer 263, inner 362, top 387, bottom 380,
               also: 385, 373 (EAR calculation)
   Left iris : 468  (centre — requires refineLandmarks: true)
   Right iris: 473  (centre)

   Integration
   ─────────────────────────────────────────────────────────────
   Called per-frame by ai/faceDetection.js:
     EyeTracking.processFrame(landmarks);

   Also callable directly (spec-required named export):
     processEyeTracking(landmarks);
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const EyeTracking = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        1.  CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     // ── Landmark indices (spec + EAR supplements) ─────────────────
     const LM = {
       // Left eye — spec indices: 33, 160, 158, 133, 153, 144
       L_OUTER:  33,   // left-most corner
       L_INNER:  133,  // right-most (inner canthus)
       L_TOP_A:  160,
       L_TOP_B:  158,
       L_BOT_A:  144,
       L_BOT_B:  153,
       L_IRIS:   468,  // refined landmark — iris centre
   
       // Right eye — spec indices: 263, 387, 385, 362, 380, 373
       R_OUTER:  263,  // right-most corner
       R_INNER:  362,  // left-most (inner canthus)
       R_TOP_A:  387,
       R_TOP_B:  385,
       R_BOT_A:  373,
       R_BOT_B:  380,
       R_IRIS:   473,  // refined landmark — iris centre
     };
   
     // ── Gaze classification thresholds ────────────────────────────
     const GAZE_THRESHOLD = {
       H_LEFT:   0.38,   // horizontal ratio below this → looking left
       H_RIGHT:  0.62,   // horizontal ratio above this → looking right
       V_UP:     0.38,   // vertical ratio below this   → looking up
       V_DOWN:   0.68,   // vertical ratio above this   → looking down
     };
   
     // ── Eye Aspect Ratio — blink / eye-closed detection ───────────
     const EAR_THRESHOLD = 0.18;  // below this → eye closed (ignore frame)
   
     // ── Smoothing ─────────────────────────────────────────────────
     /** Rolling window size for direction smoothing (frames). */
     const SMOOTH_WINDOW = 10;
   
     /**
      * Fraction of window that must agree on a direction before it is
      * declared.  0.6 = 60 % majority.
      */
     const SMOOTH_MAJORITY = 0.6;
   
     // ── Violation timing ──────────────────────────────────────────
     /**
      * Continuous seconds looking away before a violation fires.
      * Spec requirement: 5 seconds.
      */
     const AWAY_VIOLATION_SECS = 5;
   
     /**
      * Glances shorter than this many seconds are silently ignored.
      * Spec requirement: < 1 second.
      */
     const IGNORE_BELOW_SECS = 1;
   
     /**
      * Minimum ms between two accepted "Looking away" violations.
      * Longer than ViolationManager.DEBOUNCE_MS (3 000 ms).
      */
     const VIOLATION_COOLDOWN_MS = 8_000;
   
     /* ══════════════════════════════════════════════════════════════
        2.  STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Rolling buffer of the last SMOOTH_WINDOW raw direction strings. */
     const _dirBuffer = [];
   
     /**
      * Wall-clock timestamp (ms) when the candidate's gaze first moved
      * away from centre.  null when gaze is on-screen.
      */
     let _awayStartTime = null;
   
     /** Wall-clock timestamp of the last accepted violation. */
     let _lastViolationAt = 0;
   
     /** The smoothed direction label shown in the UI. */
     let _smoothedDirection = "Center";
   
     /** Whether the candidate is currently classified as "away". */
     let _isCurrentlyAway = false;
   
     /** Seconds the candidate has been away in the current streak. */
     let _awaySeconds = 0;
   
     /** Session statistics exposed via getStats(). */
     const _stats = {
       framesAnalysed:     0,
       framesAway:         0,
       violations:         0,
       totalAwaySeconds:   0,
       directionCounts:    { Center: 0, Left: 0, Right: 0, Up: 0, Down: 0 },
     };
   
     /* ══════════════════════════════════════════════════════════════
        3.  PRIVATE UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     function _el(id) { return document.getElementById(id); }
     function _setText(id, val) { const e = _el(id); if (e) e.textContent = val; }
   
     function _setModuleState(state, label) {
       if (typeof window.setModuleState === "function") {
         window.setModuleState("eye", state, label);
       }
     }
   
     function _register(reason, severity) {
       if (window.ViolationManager?.isTerminated()) return;
       if (typeof window.registerViolation === "function") {
         window.registerViolation(reason, severity);
       }
     }
   
     /**
      * Safe landmark accessor — returns { x, y } or null.
      * MediaPipe normalises all coordinates to [0, 1].
      */
     function _pt(lm, idx) {
       const p = lm[idx];
       return (p && typeof p.x === "number") ? { x: p.x, y: p.y } : null;
     }
   
     /** Euclidean distance between two points. */
     function _dist(a, b) {
       return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
     }
   
     /* ══════════════════════════════════════════════════════════════
        4.  EYE ASPECT RATIO  (blink / closed-eye guard)
        ══════════════════════════════════════════════════════════════
   
        EAR = (|p1-p5| + |p2-p4|) / (2 × |p0-p3|)
   
        where p0/p3 are the horizontal corners and p1/p2/p4/p5 are
        the vertical lid points.  EAR < EAR_THRESHOLD → eye is closed.
        We skip gaze analysis on closed eyes to avoid erratic ratios.
        ══════════════════════════════════════════════════════════════ */
   
     function _ear(lm, outerIdx, innerIdx, topAIdx, topBIdx, botAIdx, botBIdx) {
       const outer = _pt(lm, outerIdx);
       const inner = _pt(lm, innerIdx);
       const topA  = _pt(lm, topAIdx);
       const topB  = _pt(lm, topBIdx);
       const botA  = _pt(lm, botAIdx);
       const botB  = _pt(lm, botBIdx);
   
       if (!outer || !inner || !topA || !topB || !botA || !botB) return 1; // assume open
   
       const horizontal = _dist(outer, inner);
       if (horizontal < 0.001) return 1;
   
       const vertA = _dist(topA, botA);
       const vertB = _dist(topB, botB);
   
       return (vertA + vertB) / (2 * horizontal);
     }
   
     /* ══════════════════════════════════════════════════════════════
        5.  GAZE RATIO COMPUTATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Horizontal iris ratio for one eye.
      * 0 = iris at outer corner (looking away from nose)
      * 1 = iris at inner corner (looking toward nose)
      *
      * We normalise so 0.5 always means "centre" regardless of which
      * eye we're measuring.
      */
     function _hRatio(lm, outerIdx, innerIdx, irisIdx) {
       const outer = _pt(lm, outerIdx);
       const inner = _pt(lm, innerIdx);
       const iris  = _pt(lm, irisIdx);
       if (!outer || !inner || !iris) return 0.5;
   
       const leftX  = Math.min(outer.x, inner.x);
       const width  = Math.abs(inner.x - outer.x);
       if (width < 0.001) return 0.5;
   
       const raw = (iris.x - leftX) / width;
       // For the right eye the axis is flipped relative to the left eye;
       // mirror it so 0 = left-looking and 1 = right-looking for both.
       return (outerIdx === LM.R_OUTER) ? 1 - raw : raw;
     }
   
     /**
      * Vertical iris ratio for one eye.
      * 0 = iris at top lid  → looking up
      * 1 = iris at bottom lid → looking down
      */
     function _vRatio(lm, topAIdx, botAIdx, irisIdx) {
       const top   = _pt(lm, topAIdx);
       const bot   = _pt(lm, botAIdx);
       const iris  = _pt(lm, irisIdx);
       if (!top || !bot || !iris) return 0.5;
   
       const height = Math.abs(bot.y - top.y);
       if (height < 0.001) return 0.5;
   
       return (iris.y - Math.min(top.y, bot.y)) / height;
     }
   
     /* ══════════════════════════════════════════════════════════════
        6.  DIRECTION CLASSIFICATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Classifies the current frame's raw gaze into one of:
      * "Center" | "Left" | "Right" | "Up" | "Down"
      *
      * Returns null when both eyes are closed (blink guard).
      *
      * @param {Array} lm  MediaPipe landmark array.
      * @returns {string|null}
      */
     function _classifyRaw(lm) {
       // ── Blink / closed-eye guard ──────────────────────────────────
       const earL = _ear(lm, LM.L_OUTER, LM.L_INNER, LM.L_TOP_A, LM.L_TOP_B, LM.L_BOT_A, LM.L_BOT_B);
       const earR = _ear(lm, LM.R_OUTER, LM.R_INNER, LM.R_TOP_A, LM.R_TOP_B, LM.R_BOT_A, LM.R_BOT_B);
   
       if (earL < EAR_THRESHOLD && earR < EAR_THRESHOLD) {
         return null; // both eyes closed — skip this frame
       }
   
       // ── Iris ratios ───────────────────────────────────────────────
       const hL = _hRatio(lm, LM.L_OUTER, LM.L_INNER, LM.L_IRIS);
       const hR = _hRatio(lm, LM.R_OUTER, LM.R_INNER, LM.R_IRIS);
       const h  = (hL + hR) / 2;
   
       const vL = _vRatio(lm, LM.L_TOP_A, LM.L_BOT_A, LM.L_IRIS);
       const vR = _vRatio(lm, LM.R_TOP_A, LM.R_BOT_A, LM.R_IRIS);
       const v  = (vL + vR) / 2;
   
       // ── Classify — horizontal takes priority over vertical ────────
       if      (h < GAZE_THRESHOLD.H_LEFT)  return "Left";
       else if (h > GAZE_THRESHOLD.H_RIGHT) return "Right";
       else if (v < GAZE_THRESHOLD.V_UP)    return "Up";
       else if (v > GAZE_THRESHOLD.V_DOWN)  return "Down";
       else                                  return "Center";
     }
   
     /* ══════════════════════════════════════════════════════════════
        7.  SMOOTHING  (rolling majority vote)
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Pushes a new raw direction into the rolling buffer and returns
      * the majority-vote smoothed direction.  Null frames (blinks) are
      * not pushed so they don't dilute the window.
      *
      * @param {string|null} rawDir
      * @returns {string}  The smoothed direction.
      */
     function _smooth(rawDir) {
       if (rawDir !== null) {
         _dirBuffer.push(rawDir);
         if (_dirBuffer.length > SMOOTH_WINDOW) _dirBuffer.shift();
       }
   
       if (_dirBuffer.length === 0) return "Center";
   
       // Count occurrences of each direction in the window
       const counts = {};
       for (const d of _dirBuffer) counts[d] = (counts[d] || 0) + 1;
   
       // Find the most frequent direction
       let best = "Center", bestCount = 0;
       for (const [dir, cnt] of Object.entries(counts)) {
         if (cnt > bestCount) { bestCount = cnt; best = dir; }
       }
   
       // Only declare if it exceeds the majority threshold
       return (bestCount / _dirBuffer.length) >= SMOOTH_MAJORITY ? best : "Center";
     }
   
     /* ══════════════════════════════════════════════════════════════
        8.  TIME-BASED AWAY TRACKING & VIOLATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Called on every frame with the smoothed direction.
      * Manages wall-clock timers and fires violations when appropriate.
      *
      * @param {string} direction  Smoothed gaze direction.
      */
     function _updateAwayTimer(direction) {
       const isAway = direction !== "Center";
       const nowMs  = Date.now();
   
       if (isAway) {
         _stats.framesAway++;
   
         if (_awayStartTime === null) {
           _awayStartTime = nowMs;
         }
   
         _awaySeconds = (nowMs - _awayStartTime) / 1000;
         _stats.totalAwaySeconds += 1 / 30; // approx 30 fps contribution
   
         // ── Update UI with elapsed away-time ──────────────────────
         const secsStr = _awaySeconds.toFixed(1);
         _setText("eyeStatus", `${direction} (${secsStr}s)`);
         _setModuleState("warn", direction);
   
         // ── Violation: away for ≥ 5 continuous seconds ────────────
         if (_awaySeconds >= AWAY_VIOLATION_SECS) {
           if (nowMs - _lastViolationAt >= VIOLATION_COOLDOWN_MS) {
             _lastViolationAt = nowMs;
             _stats.violations++;
             _register("Looking away from screen", "MEDIUM");
   
             console.warn(
               `%c[EyeTracking] Violation: "${direction}" for ${_awaySeconds.toFixed(1)}s.`,
               "color:#d29922;font-family:monospace;font-weight:600"
             );
           }
         }
   
       } else {
         // ── Gaze returned to screen ────────────────────────────────
         if (_awayStartTime !== null) {
           const awayDuration = (nowMs - _awayStartTime) / 1000;
   
           if (awayDuration >= IGNORE_BELOW_SECS) {
             // Glance long enough to log at debug level
             console.debug(
               `[EyeTracking] Gaze returned after ${awayDuration.toFixed(2)}s away.`
             );
           }
           // Glances < 1 s are silently ignored (no log entry)
         }
   
         _awayStartTime = null;
         _awaySeconds   = 0;
         _setText("eyeStatus", "Looking at screen");
         _setModuleState("active", "On Screen");
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        9.  PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * processFrame(landmarks)
      * ────────────────────────
      * Main entry point called by faceDetection.js on every frame.
      *
      * @param {Array|null} landmarks  MediaPipe 478-point landmark array,
      *                                or null when no face is detected.
      */
     function processFrame(landmarks) {
       _stats.framesAnalysed++;
   
       // ── No face ────────────────────────────────────────────────
       if (!landmarks || landmarks.length < 468) {
         _dirBuffer.length = 0;
         _awayStartTime    = null;
         _awaySeconds      = 0;
         _smoothedDirection = "—";
         _setText("eyeStatus", "—");
         _setModuleState("warn", "No Face");
         return;
       }
   
       // ── Raw classification ─────────────────────────────────────
       const rawDir = _classifyRaw(landmarks);
   
       // ── Smoothing ──────────────────────────────────────────────
       _smoothedDirection = _smooth(rawDir);
       _stats.directionCounts[_smoothedDirection] =
         (_stats.directionCounts[_smoothedDirection] || 0) + 1;
   
       // ── Debug log (every 30 frames ≈ every 1 s) ───────────────
       if (_stats.framesAnalysed % 30 === 0) {
         console.log(
           `[EyeTracking] Gaze direction: ${_smoothedDirection}` +
           (rawDir ? ` (raw: ${rawDir})` : " (blink)")
         );
       }
   
       // ── Time tracking + violation ──────────────────────────────
       _updateAwayTimer(_smoothedDirection);
   
       // ── Update left-panel "isCurrentlyAway" state ──────────────
       _isCurrentlyAway = (_smoothedDirection !== "Center" && _smoothedDirection !== "—");
     }
   
     /**
      * getStats()
      * Returns a snapshot of session data — useful for review or testing.
      */
     function getStats() {
       return {
         smoothedDirection: _smoothedDirection,
         isAway:            _isCurrentlyAway,
         awaySeconds:       _awaySeconds,
         framesAnalysed:    _stats.framesAnalysed,
         framesAway:        _stats.framesAway,
         violations:        _stats.violations,
         totalAwaySeconds:  _stats.totalAwaySeconds,
         directionCounts:   { ..._stats.directionCounts },
         thresholds:        { ...GAZE_THRESHOLD },
         violationAfterSecs: AWAY_VIOLATION_SECS,
       };
     }
   
     return { processFrame, getStats, LM, GAZE_THRESHOLD };
   
   })(); // end EyeTracking IIFE
   
   
   /* ══════════════════════════════════════════════════════════════
      NAMED EXPORT  (spec requirement)
      ══════════════════════════════════════════════════════════════ */
   
   /**
    * processEyeTracking(landmarks)
    * ──────────────────────────────
    * Spec-required named function export.
    * Delegates to EyeTracking.processFrame().
    *
    * @param {Array|null} landmarks
    */
   function processEyeTracking(landmarks) {
     EyeTracking.processFrame(landmarks);
   }
   
   /* ── Global aliases ──────────────────────────────────────────── */
   window.EyeTracking        = EyeTracking;
   window.processEyeTracking = processEyeTracking;
   
   console.log(
     "%c[EyeTracking] Module loaded — " +
     `violation after ${5}s away | ignore < ${1}s glances | smoothing: ${10}-frame window`,
     "color:#8b949e;font-family:monospace"
   );