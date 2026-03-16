/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   ai/lipMovement.js — Lip / Mouth Movement Detector

   How it works
   ────────────
   We measure the Mouth Aspect Ratio (MAR) — the ratio of the
   vertical mouth opening to its horizontal width.  When MAR
   exceeds a threshold for enough consecutive frames the candidate
   is considered to be speaking.

   Landmark indices (inner lip contour)
   ──────────────────────────────────────
   Top centre:    13
   Bottom centre: 14
   Left corner:   61
   Right corner:  291

   Mouth Aspect Ratio
   ──────────────────
            vertical distance (13 → 14)
   MAR  =  ──────────────────────────────
            horizontal distance (61 → 291)

   MAR thresholds (empirically determined at 640×480):
   < 0.05  → mouth closed (normal during typing/thinking)
   ≥ 0.05  → mouth open   (potentially speaking)

   A sustained-speech violation fires only after the mouth has been
   open for SPEAKING_FRAME_THRESHOLD consecutive frames, preventing
   yawns, coughs, or single words from triggering an alert.

   Integration
   ───────────
   LipMovement.processFrame(landmarks) is called by faceDetection.js
   on every frame.  Null landmarks = no face detected.
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const LipMovement = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Mouth Aspect Ratio above which the mouth is considered "open".
      * Tune this value if the environment has a different camera angle.
      */
     const MAR_THRESHOLD = 0.05;
   
     /**
      * Number of consecutive open-mouth frames before a speaking
      * violation is triggered.  At ~30 fps: 90 frames ≈ 3 seconds.
      * This prevents brief sounds (cough, yawn) from firing violations.
      */
     const SPEAKING_FRAME_THRESHOLD = 90;
   
     /**
      * After a speaking violation fires, how many milliseconds must
      * pass before the next one can fire.
      */
     const SPEAKING_COOLDOWN_MS = 10_000;
   
     /** Landmark indices for the inner lip boundary. */
     const LM = {
       TOP:    13,
       BOTTOM: 14,
       LEFT:   61,
       RIGHT:  291,
     };
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Consecutive frames where MAR exceeded the threshold. */
     let _openFrames = 0;
   
     /** Timestamp of the last accepted speaking violation. */
     let _lastViolationAt = 0;
   
     /** Current status label for the UI. */
     let _statusLabel = "—";
   
     /** Most recent MAR value (for debugging / getStats). */
     let _currentMAR = 0;
   
     /** Session statistics. */
     const _stats = {
       framesAnalysed: 0,
       framesOpen:     0,
       violations:     0,
       maxMAR:         0,
     };
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     function _setText(id, val) {
       const el = document.getElementById(id);
       if (el) el.textContent = val;
     }
   
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
      * Euclidean distance between two normalised landmark points.
      * @param {{ x: number, y: number }} a
      * @param {{ x: number, y: number }} b
      * @returns {number}
      */
     function _dist(a, b) {
       const dx = a.x - b.x;
       const dy = a.y - b.y;
       return Math.sqrt(dx * dx + dy * dy);
     }
   
     /**
      * Computes the Mouth Aspect Ratio from the four key landmarks.
      * Returns 0 if any landmark is missing or degenerate.
      * @param {Array} landmarks
      * @returns {number}
      */
     function _computeMAR(landmarks) {
       const top    = landmarks[LM.TOP];
       const bottom = landmarks[LM.BOTTOM];
       const left   = landmarks[LM.LEFT];
       const right  = landmarks[LM.RIGHT];
   
       if (!top || !bottom || !left || !right) return 0;
   
       const vertical   = _dist(top, bottom);
       const horizontal = _dist(left, right);
   
       if (horizontal < 0.001) return 0; // degenerate
   
       return vertical / horizontal;
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Analyse one frame's landmarks for lip movement.
      * Called by faceDetection.js for every processed frame.
      *
      * @param {Array|null} landmarks  MediaPipe 468/478-point array,
      *                                or null when no face is detected.
      */
     function processFrame(landmarks) {
       _stats.framesAnalysed++;
   
       // ── No face ─────────────────────────────────────────────────
       if (!landmarks || landmarks.length < 14) {
         _openFrames  = 0;
         _currentMAR  = 0;
         _statusLabel = "—";
         _setText("mouthStatus", "—");
         _setModuleState("warn", "No Face");
         return;
       }
   
       // ── Compute MAR ─────────────────────────────────────────────
       const mar = _computeMAR(landmarks);
       _currentMAR = mar;
       if (mar > _stats.maxMAR) _stats.maxMAR = mar;
   
       const isOpen = mar >= MAR_THRESHOLD;
   
       if (isOpen) {
         _openFrames++;
         _stats.framesOpen++;
         _statusLabel = "Speaking";
         _setText("mouthStatus", "Speaking");
         _setModuleState("warn", "Speaking");
   
         // ── Sustained speaking → violation ───────────────────────
         if (_openFrames >= SPEAKING_FRAME_THRESHOLD) {
           const now = Date.now();
           if (now - _lastViolationAt >= SPEAKING_COOLDOWN_MS) {
             _lastViolationAt = now;
             _stats.violations++;
             _register("Lip movement detected — possible communication", "MEDIUM");
             console.warn(
               `[LipMovement] Violation: speaking detected for ` +
               `${_openFrames} frames (MAR=${mar.toFixed(3)}).`
             );
           }
         }
       } else {
         // Mouth closed — reset
         _openFrames  = 0;
         _statusLabel = "Silent";
         _setText("mouthStatus", "Silent");
         _setModuleState("active", "Silent");
       }
     }
   
     /**
      * Returns current detection state and session statistics.
      */
     function getStats() {
       return {
         currentMAR:     _currentMAR,
         openFrames:     _openFrames,
         status:         _statusLabel,
         framesAnalysed: _stats.framesAnalysed,
         framesOpen:     _stats.framesOpen,
         violations:     _stats.violations,
         maxMAR:         _stats.maxMAR,
         marThreshold:   MAR_THRESHOLD,
       };
     }
   
     return { processFrame, getStats, MAR_THRESHOLD, LM };
   
   })();
   
   /* ── Global alias ────────────────────────────────────────────── */
   window.LipMovement = LipMovement;
   
   console.log(
     "%c[LipMovement] Module loaded — awaiting landmarks from FaceDetection.",
     "color:#8b949e;font-family:monospace"
   );