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
   
     /**
      * AMPLITUDE FILTER
      * ─────────────────
      * Minimum MAR change between the previous and current smoothed
      * value required for a closed→open transition to count as a
      * real oscillation.
      *
      * Why this matters
      * ────────────────
      * When a candidate silently reads or thinks, small involuntary
      * muscle contractions can move the lips a tiny amount (MAR change
      * ≈ 0.005–0.015).  Those micro-twitches do cross the open/close
      * threshold often enough to accumulate oscillation counts, leading
      * to false positives.  Requiring amplitude ≥ 0.02 means only
      * deliberate, visible mouth movements register as oscillations,
      * which is the correct behaviour for detecting speech.
      */
     const MIN_AMPLITUDE = 0.02;
   
     /**
      * GAZE CORRELATION — "on-screen" label produced by eyeTracking.js
      * ─────────────────────────────────────────────────────────────────
      * The string written into #eyeStatus when the candidate is
      * confirmed to be looking at the screen.  Matches the value set
      * by EyeTracking._updateAwayTimer() when isAway === false.
      *
      * Why gaze correlation reduces false positives
      * ─────────────────────────────────────────────
      * Silent reading produces steady lip movements that score high on
      * the MAR oscillation metric alone.  However, a candidate who is
      * silently reading is by definition looking AT the screen.  Speech
      * directed at a third party (the attack case we want to catch)
      * almost always comes with the candidate looking AWAY from the
      * screen — toward the off-screen person.  By gating the violation
      * on gazeDirection !== ON_SCREEN_LABEL we eliminate the entire
      * silent-reading false-positive class while preserving true
      * positives (talking to someone off-screen).
      */
     const ON_SCREEN_LABEL = "Looking at screen";
   
     /* ══════════════════════════════════════════════════════════════
        2.  STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Rolling MAR history for smoothing. */
     const _marBuffer = [];
   
     /** Most recent smoothed MAR value. */
     let _smoothedMAR = 0;
   
     /**
      * Smoothed MAR from the previous frame.
      * Used to compute frame-to-frame amplitude for the oscillation filter.
      */
     let _prevSmoothedMAR = 0;
   
     /**
      * Absolute MAR change between the last two frames.
      * Exposed via getStats() and used in the violation gate.
      */
     let _lastAmplitude = 0;
   
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
   
     /**
      * _getGazeDirection()
      * ────────────────────
      * Reads the current gaze label produced by ai/eyeTracking.js.
      *
      * Primary source: EyeTracking.getStats().smoothedDirection
      * Reads from the module object directly, which is the most
      * reliable path because it bypasses any lag in DOM rendering.
      *
      * Fallback: text content of #eyeStatus (DOM element)
      * Used when EyeTracking is not yet initialised or the getter
      * is unavailable, ensuring robustness across load-order
      * variations.
      *
      * Returns the ON_SCREEN_LABEL constant ("Looking at screen") as
      * a safe default when the gaze state is completely unknown — this
      * makes the module conservative (does NOT fire false violations
      * simply because gaze data is missing).
      *
      * @returns {string}  The current smoothed gaze direction string.
      */
     function _getGazeDirection() {
       // Preferred: read live value from EyeTracking module object
       if (
         typeof window.EyeTracking === "object" &&
         typeof window.EyeTracking.getStats === "function"
       ) {
         const stats = window.EyeTracking.getStats();
         if (stats && typeof stats.smoothedDirection === "string") {
           return stats.smoothedDirection;
         }
       }
   
       // Fallback: read from #eyeStatus DOM element
       const el = _el("eyeStatus");
       if (el && el.textContent) {
         const txt = el.textContent.trim();
         if (txt && txt !== "—") return txt;
       }
   
       // Safe default — do not fire on unknown gaze
       return ON_SCREEN_LABEL;
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
      * AMPLITUDE FILTER
      * ────────────────
      * An open→closed transition (oscillation) is only counted when
      * the frame-to-frame amplitude change (_lastAmplitude) meets the
      * MIN_AMPLITUDE threshold.  This discards micro-twitches caused
      * by silent reading or involuntary muscle contractions, which
      * produce small but frequent MAR changes that would otherwise
      * accumulate into false oscillation counts.
      *
      * @param {number} mar  Smoothed MAR for this frame.
      */
     function _updateState(mar) {
       if (_mouthState === "closed" && mar >= MAR_OPEN_THRESHOLD) {
         _mouthState = "open";
         _stats.totalOpenFrames++;
   
       } else if (_mouthState === "open" && mar < MAR_CLOSE_THRESHOLD) {
         _mouthState = "closed";
   
         // Only register oscillation if movement was large enough to be real
         if (_lastAmplitude >= MIN_AMPLITUDE) {
           _oscillationCount++;
           _stats.oscillations++;
         } else {
           // Amplitude too small — discard this cycle as a micro-twitch
           console.debug(
             `[LipMovement] Oscillation discarded — amplitude ${_lastAmplitude.toFixed(4)} ` +
             `< MIN_AMPLITUDE ${MIN_AMPLITUDE} (micro-twitch filter).`
           );
         }
   
       } else if (_mouthState === "open") {
         _stats.totalOpenFrames++;
       }
     }
   
     /**
      * Manages wall-clock tracking of lip movement episodes and fires
      * violations when ALL four conditions are met simultaneously:
      *
      *   1. movementSeconds ≥ VIOLATION_SECS  (10 s continuous movement)
      *   2. oscillationCount ≥ MIN_OSCILLATIONS  (≥ 4 real mouth cycles)
      *   3. _lastAmplitude ≥ MIN_AMPLITUDE  (current frame is a real movement)
      *   4. gazeDirection ≠ ON_SCREEN_LABEL  (candidate is NOT looking at screen)
      *
      * GAZE CORRELATION RATIONALE
      * ───────────────────────────
      * Condition 4 is the key false-positive suppressor.  A candidate
      * who is silently reading problem text will have active lip movements
      * (conditions 1–3 can be met) but their gaze will be fixed on the
      * screen.  By requiring the candidate to be looking AWAY we ensure
      * we only flag speech directed at an off-screen third party, which
      * is the actual proctoring concern.
      */
     function _updateEpisodeTimer() {
       const nowMs        = Date.now();
       const isOpen       = _mouthState === "open";
       const gazeDir      = _getGazeDirection();
       const gazeIsAway   = gazeDir !== ON_SCREEN_LABEL && gazeDir !== "—";
   
       if (isOpen || _oscillationCount > 0) {
         // ── Start or extend the episode ───────────────────────────
         if (_movementStartTime === null) {
           _movementStartTime = nowMs;
           _oscillationCount  = 0;
         }
   
         _movementSeconds       = (nowMs - _movementStartTime) / 1000;
         _stats.movementSeconds = _movementSeconds;
   
         // ── Violation check (all four conditions) ─────────────────
         if (
           _movementSeconds >= VIOLATION_SECS            &&  // 1. duration
           _oscillationCount >= MIN_OSCILLATIONS          &&  // 2. oscillations
           _lastAmplitude >= MIN_AMPLITUDE                &&  // 3. amplitude
           gazeIsAway                                     &&  // 4. gaze correlation
           nowMs - _lastViolationAt >= VIOLATION_COOLDOWN_MS
         ) {
           _lastViolationAt = nowMs;
           _stats.violations++;
           _register("Possible speaking detected", "MEDIUM");
   
           console.warn(
             `%c[LipMovement] Violation — ` +
             `MAR: ${_smoothedMAR.toFixed(3)} | ` +
             `Oscillations: ${_oscillationCount} | ` +
             `Movement duration: ${_movementSeconds.toFixed(1)}s | ` +
             `Gaze: ${gazeDir}`,
             "color:#d29922;font-family:monospace;font-weight:600"
           );
         }
   
         // ── UI ─────────────────────────────────────────────────────
         const secsStr = _movementSeconds.toFixed(1);
         _statusLabel  = gazeIsAway
           ? `Possible talking (${secsStr}s)`
           : `Lip movement (reading?)`;
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
         _prevSmoothedMAR   = 0;
         _lastAmplitude     = 0;
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
   
       // Save previous smoothed value before updating — used for amplitude
       _prevSmoothedMAR = _smoothedMAR;
       _smoothedMAR     = _smooth(rawMAR);
   
       // ── Amplitude: frame-to-frame MAR change ──────────────────
       //
       // amplitude = |currentMAR - previousMAR|
       //
       // This captures how much the mouth actually moved between frames.
       // Used by _updateState() to discard tiny micro-twitches that
       // cross the open/close threshold but do not represent real speech.
       _lastAmplitude = Math.abs(_smoothedMAR - _prevSmoothedMAR);
   
       if (_smoothedMAR > _stats.peakMAR) _stats.peakMAR = _smoothedMAR;
   
       // ── Debug log every ~1 s (30 frames) ──────────────────────
       if (_stats.framesAnalysed % 30 === 0) {
         const gazeDir = _getGazeDirection();
         console.log(
           `[LipMovement] MAR: ${_smoothedMAR.toFixed(3)} | ` +
           `Oscillations: ${_oscillationCount} | ` +
           `Movement duration: ${_movementSeconds.toFixed(1)}s | ` +
           `Gaze: ${gazeDir}`
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
         lastAmplitude:    _lastAmplitude,
         mouthState:       _mouthState,
         movementSeconds:  _movementSeconds,
         oscillationCount: _oscillationCount,
         statusLabel:      _statusLabel,
         gazeDirection:    _getGazeDirection(),
         framesAnalysed:   _stats.framesAnalysed,
         totalOpenFrames:  _stats.totalOpenFrames,
         peakMAR:          _stats.peakMAR,
         oscillations:     _stats.oscillations,
         violations:       _stats.violations,
         thresholds: {
           open:            MAR_OPEN_THRESHOLD,
           close:           MAR_CLOSE_THRESHOLD,
           minAmplitude:    MIN_AMPLITUDE,
           violationAt:     VIOLATION_SECS,
           minCycles:       MIN_OSCILLATIONS,
           onScreenLabel:   ON_SCREEN_LABEL,
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