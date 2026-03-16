/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   ai/lipMovement.js — Lip / Mouth Movement Detector

   ┌─────────────────────────────────────────────────────────────┐
   │  HOW IT WORKS                                               │
   │                                                             │
   │  MOUTH ASPECT RATIO (MAR)                                   │
   │  ─────────────────────────                                  │
   │  Using four MediaPipe landmarks:                            │
   │    13  → upper lip centre                                   │
   │    14  → lower lip centre                                   │
   │    61  → left mouth corner                                  │
   │   291  → right mouth corner                                 │
   │                                                             │
   │        dist(13, 14)          vertical opening               │
   │  MAR = ─────────────────── = ─────────────────             │
   │        dist(61, 291)         horizontal width               │
   │                                                             │
   │  Typical values:                                            │
   │    < 0.05  → mouth closed / resting                        │
   │    0.05–0.2 → speaking / slight movement                   │
   │    > 0.2   → wide open (yawn, exclamation)                 │
   │                                                             │
   │  OSCILLATION DETECTION (talking vs one-time open)           │
   │  ──────────────────────────────────────────────────         │
   │  Sustained speaking is characterised by repeated opening    │
   │  and closing of the mouth, not just one continuous open.   │
   │  We track transitions between open and closed states and   │
   │  count oscillation cycles.  A violation fires only after   │
   │  10 continuous seconds of such oscillation.                 │
   │                                                             │
   │  SMOOTHING                                                  │
   │  ─────────                                                  │
   │  Raw MAR values are averaged over a 5-frame sliding         │
   │  window before thresholding, preventing single noisy        │
   │  frames from affecting state transitions.                   │
   └─────────────────────────────────────────────────────────────┘

   Spec landmark indices
   ─────────────────────
     Upper lip : 13
     Lower lip : 14
     Left corner: 61
     Right corner: 291

   Integration
   ───────────
   Called per-frame by ai/faceDetection.js:
     LipMovement.processFrame(landmarks);

   Also callable directly (spec-required named export):
     processLipMovement(landmarks);
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const LipMovement = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        1.  CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     // ── Spec landmark indices ──────────────────────────────────────
     const LM = {
       UPPER: 13,
       LOWER: 14,
       LEFT:  61,
       RIGHT: 291,
     };
   
     /**
      * MAR above which the mouth is classified as "open".
      * Empirically tuned for a 640×480 front-facing webcam.
      * Increase if false positives occur in production.
      */
     const MAR_OPEN_THRESHOLD = 0.05;
   
     /**
      * MAR below which the mouth is classified as "closed".
      * Slightly lower than OPEN to add hysteresis and prevent
      * rapid state flicker around the threshold boundary.
      */
     const MAR_CLOSE_THRESHOLD = 0.035;
   
     /**
      * Sliding window size for MAR smoothing (frames).
      * At ~30 fps: 5 frames ≈ 166 ms of smoothing.
      */
     const SMOOTH_WINDOW = 5;
   
     /**
      * Continuous seconds of oscillating lip movement before a
      * violation fires.  Spec requirement: 10 seconds.
      */
     const VIOLATION_SECS = 10;
   
     /**
      * Minimum ms between two accepted "Continuous lip movement"
      * violations.  Must be longer than ViolationManager.DEBOUNCE_MS.
      */
     const VIOLATION_COOLDOWN_MS = 12_000;
   
     /**
      * Minimum number of open→close oscillation cycles required within
      * VIOLATION_SECS to confirm talking (not just a sustained open mouth).
      * At typical speech rate (~3 syllables/s) a 10 s window should
      * contain ≥ 8 cycles even for slow speakers.
      */
     const MIN_OSCILLATIONS = 4;
   
     /* ══════════════════════════════════════════════════════════════
        2.  STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Rolling MAR history for smoothing. */
     const _marBuffer = [];
   
     /** Most recent smoothed MAR value. */
     let _smoothedMAR = 0;
   
     /** Current mouth state: "open" | "closed". */
     let _mouthState = "closed";
   
     /**
      * Wall-clock timestamp (ms) when continuous lip movement started.
      * null = not currently in a lip-movement episode.
      */
     let _movementStartTime = null;
   
     /** How many open→closed transitions have occurred in the current episode. */
     let _oscillationCount = 0;
   
     /** Seconds of continuous movement in the current episode. */
     let _movementSeconds = 0;
   
     /** Timestamp of the last accepted violation. */
     let _lastViolationAt = 0;
   
     /** UI label for #mouthStatus. */
     let _statusLabel = "—";
   
     /** Session statistics. */
     const _stats = {
       framesAnalysed: 0,
       peakMAR:        0,
       totalOpenFrames: 0,
       oscillations:   0,
       violations:     0,
       movementSeconds: 0,
     };
   
     /* ══════════════════════════════════════════════════════════════
        3.  PRIVATE UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     function _el(id) { return document.getElementById(id); }
     function _setText(id, val) { const e = _el(id); if (e) e.textContent = val; }
   
     function _setModuleState(state, label) {
       if (typeof window.setModuleState === "function") {
         window.setModuleState("mouth", state, label);
       }
     }
   
     function _register(reason, severity) {
       if (window.ViolationManager?.isTerminated()) return;
       if (typeof window.registerViolation === "function") {
         window.registerViolation(reason, severity);
       }
     }
   
     /**
      * Safe landmark point accessor.
      * @param {Array} lm
      * @param {number} idx
      * @returns {{ x: number, y: number }|null}
      */
     function _pt(lm, idx) {
       const p = lm[idx];
       return (p && typeof p.x === "number") ? { x: p.x, y: p.y } : null;
     }
   
     /** Euclidean distance between two normalised points. */
     function _dist(a, b) {
       return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
     }
   
     /* ══════════════════════════════════════════════════════════════
        4.  MAR COMPUTATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Computes the raw Mouth Aspect Ratio from the four spec landmarks.
      *
      *       dist(upper=13, lower=14)
      * MAR = ─────────────────────────
      *       dist(left=61,  right=291)
      *
      * Returns 0 if any landmark is missing or width is degenerate.
      *
      * @param {Array} lm  MediaPipe landmark array.
      * @returns {number}
      */
     function _computeMAR(lm) {
       const upper = _pt(lm, LM.UPPER);
       const lower = _pt(lm, LM.LOWER);
       const left  = _pt(lm, LM.LEFT);
       const right = _pt(lm, LM.RIGHT);
   
       if (!upper || !lower || !left || !right) return 0;
   
       const vertical   = _dist(upper, lower);
       const horizontal = _dist(left, right);
   
       if (horizontal < 0.001) return 0;
   
       return vertical / horizontal;
     }
   
     /* ══════════════════════════════════════════════════════════════
        5.  SMOOTHING  (sliding average)
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Pushes a raw MAR sample into the rolling window and returns
      * the windowed average.
      *
      * @param {number} rawMAR
      * @returns {number}  Smoothed MAR.
      */
     function _smooth(rawMAR) {
       _marBuffer.push(rawMAR);
       if (_marBuffer.length > SMOOTH_WINDOW) _marBuffer.shift();
   
       const sum = _marBuffer.reduce((a, v) => a + v, 0);
       return sum / _marBuffer.length;
     }
   
     /* ══════════════════════════════════════════════════════════════
        6.  OSCILLATION & VIOLATION LOGIC
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Updates the mouth state machine based on the current smoothed MAR.
      * Uses hysteresis (two thresholds) to prevent rapid flicker.
      *
      * State transitions:
      *   closed → open   when smoothedMAR ≥ MAR_OPEN_THRESHOLD
      *   open   → closed when smoothedMAR <  MAR_CLOSE_THRESHOLD
      *
      * An oscillation (open→closed transition) increments _oscillationCount.
      *
      * @param {number} mar  Smoothed MAR for this frame.
      */
     function _updateState(mar) {
       if (_mouthState === "closed" && mar >= MAR_OPEN_THRESHOLD) {
         _mouthState = "open";
         _stats.totalOpenFrames++;
   
       } else if (_mouthState === "open" && mar < MAR_CLOSE_THRESHOLD) {
         _mouthState = "closed";
         _oscillationCount++;
         _stats.oscillations++;
   
       } else if (_mouthState === "open") {
         _stats.totalOpenFrames++;
       }
     }
   
     /**
      * Manages wall-clock tracking of lip movement episodes and fires
      * violations when the criteria are met.
      *
      * An "episode" starts when the mouth first opens and ends when
      * it has been closed for a while (episode is reset on no-face).
      */
     function _updateEpisodeTimer() {
       const nowMs  = Date.now();
       const isOpen = _mouthState === "open";
   
       if (isOpen || _oscillationCount > 0) {
         // ── Start or extend the episode ───────────────────────────
         if (_movementStartTime === null) {
           _movementStartTime  = nowMs;
           _oscillationCount   = 0;
         }
   
         _movementSeconds = (nowMs - _movementStartTime) / 1000;
         _stats.movementSeconds = _movementSeconds;
   
         // ── Violation check ────────────────────────────────────────
         if (
           _movementSeconds >= VIOLATION_SECS &&
           _oscillationCount >= MIN_OSCILLATIONS &&
           nowMs - _lastViolationAt >= VIOLATION_COOLDOWN_MS
         ) {
           _lastViolationAt = nowMs;
           _stats.violations++;
           _register("Continuous lip movement detected", "MEDIUM");
   
           console.warn(
             `%c[LipMovement] Violation: ${_movementSeconds.toFixed(1)}s of lip movement, ` +
             `${_oscillationCount} cycles (MAR=${_smoothedMAR.toFixed(3)}).`,
             "color:#d29922;font-family:monospace;font-weight:600"
           );
         }
   
         // ── UI ─────────────────────────────────────────────────────
         const secsStr = _movementSeconds.toFixed(1);
         _statusLabel  = `Possible talking (${secsStr}s)`;
         _setText("mouthStatus", _statusLabel);
         _setModuleState("warn", "Speaking");
   
       } else {
         // ── No active episode ──────────────────────────────────────
         _movementStartTime = null;
         _oscillationCount  = 0;
         _movementSeconds   = 0;
         _statusLabel       = "Normal";
         _setText("mouthStatus", "Normal");
         _setModuleState("active", "Silent");
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        7.  PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * processFrame(landmarks)
      * ────────────────────────
      * Main entry point called by faceDetection.js every frame.
      *
      * @param {Array|null} landmarks  MediaPipe 468/478-point landmark array,
      *                                or null when no face is detected.
      */
     function processFrame(landmarks) {
       _stats.framesAnalysed++;
   
       // ── No face — reset episode ────────────────────────────────
       if (!landmarks || landmarks.length < 292) {
         _marBuffer.length  = 0;
         _smoothedMAR       = 0;
         _mouthState        = "closed";
         _movementStartTime = null;
         _oscillationCount  = 0;
         _movementSeconds   = 0;
         _statusLabel       = "—";
         _setText("mouthStatus", "—");
         _setModuleState("warn", "No Face");
         return;
       }
   
       // ── Compute + smooth MAR ───────────────────────────────────
       const rawMAR   = _computeMAR(landmarks);
       _smoothedMAR   = _smooth(rawMAR);
   
       if (_smoothedMAR > _stats.peakMAR) _stats.peakMAR = _smoothedMAR;
   
       // ── Debug log every ~1 s (30 frames) ──────────────────────
       if (_stats.framesAnalysed % 30 === 0) {
         console.log(
           `[LipMovement] Mouth Aspect Ratio: ${_smoothedMAR.toFixed(4)} ` +
           `(raw: ${rawMAR.toFixed(4)}, state: ${_mouthState}, ` +
           `oscillations: ${_oscillationCount})`
         );
       }
   
       // ── State machine ──────────────────────────────────────────
       _updateState(_smoothedMAR);
   
       // ── Episode timer + violation ──────────────────────────────
       _updateEpisodeTimer();
     }
   
     /**
      * getStats()
      * Returns a diagnostic snapshot of session data.
      */
     function getStats() {
       return {
         smoothedMAR:      _smoothedMAR,
         mouthState:       _mouthState,
         movementSeconds:  _movementSeconds,
         oscillationCount: _oscillationCount,
         statusLabel:      _statusLabel,
         framesAnalysed:   _stats.framesAnalysed,
         totalOpenFrames:  _stats.totalOpenFrames,
         peakMAR:          _stats.peakMAR,
         oscillations:     _stats.oscillations,
         violations:       _stats.violations,
         thresholds: {
           open:        MAR_OPEN_THRESHOLD,
           close:       MAR_CLOSE_THRESHOLD,
           violationAt: VIOLATION_SECS,
           minCycles:   MIN_OSCILLATIONS,
         },
       };
     }
   
     return { processFrame, getStats, LM, MAR_OPEN_THRESHOLD };
   
   })(); // end LipMovement IIFE
   
   
   /* ══════════════════════════════════════════════════════════════
      NAMED EXPORT  (spec requirement)
      ══════════════════════════════════════════════════════════════ */
   
   /**
    * processLipMovement(landmarks)
    * ──────────────────────────────
    * Spec-required named function export.
    * Delegates to LipMovement.processFrame().
    *
    * @param {Array|null} landmarks
    */
   function processLipMovement(landmarks) {
     LipMovement.processFrame(landmarks);
   }
   
   /* ── Global aliases ──────────────────────────────────────────── */
   window.LipMovement        = LipMovement;
   window.processLipMovement = processLipMovement;
   
   console.log(
     "%c[LipMovement] Module loaded — " +
     `violation after ${10}s of lip movement | MAR threshold: ${0.05} | ` +
     `smoothing: ${5}-frame window`,
     "color:#8b949e;font-family:monospace"
   );