/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   ai/faceDetection.js — MediaPipe FaceMesh Pipeline

   Responsibilities
   ────────────────
   1. Load MediaPipe FaceMesh from CDN and configure it.
   2. Open a requestAnimationFrame loop that feeds each video frame
      to FaceMesh for landmark extraction.
   3. On each result:
        • Update "Faces Detected" counter in the UI.
        • Trigger violations for 0 faces (absent) or 2+ faces (cheating).
        • Forward landmarks to eyeTracking.js and lipMovement.js.
   4. Expose startFaceDetection() for script.js to call after the
      webcam stream is live.

   MediaPipe CDN
   ─────────────
   The FaceMesh solution and its dependencies are loaded via the
   official CDN at https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh.
   They must be present in <script> tags BEFORE this file executes —
   see index.html for the exact load order.

   Landmark indices (subset used here)
   ─────────────────────────────────────
   Full map: https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
   • Left eye:   [33, 133, 160, 144, 158, 153]
   • Right eye:  [362, 263, 385, 380, 387, 373]
   • Iris (left):  [468, 469, 470, 471, 472]   (refineLandmarks: true)
   • Iris (right): [473, 474, 475, 476, 477]
   • Lips inner:   [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308]
   • Lips outer:   [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const FaceDetection = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     const FACEMESH_CONFIG = {
       maxNumFaces:          2,
       refineLandmarks:      true,   // enables iris landmarks 468-477
       minDetectionConfidence: 0.5,
       minTrackingConfidence:  0.5,
     };
   
     /**
      * FaceMesh CDN base path.
      * The <script> tags in index.html load the solution from this same URL.
      */
     const FACEMESH_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh";
   
     /**
      * How many consecutive frames with 0 faces must pass before a
      * "face absent" violation fires.  At ~30fps this ≈ 1 second,
      * preventing single-frame dropout false positives.
      */
     const ABSENT_FRAME_THRESHOLD = 30;
   
     /**
      * Cooldown (ms) between "Multiple faces" violations.
      * ViolationManager has its own 3 000 ms debounce; this is a
      * module-level gate set deliberately longer.
      */
     const MULTI_FACE_COOLDOWN_MS = 6_000;
   
     /**
      * Cooldown (ms) between "face absent" violations.
      */
     const ABSENT_COOLDOWN_MS = 8_000;
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** MediaPipe FaceMesh instance. */
     let _faceMesh = null;
   
     /** requestAnimationFrame handle — kept so we can cancel if needed. */
     let _rafId = null;
   
     /** Whether the pipeline is currently running. */
     let _running = false;
   
     /** Consecutive frames where no face was detected. */
     let _absentFrames = 0;
   
     /** Timestamps for per-violation-type cooldowns. */
     let _lastMultiFaceAt = 0;
     let _lastAbsentAt    = 0;
   
     /** Most recent landmark result forwarded to downstream modules. */
     let _lastResult = null;
   
     /** Session stats. */
     const _stats = {
       framesProcessed: 0,
       detections:      { zero: 0, one: 0, multiple: 0 },
       violations:      { absent: 0, multiple: 0 },
     };
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UI HELPERS
        ══════════════════════════════════════════════════════════════ */
   
     function _setText(id, val) {
       const el = document.getElementById(id);
       if (el) el.textContent = val;
     }
   
     function _setModuleState(key, state, label) {
       if (typeof window.setModuleState === "function") {
         window.setModuleState(key, state, label);
       }
     }
   
     function _register(reason, severity) {
       if (window.ViolationManager?.isTerminated()) return;
       if (typeof window.registerViolation === "function") {
         window.registerViolation(reason, severity);
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — RESULT HANDLER
        Called by FaceMesh on every processed frame.
        ══════════════════════════════════════════════════════════════ */
   
     function _onResults(results) {
       _stats.framesProcessed++;
       _lastResult = results;
   
       const faces = results.multiFaceLandmarks ?? [];
       const count = faces.length;
   
       // ── 1. Update "Faces Detected" counter ───────────────────────
       _setText("faceCount", count);
   
       // ── 2. Branch on face count ───────────────────────────────────
       if (count === 0) {
         _handleNoFace();
       } else if (count === 1) {
         _handleOneFace(faces[0]);
       } else {
         _handleMultipleFaces(count);
         // Still forward first face's landmarks for eye/lip analysis
         _handleOneFace(faces[0]);
       }
     }
   
     /** No face visible in frame. */
     function _handleNoFace() {
       _stats.detections.zero++;
       _absentFrames++;
   
       _setModuleState("face", "warn", "No Face");
       _setText("eyeStatus",   "—");
       _setText("mouthStatus", "—");
   
       // Notify downstream modules with empty landmarks
       if (typeof EyeTracking?.processFrame === "function") {
         EyeTracking.processFrame(null);
       }
       if (typeof LipMovement?.processFrame === "function") {
         LipMovement.processFrame(null);
       }
   
       // Fire violation only after sustained absence
       if (_absentFrames >= ABSENT_FRAME_THRESHOLD) {
         const now = Date.now();
         if (now - _lastAbsentAt >= ABSENT_COOLDOWN_MS) {
           _lastAbsentAt = now;
           _stats.violations.absent++;
           _register("Face not visible in frame", "MEDIUM");
           console.warn("[FaceDetection] Violation: face absent.");
         }
       }
     }
   
     /** Exactly one face — the normal expected state. */
     function _handleOneFace(landmarks) {
       _stats.detections.one++;
       _absentFrames = 0; // reset consecutive-absent counter
   
       _setModuleState("face", "active", "1 Face");
   
       // Forward landmarks to specialist modules
       if (typeof EyeTracking?.processFrame === "function") {
         EyeTracking.processFrame(landmarks);
       }
       if (typeof LipMovement?.processFrame === "function") {
         LipMovement.processFrame(landmarks);
       }
     }
   
     /** Two or more faces detected — potential collusion. */
     function _handleMultipleFaces(count) {
       _stats.detections.multiple++;
       _absentFrames = 0;
   
       _setModuleState("face", "error", `${count} Faces`);
       _setText("faceCount", count);
   
       const now = Date.now();
       if (now - _lastMultiFaceAt >= MULTI_FACE_COOLDOWN_MS) {
         _lastMultiFaceAt = now;
         _stats.violations.multiple++;
         _register("Multiple faces detected", "HIGH");
         console.warn(`[FaceDetection] Violation: ${count} faces in frame.`);
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — ANIMATION FRAME LOOP
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Sends one video frame to FaceMesh and schedules the next iteration.
      * Uses requestAnimationFrame so processing is tied to display refresh
      * (typically 30–60 fps) rather than a fixed interval.
      */
     async function _loop() {
       if (!_running) return;
   
       const videoEl = document.getElementById("video");
   
       // Only send frames when video is actually playing
       if (videoEl && videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
         try {
           await _faceMesh.send({ image: videoEl });
         } catch (err) {
           console.error("[FaceDetection] FaceMesh.send error:", err);
         }
       }
   
       _rafId = requestAnimationFrame(_loop);
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Initialises FaceMesh and starts the frame-analysis loop.
      * Must be called AFTER the webcam stream is live (i.e. inside the
      * startCamera() success branch or a DOMContentLoaded callback that
      * waits for the video to be playing).
      *
      * @returns {Promise<void>}
      */
     async function start() {
       if (_running) {
         console.warn("[FaceDetection] Already running — start() ignored.");
         return;
       }
   
       if (typeof window.FaceMesh === "undefined") {
         console.error(
           "[FaceDetection] MediaPipe FaceMesh not found on window. " +
           "Ensure the CDN <script> tags are loaded in index.html."
         );
         _setModuleState("face", "error", "Load Error");
         return;
       }
   
       console.log("[FaceDetection] Initialising FaceMesh…");
       _setModuleState("face", "warn", "Loading…");
   
       // ── Instantiate FaceMesh ──────────────────────────────────────
       _faceMesh = new window.FaceMesh({
         locateFile: (file) => `${FACEMESH_CDN}/${file}`,
       });
   
       _faceMesh.setOptions(FACEMESH_CONFIG);
       _faceMesh.onResults(_onResults);
   
       // Pre-warm the model (downloads WASM + model weights on first call)
       try {
         const videoEl = document.getElementById("video");
         if (videoEl && videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
           await _faceMesh.send({ image: videoEl });
         }
       } catch (_) {
         // Pre-warm failures are non-fatal; the loop will succeed shortly
       }
   
       _running = true;
       _rafId   = requestAnimationFrame(_loop);
   
       _setModuleState("face", "active", "Running");
       console.log(
         "%c[FaceDetection] Pipeline started — maxNumFaces: " +
         FACEMESH_CONFIG.maxNumFaces,
         "color:#3fb950;font-family:monospace"
       );
     }
   
     /**
      * Stops the frame loop and releases FaceMesh resources.
      */
     function stop() {
       _running = false;
       if (_rafId !== null) {
         cancelAnimationFrame(_rafId);
         _rafId = null;
       }
       if (_faceMesh) {
         _faceMesh.close?.();
         _faceMesh = null;
       }
       _setModuleState("face", "", "Stopped");
       console.log("[FaceDetection] Pipeline stopped.");
     }
   
     /**
      * Returns the most recent FaceMesh result object.
      * Useful for debugging and unit tests.
      * @returns {object|null}
      */
     function getLastResult() {
       return _lastResult;
     }
   
     /**
      * Returns a snapshot of session statistics.
      */
     function getStats() {
       return {
         running:         _running,
         framesProcessed: _stats.framesProcessed,
         detections:      { ..._stats.detections },
         violations:      { ..._stats.violations },
         absentFrames:    _absentFrames,
       };
     }
   
     return { start, stop, getLastResult, getStats, FACEMESH_CONFIG };
   
   })();
   
   /* ── Global alias ────────────────────────────────────────────── */
   window.FaceDetection = FaceDetection;
   
   /**
    * startFaceDetection()
    * ─────────────────────
    * Named export called from script.js after startCamera() succeeds.
    */
   async function startFaceDetection() {
     await FaceDetection.start();
     return FaceDetection;
   }
   
   window.startFaceDetection = startFaceDetection;
   
   console.log(
     "%c[FaceDetection] Module loaded — call startFaceDetection() after webcam is live.",
     "color:#8b949e;font-family:monospace"
   );