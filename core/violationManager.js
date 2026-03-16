/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   core/violationManager.js — Rule Engine & Violation Registry

   Responsibilities
   ────────────────
   1. Maintain a global violation counter and history array.
   2. Map violation counts to warning levels (Normal → Terminated).
   3. Debounce identical violation reasons (default 3 s cooldown).
   4. Update all UI elements: counter, warning bar, log, alert badge.
   5. Terminate the interview when the violation threshold is reached.
   6. Expose registerViolation(reason, severity?) as the single entry
      point for every monitoring module (tab, clipboard, face, eye, lip).

   Integration
   ───────────
   This file is loaded before script.js in index.html:
     <script src="core/violationManager.js"></script>
     <script src="script.js"></script>

   Other modules call:
     ViolationManager.registerViolation("Tab switch detected");
     ViolationManager.registerViolation("Multiple faces detected", "HIGH");

   Or via the window alias:
     window.registerViolation("Looking away from screen");
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const ViolationManager = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONSTANTS
        ══════════════════════════════════════════════════════════════ */
   
     /** Milliseconds a reason is blocked from re-firing after it triggers. */
     const DEBOUNCE_MS = 3000;
   
     /** Violation count thresholds that define each level. */
     const THRESHOLDS = {
       NORMAL:     0,   // 0       → Normal
       WARNING:    1,   // 1–2     → Warning
       ALERT:      3,   // 3–4     → Alert
       TERMINATED: 5,   // 5+      → Terminated
     };
   
     /**
      * Severity definitions used when building log entries.
      * Consumers can pass a string key ("LOW" / "MEDIUM" / "HIGH")
      * or reference ViolationManager.SEVERITY directly.
      */
     const SEVERITY = {
       LOW:    { key: "low",    label: "WARN",   cssClass: "level-low"    },
       MEDIUM: { key: "medium", label: "MEDIUM", cssClass: "level-medium" },
       HIGH:   { key: "high",   label: "HIGH",   cssClass: "level-high"   },
     };
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** Running total of accepted violations. */
     let _count = 0;
   
     /**
      * Full history of every accepted violation.
      * Each entry: { id, reason, severity, timestamp, ts }
      *   id        — sequential integer (1-based)
      *   reason    — human-readable description
      *   severity  — one of the SEVERITY objects
      *   timestamp — Date object at time of registration
      *   ts        — "HH:MM:SS" string for display
      */
     const _history = [];
   
     /**
      * Debounce registry.
      * Maps normalised reason string → timestamp (ms) of last acceptance.
      * A reason is suppressed if now - lastAccepted < DEBOUNCE_MS.
      */
     const _lastAccepted = new Map();
   
     /** Whether the interview has already been terminated. */
     let _terminated = false;
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Left-pads a number to 2 digits.
      * @param {number} n
      * @returns {string}
      */
     function _pad(n) {
       return String(n).padStart(2, "0");
     }
   
     /**
      * Returns a "HH:MM:SS" string for the given Date (defaults to now).
      * @param {Date} [date]
      * @returns {string}
      */
     function _timestamp(date = new Date()) {
       return `${_pad(date.getHours())}:${_pad(date.getMinutes())}:${_pad(date.getSeconds())}`;
     }
   
     /**
      * Normalises a reason string for use as a debounce map key.
      * Lowercasing + trimming prevents "Tab switch" vs "tab switch" bypasses.
      * @param {string} reason
      * @returns {string}
      */
     function _normalise(reason) {
       return reason.trim().toLowerCase();
     }
   
     /**
      * Resolves a severity argument (string key or object) to a SEVERITY entry.
      * Falls back to SEVERITY.LOW for unknown inputs.
      * @param {string|object} input
      * @returns {{ key: string, label: string, cssClass: string }}
      */
     function _resolveSeverity(input) {
       if (!input) return SEVERITY.LOW;
       if (typeof input === "object" && input.key) return input;
       if (typeof input === "string") {
         const match = SEVERITY[input.toUpperCase()];
         return match || SEVERITY.LOW;
       }
       return SEVERITY.LOW;
     }
   
     /**
      * Escapes HTML special characters so injected reason text
      * cannot introduce markup into the log.
      * @param {string} s
      * @returns {string}
      */
     function _escHtml(s) {
       return String(s)
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;");
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — DEBOUNCE
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Returns true if the reason is within its cooldown window.
      * @param {string} key  Normalised reason string.
      * @returns {boolean}
      */
     function _isDebounced(key) {
       if (!_lastAccepted.has(key)) return false;
       return (Date.now() - _lastAccepted.get(key)) < DEBOUNCE_MS;
     }
   
     /**
      * Records the current timestamp for a reason key.
      * @param {string} key
      */
     function _recordAcceptance(key) {
       _lastAccepted.set(key, Date.now());
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — WARNING LEVEL
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Derives the current warning level descriptor from _count.
      * @returns {{ label: string, barWidth: string, valueClass: string, badgeClass: string }}
      */
     function _getLevel() {
       if (_count >= THRESHOLDS.TERMINATED) {
         return { label: "TERMINATED", barWidth: "100%", valueClass: "warn-high", badgeClass: "badge badge-alert" };
       }
       if (_count >= THRESHOLDS.ALERT) {
         return { label: "ALERT",      barWidth: "70%",  valueClass: "warn-high", badgeClass: "badge badge-alert" };
       }
       if (_count >= THRESHOLDS.WARNING) {
         return { label: "WARNING",    barWidth: "35%",  valueClass: "warn-med",  badgeClass: "badge badge-warn"  };
       }
       return   { label: "NORMAL",     barWidth: "8%",   valueClass: "",          badgeClass: "badge badge-clear" };
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UI UPDATES
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Fetches a DOM element by ID, returning null without throwing
      * if the element does not exist yet.
      * @param {string} id
      * @returns {HTMLElement|null}
      */
     function _el(id) {
       return document.getElementById(id);
     }
   
     /** Updates the large violation counter in the right panel. */
     function _updateCounter() {
       const el = _el("violations");
       if (!el) return;
       el.textContent = _count;
       // Colour shifts: green (0) → yellow (1-4) → red (5+)
       el.classList.remove("has-violations", "has-alert", "has-terminated");
       if (_count >= THRESHOLDS.TERMINATED) el.classList.add("has-terminated");
       else if (_count >= THRESHOLDS.WARNING) el.classList.add("has-violations");
     }
   
     /** Updates the warning level bar, value text, and alert badge. */
     function _updateWarningLevel() {
       const level = _getLevel();
   
       const levelEl = _el("warningLevel");
       if (levelEl) {
         levelEl.textContent = level.label;
         levelEl.className   = `warn-value ${level.valueClass}`;
       }
   
       const fillEl = _el("warningBarFill");
       if (fillEl) fillEl.style.width = level.barWidth;
   
       const badgeEl = _el("alertBadge");
       if (badgeEl) {
         badgeEl.textContent = _count === 0 ? "CLEAR" : level.label;
         badgeEl.className   = level.badgeClass;
       }
     }
   
     /**
      * Appends a new <li> entry to the violation log console.
      * @param {object} entry  Violation history entry.
      */
     function _appendLogEntry(entry) {
       const logEl = _el("violationLog");
       if (!logEl) return;
   
       // Remove the "no violations" placeholder on first real entry
       const placeholder = logEl.querySelector(".vlog-empty");
       if (placeholder) placeholder.remove();
   
       const li = document.createElement("li");
       li.className = `vlog-entry ${entry.severity.cssClass}`;
       li.innerHTML =
         `<span class="vlog-time">[${entry.ts}]</span>` +
         `<span class="vlog-msg">${_escHtml(entry.reason)}</span>`;
   
       logEl.appendChild(li);
   
       // Smooth-scroll to reveal the newest entry
       li.scrollIntoView({ behavior: "smooth", block: "nearest" });
     }
   
     /** Updates the event-count badge and last-event footer. */
     function _updateLogMeta(ts) {
       const countEl = _el("vlogCount");
       if (countEl) {
         countEl.textContent = `${_count} event${_count !== 1 ? "s" : ""}`;
       }
   
       const lastEl = _el("vlogLastEvt");
       if (lastEl) lastEl.textContent = `Last event: ${ts}`;
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — TERMINATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Locks the system and alerts the proctor when violations reach
      * the TERMINATED threshold.
      */
     function _terminateInterview() {
       _terminated = true;
   
       // Stop the countdown timer if script.js started one
       if (window._timerInterval) {
         clearInterval(window._timerInterval);
         const timerEl = _el("interviewTimer");
         if (timerEl) {
           timerEl.classList.add("timer-critical");
         }
       }
   
       // Grey-out the status dot and text
       const dotEl  = _el("statusDot");
       const textEl = _el("systemStatus");
       if (dotEl)  dotEl.className  = "status-dot red";
       if (textEl) textEl.textContent = "Interview Terminated";
   
       console.error(
         "%c[ViolationManager] Interview terminated — threshold reached.",
         "color:#f85149;font-weight:bold;font-size:1.1em"
       );
   
       // A short delay keeps the log entry visible before the alert blocks
       setTimeout(() => {
         alert("Interview terminated due to excessive violations.");
       }, 300);
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — CONSOLE LOGGING
        ══════════════════════════════════════════════════════════════ */
   
     const _consolePalette = {
       low:    "#d29922",
       medium: "#d29922",
       high:   "#f85149",
     };
   
     /**
      * Mirrors a violation to the browser's DevTools console.
      * @param {object} entry
      */
     function _consoleLog(entry) {
       const colour = _consolePalette[entry.severity.key] || "#8b949e";
       console.log(
         `%c[Violation #${entry.id}] [${entry.ts}] ${entry.severity.label} — ${entry.reason}`,
         `color:${colour};font-family:monospace;font-weight:600`
       );
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * registerViolation(reason, severity?)
      * ──────────────────────────────────────
      * The single entry point for all monitoring modules.
      *
      * Steps performed on each accepted call:
      *   1. Guard: ignore if interview is already terminated.
      *   2. Debounce: suppress if the same reason fired < DEBOUNCE_MS ago.
      *   3. Increment counter & build history entry.
      *   4. Update all UI elements (counter, bar, log, badge).
      *   5. Check threshold and terminate if needed.
      *
      * @param {string}         reason    Human-readable description of the event.
      * @param {string|object}  [severity="LOW"]  "LOW" | "MEDIUM" | "HIGH" or a
      *                                           SEVERITY object.  Defaults to LOW.
      * @returns {object|null}  The recorded history entry, or null if suppressed.
      *
      * @example
      *   // From monitoring/tabMonitor.js
      *   ViolationManager.registerViolation("Tab switch detected", "MEDIUM");
      *
      *   // From ai/faceDetection.js
      *   ViolationManager.registerViolation("Multiple faces detected", "HIGH");
      *
      *   // Via the global alias
      *   window.registerViolation("Looking away from screen", "LOW");
      */
     function registerViolation(reason, severity = "LOW") {
       // ── Guard: already terminated ────────────────────────────────
       if (_terminated) {
         console.warn(`[ViolationManager] Ignored (terminated): "${reason}"`);
         return null;
       }
   
       // ── Guard: empty reason ──────────────────────────────────────
       if (!reason || typeof reason !== "string" || !reason.trim()) {
         console.warn("[ViolationManager] registerViolation called with empty reason.");
         return null;
       }
   
       // ── Debounce ─────────────────────────────────────────────────
       const key = _normalise(reason);
       if (_isDebounced(key)) {
         console.debug(
           `[ViolationManager] Debounced (${DEBOUNCE_MS}ms cooldown): "${reason}"`
         );
         return null;
       }
       _recordAcceptance(key);
   
       // ── Build entry ───────────────────────────────────────────────
       _count++;
       const now   = new Date();
       const ts    = _timestamp(now);
       const sev   = _resolveSeverity(severity);
       const entry = {
         id:        _count,
         reason:    reason.trim(),
         severity:  sev,
         timestamp: now,
         ts,
       };
       _history.push(entry);
   
       // ── UI updates ────────────────────────────────────────────────
       _updateCounter();
       _updateWarningLevel();
       _appendLogEntry(entry);
       _updateLogMeta(ts);
       _consoleLog(entry);
   
       // ── Expose latest on window for debugging ────────────────────
       window._lastViolation      = entry;
       window._violationCount     = _count;
   
       // ── Threshold check ───────────────────────────────────────────
       if (_count >= THRESHOLDS.TERMINATED) {
         _appendLogEntry({
           id:       _count + 1,
           reason:   "⚠ Violation threshold reached — interview terminated.",
           severity: SEVERITY.HIGH,
           ts,
         });
         _terminateInterview();
       }
   
       return entry;
     }
   
     /**
      * Returns a read-only snapshot of the violation history array.
      * Useful for other modules that want to read past events.
      * @returns {object[]}
      */
     function getHistory() {
       return [..._history];
     }
   
     /**
      * Returns the current violation count.
      * @returns {number}
      */
     function getCount() {
       return _count;
     }
   
     /**
      * Returns the current warning level label.
      * @returns {"NORMAL"|"WARNING"|"ALERT"|"TERMINATED"}
      */
     function getLevel() {
       return _getLevel().label;
     }
   
     /**
      * Returns true if the interview has been terminated.
      * @returns {boolean}
      */
     function isTerminated() {
       return _terminated;
     }
   
     /**
      * Resets all state — intended for unit tests or a "restart session".
      * Does NOT reload the page; just clears counters and re-renders UI.
      */
     function reset() {
       _count      = 0;
       _terminated = false;
       _history.length = 0;
       _lastAccepted.clear();
   
       _updateCounter();
       _updateWarningLevel();
   
       const logEl = _el("violationLog");
       if (logEl) {
         logEl.innerHTML =
           '<li class="vlog-empty">No violations recorded.</li>';
       }
   
       _updateLogMeta("—");
       console.log("[ViolationManager] State reset.");
     }
   
     /* ══════════════════════════════════════════════════════════════
        RETURN — public surface
        ══════════════════════════════════════════════════════════════ */
     return {
       registerViolation,
       getHistory,
       getCount,
       getLevel,
       isTerminated,
       reset,
       SEVERITY,
       THRESHOLDS,
       DEBOUNCE_MS,
     };
   
   })(); // end IIFE
   
   
   /* ══════════════════════════════════════════════════════════════
      GLOBAL ALIASES
      ══════════════════════════════════════════════════════════════
   
      Modules that don't have a direct reference to ViolationManager
      can call these window-level helpers instead.
   
      Examples
      ────────
      // monitoring/tabMonitor.js
      window.registerViolation("Tab switch detected", "MEDIUM");
   
      // ai/faceDetection.js
      window.registerViolation("Multiple faces detected", "HIGH");
   
      // ai/eyeTracking.js
      window.registerViolation("Looking away from screen", "LOW");
   
      // ai/lipMovement.js
      window.registerViolation("Continuous lip movement detected", "LOW");
   
      // monitoring/clipboardMonitor.js
      window.registerViolation("Clipboard usage attempt", "MEDIUM");
      ══════════════════════════════════════════════════════════════ */
   
   window.ViolationManager    = ViolationManager;
   window.registerViolation   = ViolationManager.registerViolation;
   window.SEVERITY            = ViolationManager.SEVERITY;
   
   // Keep backward-compat with script.js's older window.addViolation calls
   // so existing call-sites don't break during the transition.
   window.addViolation = function addViolation(message, severityObj) {
     // script.js passes SEVERITY objects ({key, label}); resolve them
     let sevKey = "LOW";
     if (severityObj && severityObj.key) {
       const map = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
       sevKey = map[severityObj.key] || "LOW";
     }
     return ViolationManager.registerViolation(message, sevKey);
   };
   
   console.log(
     "%c[ViolationManager] Loaded — debounce: " + ViolationManager.DEBOUNCE_MS + "ms | " +
     "terminate at: " + ViolationManager.THRESHOLDS.TERMINATED + " violations",
     "color:#3fb950;font-family:monospace"
   );