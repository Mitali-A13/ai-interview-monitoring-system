

   "use strict";

   const LipMovement = (function () {
   
     
     const LM = {
       UPPER: 13,
       LOWER: 14,
       LEFT:  61,
       RIGHT: 291,
     };
   
     
     const MAR_OPEN_THRESHOLD = 0.05;
   
     
     const MAR_CLOSE_THRESHOLD = 0.035;
   
     
     const SMOOTH_WINDOW = 5;
   
     
     const VIOLATION_SECS = 10;
   
     
     const VIOLATION_COOLDOWN_MS = 12_000;
   
     
     const MIN_OSCILLATIONS = 4;
   
     
     const MIN_AMPLITUDE = 0.02;
   
     
     const ON_SCREEN_LABEL = "Looking at screen";
   
     
   
     /** Rolling MAR history for smoothing. */
     const _marBuffer = [];
   
     /** Most recent smoothed MAR value. */
     let _smoothedMAR = 0;
   
     
     let _prevSmoothedMAR = 0;
   
     
     let _lastAmplitude = 0;
   
     /** Current mouth state: "open" | "closed". */
     let _mouthState = "closed";
   
     
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
   
     
     function _smooth(rawMAR) {
       _marBuffer.push(rawMAR);
       if (_marBuffer.length > SMOOTH_WINDOW) _marBuffer.shift();
   
       const sum = _marBuffer.reduce((a, v) => a + v, 0);
       return sum / _marBuffer.length;
     }
   
     
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