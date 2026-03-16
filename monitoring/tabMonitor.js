

   "use strict";

   const TabMonitor = (function () {
   
     
     const TAB_COOLDOWN_MS = 5_000;
   
     
     const INTENT_DELAY_MS = 300;
   
     /** Violation reason string — must match what other modules expect. */
     const REASON = "Tab switch detected";
   
     /** Severity forwarded to ViolationManager. */
     const SEVERITY_KEY = "MEDIUM";
   
     
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
   
     
     function _getRegisterFn() {
       if (window.ViolationManager && typeof window.ViolationManager.registerViolation === "function") {
         return window.ViolationManager.registerViolation;
       }
       if (typeof window.registerViolation === "function") {
         return window.registerViolation;
       }
       return null;
     }
   
     
     function _candidateIsAway() {
       const hidden   = document.visibilityState === "hidden";
       const unfocused = typeof document.hasFocus === "function" && !document.hasFocus();
       return hidden || unfocused;
     }
   
     
     function _cooldownExpired() {
       return (Date.now() - _lastViolationAt) >= TAB_COOLDOWN_MS;
     }
   
     /** Formats a Date for console output: "HH:MM:SS". */
     function _fmt(date = new Date()) {
       return [date.getHours(), date.getMinutes(), date.getSeconds()]
         .map(n => String(n).padStart(2, "0"))
         .join(":");
     }
   
     
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