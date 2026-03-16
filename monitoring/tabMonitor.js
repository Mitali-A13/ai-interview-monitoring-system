/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   monitoring/tabMonitor.js — Tab-Switch & Focus-Loss Detector

   Detected behaviours
   ───────────────────
   • Tab switch      — candidate opens another browser tab
   • Window minimise — browser window sent to taskbar / dock
   • App switch      — OS-level alt-tab to another application
   • All three map to the same violation reason so deduplication
     in ViolationManager collapses them into a single log entry
     per cooldown window.

   APIs used
   ─────────
   • document.visibilityState  / "visibilitychange" event
       Fires when the tab becomes hidden (switched away) or visible
       (returned to).  Most reliable signal across all browsers.
   • window "blur" / "focus" events
       Fires when the OS removes keyboard / mouse focus from the
       browser window even if the tab stays "visible" (e.g. a native
       dialog, or alt-tab on some platforms).

   Why two signals instead of one
   ───────────────────────────────
   Neither API covers all cases alone:
   - visibilitychange fires on tab switch but NOT always on alt-tab.
   - blur fires on alt-tab but NOT when the tab is still focused in
     a background window.
   Both are listened to, but a module-level cooldown (TAB_COOLDOWN_MS)
   ensures only one violation is registered no matter how many events
   fire in the same "leave" gesture.

   Integration
   ───────────
   Load after core/violationManager.js:
     <script src="core/violationManager.js"></script>
     <script src="monitoring/tabMonitor.js"></script>

   Then call once (e.g. from script.js DOMContentLoaded):
     startTabMonitoring();

   Or access the full API via:
     TabMonitor.start();
     TabMonitor.stop();
     TabMonitor.getStats();
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const TabMonitor = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Minimum milliseconds between two accepted tab-switch violations.
      * This window spans BOTH visibilitychange and blur so that a single
      * "switch tabs" gesture — which fires both events — only logs once.
      * Set higher than ViolationManager.DEBOUNCE_MS (3 000 ms) so the
      * manager's own deduplication never needs to fight this one.
      */
     const TAB_COOLDOWN_MS = 5_000;
   
     /**
      * How long (ms) after a page-hidden / blur event we wait before
      * deciding the candidate has genuinely left — not just a transient
      * focus blip (e.g. clicking a native browser dropdown).
      * Keeps false positives from OS tooltips or permission dialogs low.
      */
     const INTENT_DELAY_MS = 300;
   
     /** Violation reason string — must match what other modules expect. */
     const REASON = "Tab switch detected";
   
     /** Severity forwarded to ViolationManager. */
     const SEVERITY_KEY = "MEDIUM";
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** True while listeners are attached. */
     let _active = false;
   
     /** Timestamp (ms) of the last accepted violation, or 0. */
     let _lastViolationAt = 0;
   
     /**
      * setTimeout handle for the INTENT_DELAY timer.
      * Cleared when the candidate returns before it fires.
      */
     let _intentTimer = null;
   
     /**
      * Cumulative statistics for this session.
      * Exposed via getStats() — useful for AI modules and logging.
      */
     const _stats = {
       totalLeaves:     0,  // times the candidate left (including debounced ones)
       totalViolations: 0,  // times a violation was actually registered
       totalReturns:    0,  // times the candidate came back
       lastLeftAt:      null,
       lastReturnedAt:  null,
     };
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Resolves registerViolation from ViolationManager (preferred)
      * or falls back to window.registerViolation set by violationManager.js.
      * Returns null if neither is available.
      * @returns {Function|null}
      */
     function _getRegisterFn() {
       if (window.ViolationManager && typeof window.ViolationManager.registerViolation === "function") {
         return window.ViolationManager.registerViolation;
       }
       if (typeof window.registerViolation === "function") {
         return window.registerViolation;
       }
       return null;
     }
   
     /**
      * Returns true when the candidate is "away":
      *   - Page is hidden (another tab in front, window minimised), OR
      *   - document lacks focus (alt-tabbed to another application).
      * @returns {boolean}
      */
     function _candidateIsAway() {
       const hidden   = document.visibilityState === "hidden";
       const unfocused = typeof document.hasFocus === "function" && !document.hasFocus();
       return hidden || unfocused;
     }
   
     /**
      * Returns true if enough time has elapsed since the last accepted
      * violation to allow a new one.
      * @returns {boolean}
      */
     function _cooldownExpired() {
       return (Date.now() - _lastViolationAt) >= TAB_COOLDOWN_MS;
     }
   
     /** Formats a Date for console output: "HH:MM:SS". */
     function _fmt(date = new Date()) {
       return [date.getHours(), date.getMinutes(), date.getSeconds()]
         .map(n => String(n).padStart(2, "0"))
         .join(":");
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — VIOLATION DISPATCH
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Called after INTENT_DELAY_MS to confirm the candidate is still
      * away, then registers the violation.
      *
      * Flow:
      *   leave event fires
      *     └─ schedules _confirmAndRegister after INTENT_DELAY_MS
      *           └─ candidate still away? AND cooldown expired?
      *                 └─ registerViolation(REASON, SEVERITY_KEY)
      */
     function _confirmAndRegister() {
       _intentTimer = null;
   
       // Re-check: candidate may have returned before the delay fired
       if (!_candidateIsAway()) {
         console.debug("[TabMonitor] Intent timer fired but candidate already returned — no violation.");
         return;
       }
   
       // Module-level cooldown (independent of ViolationManager's debounce)
       if (!_cooldownExpired()) {
         const remaining = Math.ceil((TAB_COOLDOWN_MS - (Date.now() - _lastViolationAt)) / 1000);
         console.debug(`[TabMonitor] Cooldown active — ${remaining}s remaining, violation suppressed.`);
         return;
       }
   
       // Check if interview was terminated before firing
       if (window.ViolationManager && window.ViolationManager.isTerminated()) {
         console.debug("[TabMonitor] Interview terminated — ignoring tab switch.");
         return;
       }
   
       const registerFn = _getRegisterFn();
       if (!registerFn) {
         console.error("[TabMonitor] registerViolation not found — ViolationManager not loaded.");
         return;
       }
   
       _lastViolationAt = Date.now();
       _stats.totalViolations++;
   
       console.warn(
         `%c[TabMonitor] ${_fmt()} — Tab switch violation #${_stats.totalViolations} registered.`,
         "color:#d29922;font-family:monospace;font-weight:600"
       );
   
       registerFn(REASON, SEVERITY_KEY);
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — EVENT HANDLERS
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Handles the "candidate left" signal from either event source.
      * Starts the intent-confirmation timer; cancels any pending one first
      * so back-to-back firings from both APIs don't double-schedule.
      * @param {string} source  "visibility" | "blur"  — for logging only.
      */
     function _onLeave(source) {
       _stats.totalLeaves++;
       _stats.lastLeftAt = new Date();
   
       console.debug(
         `[TabMonitor] Leave detected via ${source} at ${_fmt(_stats.lastLeftAt)}` +
         ` (total leaves: ${_stats.totalLeaves})`
       );
   
       // Cancel any previous pending confirmation (idempotent re-entry)
       if (_intentTimer !== null) {
         clearTimeout(_intentTimer);
       }
   
       _intentTimer = setTimeout(_confirmAndRegister, INTENT_DELAY_MS);
     }
   
     /**
      * Handles the "candidate returned" signal.
      * Cancels any pending intent timer — if they came back fast enough
      * (within INTENT_DELAY_MS) the violation is suppressed.
      * @param {string} source  "visibility" | "focus"  — for logging only.
      */
     function _onReturn(source) {
       _stats.totalReturns++;
       _stats.lastReturnedAt = new Date();
   
       const away = Date.now() - (_stats.lastLeftAt?.getTime() ?? Date.now());
   
       // Cancel pending intent timer → no violation for brief leaves
       if (_intentTimer !== null) {
         clearTimeout(_intentTimer);
         _intentTimer = null;
         console.debug(
           `[TabMonitor] Returned via ${source} after ${away}ms — intent timer cancelled.`
         );
       } else {
         console.debug(
           `[TabMonitor] Returned via ${source} after ${away}ms.`
         );
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — NAMED LISTENER REFERENCES
        (stored so stop() can remove them cleanly)
        ══════════════════════════════════════════════════════════════ */
   
     function _handleVisibilityChange() {
       if (document.visibilityState === "hidden") {
         _onLeave("visibility");
       } else {
         // "visible" — candidate returned to this tab
         _onReturn("visibility");
       }
     }
   
     function _handleBlur() {
       // A blur without a corresponding visibilitychange means the window
       // lost OS focus (alt-tab, native dialog) but the tab is still "visible".
       // Only act if the page is still nominally visible — otherwise
       // visibilitychange already handled it.
       if (document.visibilityState === "visible") {
         _onLeave("blur");
       }
     }
   
     function _handleFocus() {
       if (document.visibilityState === "visible") {
         _onReturn("focus");
       }
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Attaches all event listeners and activates monitoring.
      * Safe to call multiple times — subsequent calls are no-ops.
      *
      * @returns {boolean}  true if monitoring was started, false if already active.
      */
     function start() {
       if (_active) {
         console.warn("[TabMonitor] Already active — start() ignored.");
         return false;
       }
   
       // ── Page Visibility API ───────────────────────────────────────
       document.addEventListener("visibilitychange", _handleVisibilityChange);
   
       // ── Window focus events ───────────────────────────────────────
       window.addEventListener("blur",  _handleBlur);
       window.addEventListener("focus", _handleFocus);
   
       _active = true;
   
       console.log(
         "%c[TabMonitor] Started — " +
         `cooldown: ${TAB_COOLDOWN_MS}ms | intent delay: ${INTENT_DELAY_MS}ms`,
         "color:#3fb950;font-family:monospace"
       );
   
       // Edge-case: if the page loaded while already hidden (rare but possible
       // in some browser restore scenarios), fire immediately.
       if (document.visibilityState === "hidden") {
         console.warn("[TabMonitor] Page loaded in hidden state — registering immediate violation.");
         _onLeave("visibility (load)");
       }
   
       return true;
     }
   
     /**
      * Removes all event listeners and deactivates monitoring.
      * Any pending intent timer is also cancelled.
      *
      * @returns {boolean}  true if monitoring was stopped, false if already inactive.
      */
     function stop() {
       if (!_active) {
         console.warn("[TabMonitor] Not active — stop() ignored.");
         return false;
       }
   
       document.removeEventListener("visibilitychange", _handleVisibilityChange);
       window.removeEventListener("blur",  _handleBlur);
       window.removeEventListener("focus", _handleFocus);
   
       if (_intentTimer !== null) {
         clearTimeout(_intentTimer);
         _intentTimer = null;
       }
   
       _active = false;
       console.log("[TabMonitor] Stopped — all listeners removed.");
       return true;
     }
   
     /**
      * Returns a snapshot of session statistics.
      * Useful for the AI modules and end-of-session reporting.
      *
      * @returns {{
      *   active:           boolean,
      *   totalLeaves:      number,
      *   totalViolations:  number,
      *   totalReturns:     number,
      *   lastLeftAt:       Date|null,
      *   lastReturnedAt:   Date|null,
      *   cooldownMs:       number,
      *   intentDelayMs:    number,
      * }}
      */
     function getStats() {
       return {
         active:          _active,
         totalLeaves:     _stats.totalLeaves,
         totalViolations: _stats.totalViolations,
         totalReturns:    _stats.totalReturns,
         lastLeftAt:      _stats.lastLeftAt,
         lastReturnedAt:  _stats.lastReturnedAt,
         cooldownMs:      TAB_COOLDOWN_MS,
         intentDelayMs:   INTENT_DELAY_MS,
       };
     }
   
     /* ── Return public surface ─────────────────────────────────── */
     return { start, stop, getStats };
   
   })(); // end TabMonitor IIFE
   
   
   /* ══════════════════════════════════════════════════════════════
      NAMED EXPORT — called by script.js DOMContentLoaded
      ══════════════════════════════════════════════════════════════ */
   
   /**
    * startTabMonitoring()
    * ────────────────────
    * Convenience wrapper so script.js (and the assignment spec) can call
    * a single named function without referencing the TabMonitor namespace.
    *
    * @returns {object}  The TabMonitor object (useful for testing).
    *
    * @example
    *   // In script.js DOMContentLoaded:
    *   startTabMonitoring();
    *
    *   // Or with a reference for later control:
    *   const monitor = startTabMonitoring();
    *   monitor.stop();
    */
   function startTabMonitoring() {
     TabMonitor.start();
     return TabMonitor;
   }
   
   /* ── Global aliases ──────────────────────────────────────────── */
   window.TabMonitor        = TabMonitor;
   window.startTabMonitoring = startTabMonitoring;
   
   console.log(
     "%c[TabMonitor] Module loaded — call startTabMonitoring() to activate.",
     "color:#8b949e;font-family:monospace"
   );