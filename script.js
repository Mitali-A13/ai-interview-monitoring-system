/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System — script.js
   Covers: webcam, countdown timer, violation log API,
           problem loader, run-button sandbox, UI helpers.

   Other modules (ai/faceDetection.js, ai/eyeTracking.js,
   ai/lipMovement.js, monitoring/*.js) call the public API
   exposed on window at the bottom of this file.
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   /* ══════════════════════════════════════════════════════════════
      1.  PROBLEM BANK + LOADER
      ══════════════════════════════════════════════════════════════ */
   
   const problems = [
     {
       title:       "Two Sum",
       description: "Given an array of integers and a target value, return the indices of the two numbers that add up to the target. You may assume exactly one solution exists.",
       input:       "nums = [2, 7, 11, 15],  target = 9",
       starterCode: `function twoSum(nums, target) {\n  // your solution here\n}\n`,
     },
     {
       title:       "Reverse String",
       description: "Write a function that reverses a string. The input string is given as an array of characters. Do it in-place with O(1) extra memory.",
       input:       's = ["h","e","l","l","o"]',
       starterCode: `function reverseString(s) {\n  // your solution here\n}\n`,
     },
     {
       title:       "FizzBuzz",
       description: "Given an integer n, return an array of strings for each number from 1 to n: 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, 'FizzBuzz' for both, otherwise the number itself.",
       input:       "n = 15",
       starterCode: `function fizzBuzz(n) {\n  // your solution here\n}\n`,
     },
     {
       title:       "Palindrome Check",
       description: "Given a string s, return true if it is a palindrome, ignoring non-alphanumeric characters and case differences.",
       input:       's = "A man, a plan, a canal: Panama"',
       starterCode: `function isPalindrome(s) {\n  // your solution here\n}\n`,
     },
     {
       title:       "Find Maximum",
       description: "Write a function that takes an array of integers and returns the largest value without using built-in Math.max.",
       input:       "nums = [3, 1, 4, 1, 5, 9, 2, 6]",
       starterCode: `function findMax(nums) {\n  // your solution here\n}\n`,
     },
   ];
   
   /**
    * Picks a random problem and populates the center panel.
    * Exposed as window.loadProblem() so external code can call it.
    */
   function loadProblem() {
     const problem = problems[Math.floor(Math.random() * problems.length)];
     const idx     = problems.indexOf(problem) + 1;
   
     const titleEl   = document.getElementById("problemTitle");
     const descEl    = document.getElementById("problemDesc");
     const inputEl   = document.getElementById("problemInput");
     const badgeEl   = document.getElementById("problemBadge");
     const editorEl  = document.getElementById("codeEditor");
   
     if (titleEl)  titleEl.textContent  = problem.title;
     if (descEl)   descEl.textContent   = problem.description;
     if (inputEl)  inputEl.textContent  = problem.input;
     if (badgeEl)  badgeEl.textContent  = `Problem ${idx} / ${problems.length}`;
     if (editorEl) editorEl.value       = problem.starterCode;
   
     console.log(`[Problem] Loaded: "${problem.title}"`);
   }
   
   
   /* ══════════════════════════════════════════════════════════════
      2.  WEBCAM
      ══════════════════════════════════════════════════════════════ */
   
   const VIDEO_CONSTRAINTS = {
     video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
     audio: false,
   };
   
   /**
    * Requests webcam access and streams it into #video.
    * On success → updateCameraUI(true).
    * On failure → alert + updateCameraUI(false).
    */
   async function startCamera() {
     console.log("[Camera] Requesting webcam access…");
   
     if (!navigator.mediaDevices?.getUserMedia) {
       console.error("[Camera] getUserMedia not supported.");
       handleCameraError(new Error("getUserMedia not supported"));
       return;
     }
   
     try {
       const videoEl = document.getElementById("video");
       const stream  = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
   
       videoEl.srcObject = stream;
   
       await new Promise((resolve, reject) => {
         videoEl.onloadedmetadata = resolve;
         videoEl.onerror          = reject;
       });
       await videoEl.play();
   
       // Hide no-signal overlay
       const noSig = document.getElementById("camNoSignal");
       if (noSig) noSig.style.display = "none";
   
       console.log("%c[Camera] Webcam started successfully", "color:#3fb950;font-weight:bold");
       updateCameraUI(true);
   
       // Start AI analysis pipeline once we have a live video feed
       if (typeof startFaceDetection === "function") {
         startFaceDetection().then(() => {
           console.log("%c[AI] FaceDetection pipeline active.", "color:#3fb950;font-family:monospace");
         }).catch(err => {
           console.error("[AI] FaceDetection failed to start:", err);
           setModuleState("face", "error", "Load Error");
         });
       }
   
     } catch (err) {
       handleCameraError(err);
     }
   }
   
   function handleCameraError(err) {
     const messages = {
       NotAllowedError:     "Permission denied.",
       NotFoundError:       "No camera found.",
       NotReadableError:    "Camera already in use.",
       OverconstrainedError:"Constraints not satisfied.",
     };
     const reason = messages[err.name] || err.message || "Unknown error.";
     console.error(`[Camera] ${err.name}: ${reason}`);
   
     updateCameraUI(false);
   
     const noSig = document.getElementById("camNoSignal");
     if (noSig) {
       noSig.style.display = "flex";
       const span = noSig.querySelector("span");
       if (span) span.textContent = `Camera Error: ${err.name}`;
     }
   
     alert("Camera access is required for the interview monitoring system.");
   }
   
   /**
    * Syncs all camera-related UI elements.
    * @param {boolean} isActive
    */
   function updateCameraUI(isActive) {
     // Status bar item
     const sbCam = document.getElementById("sbCamera");
     if (sbCam) sbCam.textContent = `Camera: ${isActive ? "Online" : "Offline"}`;
   
     // REC badge
     const recBadge = document.getElementById("recBadge");
     if (recBadge) recBadge.style.display = isActive ? "flex" : "none";
   
     // Module dots + states
     setModuleState("face",  isActive ? "active" : "error", isActive ? "Active" : "No Feed");
     setModuleState("eye",   isActive ? "active" : "error", isActive ? "Running" : "No Feed");
     setModuleState("mouth", isActive ? "active" : "error", isActive ? "Running" : "No Feed");
   
     // Header status
     const statusDot  = document.getElementById("statusDot");
     const statusText = document.getElementById("systemStatus");
     if (statusDot)  statusDot.className  = `status-dot ${isActive ? "active" : "red"}`;
     if (statusText) statusText.textContent = isActive ? "Monitoring Active" : "Camera Error";
   
     // Detection values initial text
     if (isActive) {
       setText("eyeStatus",   "Tracking");
       setText("mouthStatus", "Monitoring");
     } else {
       setText("eyeStatus",   "No Feed");
       setText("mouthStatus", "No Feed");
     }
   
     console.log(`[UI] Camera → ${isActive ? "ONLINE" : "OFFLINE"}`);
   }
   
   /**
    * Updates a module row dot + state text.
    * @param {"face"|"eye"|"mouth"} key
    * @param {"active"|"warn"|"error"|""} state
    * @param {string} label
    */
   function setModuleState(key, state, label) {
     const dotMap   = { face: "faceDot",  eye: "eyeDot",  mouth: "mouthDot"  };
     const stateMap = { face: "faceDetectionStatus", eye: "eyeTrackingStatus", mouth: "mouthAnalysisStatus" };
   
     const dotEl   = document.getElementById(dotMap[key]);
     const stateEl = document.getElementById(stateMap[key]);
   
     if (dotEl) {
       dotEl.className = `mod-dot ${state}`;
     }
     if (stateEl) {
       stateEl.textContent = label;
       stateEl.className   = `mod-state ${state}`;
     }
   }
   
   
   /* ══════════════════════════════════════════════════════════════
      3.  COUNTDOWN TIMER  (60 minutes, MM:SS)
      ══════════════════════════════════════════════════════════════ */
   
   const INTERVIEW_DURATION = 60 * 60; // seconds
   
   (function initTimer() {
     const timerEl = document.getElementById("interviewTimer");
     if (!timerEl) return;
   
     let secondsLeft = INTERVIEW_DURATION;
     window._interviewTimeLeft = secondsLeft;
   
     function fmt(secs) {
       const m = String(Math.floor(secs / 60)).padStart(2, "0");
       const s = String(secs % 60).padStart(2, "0");
       return `${m}:${s}`;
     }
   
     // Render immediately (no 1-second blank)
     timerEl.textContent = fmt(secondsLeft);
   
     function tick() {
       secondsLeft--;
       window._interviewTimeLeft = secondsLeft;
       timerEl.textContent = fmt(secondsLeft);
   
       // Visual warning classes
       timerEl.classList.remove("timer-warn", "timer-critical");
       if      (secondsLeft <= 5 * 60)  timerEl.classList.add("timer-critical");
       else if (secondsLeft <= 10 * 60) timerEl.classList.add("timer-warn");
   
       // Console milestones
       if ([10*60, 5*60, 60].includes(secondsLeft)) {
         console.warn(`[Timer] ⚠ ${fmt(secondsLeft)} remaining.`);
       }
   
       if (secondsLeft <= 0) {
         clearInterval(window._timerInterval);
         timerEl.textContent = "00:00";
         timerEl.classList.add("timer-ended");
         console.log("%c[Timer] Interview session has ended.", "color:#f85149;font-weight:bold");
         alert("Interview session has ended.");
       }
     }
   
     window._timerInterval = setInterval(tick, 1000);
     console.log(`[Timer] Countdown started — ${fmt(secondsLeft)} remaining.`);
   })();
   
   
   /* ══════════════════════════════════════════════════════════════
      4.  VIOLATION LOG API  — delegates to core/violationManager.js
      ══════════════════════════════════════════════════════════════
   
      ViolationManager is loaded first (see index.html) and owns all
      violation state.  This section re-exports its API so the rest of
      this file can reference SEVERITY / addViolation without changes,
      and so any inline demo calls still work.
      ══════════════════════════════════════════════════════════════ */
   
   /**
    * SEVERITY — re-exported from ViolationManager for local use.
    * External modules should reference window.SEVERITY or
    * ViolationManager.SEVERITY directly.
    */
   const SEVERITY = window.SEVERITY || {
     LOW:    { key: "low",    label: "WARN"   },
     MEDIUM: { key: "medium", label: "MEDIUM" },
     HIGH:   { key: "high",   label: "HIGH"   },
   };
   
   /**
    * addViolation — thin wrapper kept for backward compatibility.
    * Delegates to ViolationManager.registerViolation().
    *
    * Prefer calling window.registerViolation() from monitoring modules.
    */
   function addViolation(message, severity = SEVERITY.LOW) {
     if (window.ViolationManager) {
       // Resolve legacy {key,label} objects to string keys
       const sevMap = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
       const sevKey = (severity && severity.key) ? sevMap[severity.key] || "LOW" : "LOW";
       return window.ViolationManager.registerViolation(message, sevKey);
     }
     console.warn("[script.js] ViolationManager not available:", message);
   }
   
   /** updateWarningLevel — ViolationManager handles this internally now. */
   function updateWarningLevel() {
     /* no-op: ViolationManager._updateWarningLevel() is called inside
        registerViolation(). This stub prevents ReferenceErrors if any
        legacy code calls updateWarningLevel() directly. */
   }
   
   
   /* ══════════════════════════════════════════════════════════════
      5.  CODE EDITOR — RUN BUTTON (sandboxed eval)
      ══════════════════════════════════════════════════════════════ */
   
   function initEditor() {
     const runBtn    = document.getElementById("btnRun");
     const submitBtn = document.getElementById("btnSubmit");
     const clearBtn  = document.getElementById("outputClear");
     const outputEl  = document.getElementById("outputBody");
   
     function setOutput(html) {
       if (outputEl) outputEl.innerHTML = html;
     }
   
     if (runBtn) {
       runBtn.addEventListener("click", () => {
         const code = document.getElementById("codeEditor")?.value ?? "";
         if (!code.trim()) {
           setOutput('<span class="output-info">Nothing to run.</span>');
           return;
         }
         try {
           // Capture console.log output within the snippet
           const logs = [];
           const fakeConsole = { log: (...a) => logs.push(a.map(String).join(" ")) };
           // eslint-disable-next-line no-new-func
           const fn  = new Function("console", code);
           const ret = fn(fakeConsole);
   
           const lines = [...logs];
           if (ret !== undefined) lines.push(`→ ${JSON.stringify(ret)}`);
           setOutput(lines.length
             ? lines.map(l => `<div class="output-ok">${escHtml(l)}</div>`).join("")
             : '<span class="output-info">Code ran with no output.</span>');
         } catch (e) {
           setOutput(`<span class="output-error">Error: ${escHtml(e.message)}</span>`);
         }
       });
     }
   
     if (submitBtn) {
       submitBtn.addEventListener("click", () => {
         setOutput('<span class="output-ok">✓ Solution submitted successfully.</span>');
       });
     }
   
     if (clearBtn) {
       clearBtn.addEventListener("click", () => {
         setOutput('<span class="output-placeholder">Run your code to see output.</span>');
       });
     }
   }
   
   
   /* ══════════════════════════════════════════════════════════════
      6.  UTILITIES
      ══════════════════════════════════════════════════════════════ */
   
   function pad(n) { return String(n).padStart(2, "0"); }
   function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
   function escHtml(s) {
     return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
   }
   
   
   /* ══════════════════════════════════════════════════════════════
      7.  PUBLIC API  (consumed by ai/ and monitoring/ modules)
      ══════════════════════════════════════════════════════════════ */
   
   window.addViolation   = addViolation;
   window.SEVERITY       = SEVERITY;
   window.setModuleState = setModuleState;
   window.updateCameraUI = updateCameraUI;
   window.loadProblem    = loadProblem;
   // AI modules are self-registering: FaceDetection, EyeTracking, LipMovement
   // are placed on window by their own files and called via startFaceDetection().
   
   
   /* ══════════════════════════════════════════════════════════════
      8.  INIT
      ══════════════════════════════════════════════════════════════ */
   
   document.addEventListener("DOMContentLoaded", () => {
     console.log("[Init] DOM ready — AI Interview Monitoring System starting.");
   
     loadProblem();               // Random problem in center panel
     startCamera();               // Webcam stream
     initEditor();                // Run / Submit / Clear buttons
     startTabMonitoring();        // Tab-switch & focus-loss detection
     startClipboardMonitoring();  // Clipboard & context-menu guard
   });