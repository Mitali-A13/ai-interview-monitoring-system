/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   ai/eyeTracking.js — Gaze Direction & Look-Away Detector

   How it works
   ────────────
   MediaPipe FaceMesh with refineLandmarks:true exposes 10 iris
   landmarks (5 per eye, indices 468–477).  The iris centre relative
   to the eye corner bounding box tells us where the candidate is
   looking.

   Landmark groups used
   ─────────────────────
   Left eye corners  : 33 (left-most) and 133 (right-most)
   Left iris centre  : 468
   Right eye corners : 362 (right-most) and 263 (left-most)
   Right iris centre : 473

   Gaze ratio
   ──────────
   ratio = (irisX - leftCornerX) / (rightCornerX - leftCornerX)

   ratio ≈ 0.5  → looking straight ahead (normal)
   ratio < 0.35 → looking left
   ratio > 0.65 → looking right

   Vertical gaze is also checked:
   left eye top: 159, bottom: 145 → vertical ratio using iris Y.

   A violation fires only after the candidate has been looking away
   for AWAY_FRAME_THRESHOLD consecutive frames, preventing
   momentary glances from being flagged.

   Integration
   ───────────
   EyeTracking.processFrame(landmarks) is called by faceDetection.js
   on every analysed frame.  Null landmarks mean no face was detected.
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const EyeTracking = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Gaze ratio thresholds.
      * Values outside [LEFT_LIMIT, RIGHT_LIMIT] are "looking away".
      * Values outside [TOP_LIMIT, BOTTOM_LIMIT] are "looking up/down".
      */
     const GAZE = {
       LEFT_LIMIT:   0.35,
       RIGHT_LIMIT:  0.65,
       TOP_LIMIT:    0.35,
       BOTTOM_LIMIT: 0.70,
     };
   
     /**
      * How many consecutive frames the gaze must be "away" before a
      * violation fires.  At ~30 fps this is roughly 1.5 seconds —
      * enough time to distinguish a genuine glance from a momentary
      * eye movement.
      */
     const AWAY_FRAME_THRESHOLD = 45;
   
     /**
      * Minimum milliseconds between two "looking away" violations.
      * Longer than ViolationManager.DEBOUNCE_MS (3 000 ms).
      */
     const LOOK_AWAY_COOLDOWN_MS = 7_000;
   
     /* ── Iris & eye landmark indices ─────────────────────────────── */
     const LM = {
       // Left eye
       LEFT_CORNER_INNER:  133,
       LEFT_CORNER_OUTER:   33,
       LEFT_EYE_TOP:       159,
       LEFT_EYE_BOTTOM:    145,
       LEFT_IRIS:          468,  // requires refineLandmarks: true
   
       // Right eye
       RIGHT_CORNER_INNER: 362,
       RIGHT_CORNER_OUTER: 263,
       RIGHT_EYE_TOP:      386,
       RIGHT_EYE_BOTTOM:   374,
       RIGHT_IRIS:         473,  // requires refineLandmarks: true
     };
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Consecutive frames where gaze was considered "away". */
     let _awayFrames = 0;
   
     /** Timestamp of the last accepted "looking away" violation. */
     let _lastViolationAt = 0;
   
     /** Current gaze direction label for UI display. */
     let _gazeLabel = "—";
   
     /** Session statistics. */
     const _stats = {
       framesAnalysed: 0,
       lookingAway:    0,
       violations:     0,
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
      * Safely reads a landmark's x/y from the flat array.
      * MediaPipe normalises coordinates to [0, 1].
      * @param {Array} landmarks
      * @param {number} idx
      * @returns {{ x: number, y: number }|null}
      */
     function _lm(landmarks, idx) {
       const pt = landmarks[idx];
       return pt ? { x: pt.x, y: pt.y } : null;
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — GAZE ANALYSIS
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Computes horizontal gaze ratio for one eye.
      * ratio < 0 or > 1 means landmarks are degenerate — treated as "straight".
      *
      * @param {Array}  landmarks
      * @param {number} outerIdx  Outer corner landmark index.
      * @param {number} innerIdx  Inner corner landmark index.
      * @param {number} irisIdx   Iris centre landmark index.
      * @returns {number}  0 = fully left, 0.5 = centre, 1 = fully right.
      */
     function _horizontalRatio(landmarks, outerIdx, innerIdx, irisIdx) {
       const outer = _lm(landmarks, outerIdx);
       const inner = _lm(landmarks, innerIdx);
       const iris  = _lm(landmarks, irisIdx);
       if (!outer || !inner || !iris) return 0.5;
   
       const width = Math.abs(inner.x - outer.x);
       if (width < 0.001) return 0.5; // degenerate / face turned too far
   
       const leftX = Math.min(outer.x, inner.x);
       return (iris.x - leftX) / width;
     }
   
     /**
      * Computes vertical gaze ratio for one eye.
      * @param {Array}  landmarks
      * @param {number} topIdx
      * @param {number} bottomIdx
      * @param {number} irisIdx
      * @returns {number}  0 = fully up, 0.5 = centre, 1 = fully down.
      */
     function _verticalRatio(landmarks, topIdx, bottomIdx, irisIdx) {
       const top    = _lm(landmarks, topIdx);
       const bottom = _lm(landmarks, bottomIdx);
       const iris   = _lm(landmarks, irisIdx);
       if (!top || !bottom || !iris) return 0.5;
   
       const height = Math.abs(bottom.y - top.y);
       if (height < 0.001) return 0.5;
   
       return (iris.y - top.y) / height;
     }
   
     /**
      * Averages the left and right eye gaze ratios and classifies direction.
      * @param {Array} landmarks
      * @returns {{ hRatio: number, vRatio: number, direction: string, isAway: boolean }}
      */
     function _classifyGaze(landmarks) {
       const hLeft  = _horizontalRatio(landmarks, LM.LEFT_CORNER_OUTER,  LM.LEFT_CORNER_INNER,  LM.LEFT_IRIS);
       const hRight = _horizontalRatio(landmarks, LM.RIGHT_CORNER_INNER, LM.RIGHT_CORNER_OUTER, LM.RIGHT_IRIS);
       const hRatio = (hLeft + hRight) / 2;
   
       const vLeft  = _verticalRatio(landmarks, LM.LEFT_EYE_TOP,  LM.LEFT_EYE_BOTTOM,  LM.LEFT_IRIS);
       const vRight = _verticalRatio(landmarks, LM.RIGHT_EYE_TOP, LM.RIGHT_EYE_BOTTOM, LM.RIGHT_IRIS);
       const vRatio = (vLeft + vRight) / 2;
   
       let direction = "Center";
       let isAway    = false;
   
       if (hRatio < GAZE.LEFT_LIMIT) {
         direction = "Looking Left";
         isAway    = true;
       } else if (hRatio > GAZE.RIGHT_LIMIT) {
         direction = "Looking Right";
         isAway    = true;
       } else if (vRatio < GAZE.TOP_LIMIT) {
         direction = "Looking Up";
         isAway    = true;
       } else if (vRatio > GAZE.BOTTOM_LIMIT) {
         direction = "Looking Down";
         isAway    = true;
       }
   
       return { hRatio, vRatio, direction, isAway };
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Called by faceDetection.js for every frame.
      *
      * @param {Array|null} landmarks  468/478-point landmark array, or null
      *                                when no face is present.
      */
     function processFrame(landmarks) {
       _stats.framesAnalysed++;
   
       // ── No face — reset gaze state ─────────────────────────────
       if (!landmarks || landmarks.length < 478) {
         _awayFrames = 0;
         _gazeLabel  = "—";
         _setText("eyeStatus", "—");
         _setModuleState("warn", "No Face");
         return;
       }
   
       // ── Classify gaze ──────────────────────────────────────────
       const { direction, isAway } = _classifyGaze(landmarks);
       _gazeLabel = direction;
       _setText("eyeStatus", direction);
   
       if (isAway) {
         _awayFrames++;
         _stats.lookingAway++;
         _setModuleState("warn", direction);
   
         // Fire violation after sustained look-away
         if (_awayFrames >= AWAY_FRAME_THRESHOLD) {
           const now = Date.now();
           if (now - _lastViolationAt >= LOOK_AWAY_COOLDOWN_MS) {
             _lastViolationAt = now;
             _stats.violations++;
             _register("Looking away from screen", "MEDIUM");
             console.warn(`[EyeTracking] Violation: ${direction} (${_awayFrames} frames).`);
           }
         }
       } else {
         // Reset counter — candidate looked back
         _awayFrames = 0;
         _setModuleState("active", "On Screen");
       }
     }
   
     /**
      * Returns current gaze label and session stats.
      */
     function getStats() {
       return {
         currentGaze:    _gazeLabel,
         awayFrames:     _awayFrames,
         framesAnalysed: _stats.framesAnalysed,
         lookingAway:    _stats.lookingAway,
         violations:     _stats.violations,
       };
     }
   
     return { processFrame, getStats, GAZE, LM };
   
   })();
   
   /* ── Global alias ────────────────────────────────────────────── */
   window.EyeTracking = EyeTracking;
   
   console.log(
     "%c[EyeTracking] Module loaded — awaiting landmarks from FaceDetection.",
     "color:#8b949e;font-family:monospace"
   );