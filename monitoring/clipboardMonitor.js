/* ═══════════════════════════════════════════════════════════════
   AI Interview Monitoring System
   monitoring/clipboardMonitor.js — Clipboard & Context-Menu Guard

   Blocked actions
   ───────────────
   • copy         — Ctrl+C / Cmd+C / selection copy
   • cut          — Ctrl+X / Cmd+X
   • paste        — Ctrl+V / Cmd+V
   • contextmenu  — right-click (exposes browser copy/paste menu)

   For every blocked action this module:
     1. Calls event.preventDefault()  → operation is cancelled.
     2. Calls event.stopPropagation() → downstream handlers don't see it.
     3. Registers a violation via ViolationManager.
     4. Shows a brief in-page toast so the candidate knows why the
        action failed (better UX than a silent block).

   Special cases handled
   ──────────────────────
   • The code <textarea> (#codeEditor) must accept normal typing and
     cut/copy of the candidate's OWN code — blocking paste into it is
     still enforced (prevents code injection from an external source).
   • The violation reason distinguishes the action type so the log
     shows "Clipboard copy attempt" vs "Clipboard paste attempt" etc.
   • A per-action cooldown prevents log spam when the candidate holds
     Ctrl+C or opens/closes the context menu rapidly.

   Integration
   ───────────
   index.html load order:
     <script src="core/violationManager.js"></script>
     <script src="monitoring/tabMonitor.js"></script>
     <script src="monitoring/clipboardMonitor.js"></script>
     <script src="script.js"></script>

   Activate from script.js DOMContentLoaded:
     startClipboardMonitoring();

   Full API also available as:
     ClipboardMonitor.start();
     ClipboardMonitor.stop();
     ClipboardMonitor.getStats();
   ═══════════════════════════════════════════════════════════════ */

   "use strict";

   const ClipboardMonitor = (function () {
   
     /* ══════════════════════════════════════════════════════════════
        CONFIGURATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Per-action cooldown (ms).
      * Prevents the same action type from logging more than once
      * within this window — e.g. holding Ctrl+C generates many events.
      * Intentionally longer than ViolationManager.DEBOUNCE_MS (3 000 ms)
      * so the two debounce layers never fight each other.
      */
     const COOLDOWN_MS = 4_000;
   
     /**
      * How long (ms) the in-page toast notification stays visible
      * before fading out.
      */
     const TOAST_DURATION_MS = 2_500;
   
     /**
      * ID of the code editor textarea.
      * copy and cut originating FROM this element are allowed
      * (candidate copying their own code is not suspicious).
      * paste INTO it is still blocked.
      */
     const CODE_EDITOR_ID = "codeEditor";
   
     /**
      * CSS class added to the toast container element.
      * Defined once here so HTML injection in _showToast uses
      * a known, sanitised string.
      */
     const TOAST_CLASS = "clipboard-toast";
   
     /**
      * Monitored events and their display labels.
      * Each entry also carries:
      *   severity  → forwarded to ViolationManager
      *   blockFromEditor → false means the event is allowed when it
      *                     originates from #codeEditor
      */
     const WATCHED_EVENTS = [
       {
         type:            "copy",
         reason:          "Clipboard copy attempt",
         severity:        "MEDIUM",
         blockFromEditor: false,   // copying own code is OK
         toastMsg:        "⛔  Copying is not allowed during the interview.",
       },
       {
         type:            "cut",
         reason:          "Clipboard cut attempt",
         severity:        "MEDIUM",
         blockFromEditor: false,   // cutting own code is OK
         toastMsg:        "⛔  Cutting is not allowed during the interview.",
       },
       {
         type:            "paste",
         reason:          "Clipboard paste attempt",
         severity:        "HIGH",
         blockFromEditor: true,    // pasting into editor is always blocked
         toastMsg:        "⛔  Pasting is not allowed during the interview.",
       },
       {
         type:            "contextmenu",
         reason:          "Right-click menu opened",
         severity:        "LOW",
         blockFromEditor: true,
         toastMsg:        "⛔  Right-click is disabled during the interview.",
       },
     ];
   
     /* ══════════════════════════════════════════════════════════════
        STATE
        ══════════════════════════════════════════════════════════════ */
   
     /** True while document-level listeners are attached. */
     let _active = false;
   
     /**
      * Per-action-type last-accepted timestamps.
      * Key: event type string ("copy" | "cut" | "paste" | "contextmenu").
      * Value: Date.now() at last accepted violation.
      */
     const _lastAccepted = new Map();
   
     /**
      * Session statistics snapshot exposed via getStats().
      * Counts are per event type plus a grand total.
      */
     const _stats = {
       totalBlocked:    0,
       totalViolations: 0,
       byType: {
         copy:        { blocked: 0, violations: 0 },
         cut:         { blocked: 0, violations: 0 },
         paste:       { blocked: 0, violations: 0 },
         contextmenu: { blocked: 0, violations: 0 },
       },
     };
   
     /** Handle for the active toast fadeout timer, so rapid events don't pile up. */
     let _toastTimer = null;
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — UTILITIES
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Resolves registerViolation from ViolationManager (preferred)
      * or falls back to window.registerViolation.
      * @returns {Function|null}
      */
     function _getRegisterFn() {
       if (window.ViolationManager?.registerViolation) {
         return window.ViolationManager.registerViolation;
       }
       if (typeof window.registerViolation === "function") {
         return window.registerViolation;
       }
       return null;
     }
   
     /**
      * Returns true if the event originates from the code editor element.
      * @param {Event} evt
      * @returns {boolean}
      */
     function _fromEditor(evt) {
       const editorEl = document.getElementById(CODE_EDITOR_ID);
       return editorEl !== null && (evt.target === editorEl || editorEl.contains(evt.target));
     }
   
     /**
      * Returns true if enough time has passed since the last accepted
      * violation for this specific action type.
      * @param {string} type  Event type string.
      * @returns {boolean}
      */
     function _cooldownExpired(type) {
       if (!_lastAccepted.has(type)) return true;
       return (Date.now() - _lastAccepted.get(type)) >= COOLDOWN_MS;
     }
   
     /** Formats current time as "HH:MM:SS" for console output. */
     function _now() {
       const d = new Date();
       return [d.getHours(), d.getMinutes(), d.getSeconds()]
         .map(n => String(n).padStart(2, "0"))
         .join(":");
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — TOAST NOTIFICATION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Displays a brief in-page toast message near the top of the screen.
      * Uses a single shared <div> that is reused across calls so rapid
      * events don't stack dozens of elements in the DOM.
      * @param {string} message
      */
     function _showToast(message) {
       // Re-use existing toast element if present
       let toast = document.querySelector(`.${TOAST_CLASS}`);
   
       if (!toast) {
         toast = document.createElement("div");
         toast.className = TOAST_CLASS;
         document.body.appendChild(toast);
       }
   
       // Reset any active fade so the toast is fully visible again
       toast.style.opacity  = "1";
       toast.style.display  = "flex";
       toast.textContent    = message;
   
       // Cancel previous timer before setting a new one
       if (_toastTimer !== null) {
         clearTimeout(_toastTimer);
       }
   
       _toastTimer = setTimeout(() => {
         toast.style.opacity = "0";
         // Remove from DOM after CSS transition completes (400 ms)
         setTimeout(() => { toast.style.display = "none"; }, 400);
         _toastTimer = null;
       }, TOAST_DURATION_MS);
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — CORE HANDLER
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Creates and returns an event handler for the given config entry.
      * Stored by reference so the same function can be passed to both
      * addEventListener and removeEventListener.
      *
      * Handler logic per event:
      *   1. Check if the event should be allowed (editor copy/cut exception).
      *   2. preventDefault() + stopPropagation() — always, even if debounced.
      *   3. Update blocked stats.
      *   4. Check module cooldown.
      *   5. Check interview termination state.
      *   6. Register violation + update violation stats.
      *   7. Show toast.
      *   8. Log to console.
      *
      * @param {object} cfg  One entry from WATCHED_EVENTS.
      * @returns {Function}
      */
     function _makeHandler(cfg) {
       return function _handler(evt) {
   
         // ── Editor exception: allow copy/cut from the code editor ─────
         if (!cfg.blockFromEditor && _fromEditor(evt)) {
           console.debug(
             `[ClipboardMonitor] Allowed ${cfg.type} from code editor.`
           );
           return; // do NOT preventDefault — let the action proceed
         }
   
         // ── Block the clipboard / menu action ─────────────────────────
         evt.preventDefault();
         evt.stopPropagation();
   
         _stats.totalBlocked++;
         _stats.byType[cfg.type].blocked++;
   
         // ── Module cooldown ───────────────────────────────────────────
         if (!_cooldownExpired(cfg.type)) {
           const remaining = Math.ceil(
             (COOLDOWN_MS - (Date.now() - _lastAccepted.get(cfg.type))) / 1000
           );
           console.debug(
             `[ClipboardMonitor] ${cfg.type} blocked (cooldown: ${remaining}s remaining).`
           );
           // Still show toast on every block even while debounced
           _showToast(cfg.toastMsg);
           return;
         }
   
         // ── Termination guard ─────────────────────────────────────────
         if (window.ViolationManager?.isTerminated()) {
           console.debug(
             `[ClipboardMonitor] Interview terminated — ${cfg.type} blocked silently.`
           );
           return;
         }
   
         // ── Register violation ────────────────────────────────────────
         const registerFn = _getRegisterFn();
         if (!registerFn) {
           console.error(
             "[ClipboardMonitor] registerViolation not available — " +
             "ensure violationManager.js loads first."
           );
         } else {
           _lastAccepted.set(cfg.type, Date.now());
           _stats.totalViolations++;
           _stats.byType[cfg.type].violations++;
   
           registerFn(cfg.reason, cfg.severity);
         }
   
         // ── Toast ─────────────────────────────────────────────────────
         _showToast(cfg.toastMsg);
   
         // ── Console ───────────────────────────────────────────────────
         const colours = { LOW: "#8b949e", MEDIUM: "#d29922", HIGH: "#f85149" };
         console.warn(
           `%c[ClipboardMonitor] ${_now()} — ${cfg.type.toUpperCase()} blocked. ` +
           `Violation: "${cfg.reason}"`,
           `color:${colours[cfg.severity] || "#8b949e"};font-family:monospace;font-weight:600`
         );
       };
     }
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — LISTENER REGISTRY
        Handlers are built once and stored here so stop() can remove
        the exact same function references.
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Map of event type → {config, handler}.
      * Populated by start(), cleared by stop().
      * @type {Map<string, {cfg: object, fn: Function}>}
      */
     const _listeners = new Map();
   
     /* ══════════════════════════════════════════════════════════════
        PRIVATE — TOAST CSS INJECTION
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Injects the toast stylesheet into <head> once.
      * Keeps all styles co-located with the module that uses them.
      */
     function _injectToastStyles() {
       const STYLE_ID = "clipboard-monitor-styles";
       if (document.getElementById(STYLE_ID)) return; // already injected
   
       const style = document.createElement("style");
       style.id = STYLE_ID;
       style.textContent = `
         .${TOAST_CLASS} {
           display: none;
           position: fixed;
           top: 60px;
           left: 50%;
           transform: translateX(-50%);
           z-index: 9999;
           align-items: center;
           gap: 8px;
           padding: 10px 20px;
           background: rgba(13, 17, 23, 0.95);
           border: 1px solid rgba(248, 81, 73, 0.45);
           border-radius: 8px;
           box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
           font-family: 'JetBrains Mono', 'Courier New', monospace;
           font-size: 0.75rem;
           font-weight: 600;
           color: #f85149;
           letter-spacing: 0.03em;
           white-space: nowrap;
           pointer-events: none;
           user-select: none;
           transition: opacity 0.4s ease;
           opacity: 1;
         }
       `;
       document.head.appendChild(style);
     }
   
     /* ══════════════════════════════════════════════════════════════
        PUBLIC API
        ══════════════════════════════════════════════════════════════ */
   
     /**
      * Attaches all clipboard and context-menu event listeners to document.
      * Safe to call multiple times — subsequent calls are no-ops.
      *
      * capture: true is used so the handler intercepts the event before
      * any element-level listeners (e.g. a rich text editor) can process it.
      *
      * @returns {boolean}  true if monitoring started, false if already active.
      */
     function start() {
       if (_active) {
         console.warn("[ClipboardMonitor] Already active — start() ignored.");
         return false;
       }
   
       _injectToastStyles();
   
       for (const cfg of WATCHED_EVENTS) {
         const fn = _makeHandler(cfg);
         _listeners.set(cfg.type, { cfg, fn });
         // capture:true ensures we intercept before any bubbling handlers
         document.addEventListener(cfg.type, fn, { capture: true });
       }
   
       _active = true;
   
       console.log(
         `%c[ClipboardMonitor] Started — monitoring: ${WATCHED_EVENTS.map(e => e.type).join(", ")} | ` +
         `cooldown: ${COOLDOWN_MS}ms`,
         "color:#3fb950;font-family:monospace"
       );
   
       return true;
     }
   
     /**
      * Removes all event listeners and deactivates monitoring.
      * The toast element (if present) is also removed from the DOM.
      *
      * @returns {boolean}  true if monitoring was stopped, false if already inactive.
      */
     function stop() {
       if (!_active) {
         console.warn("[ClipboardMonitor] Not active — stop() ignored.");
         return false;
       }
   
       for (const [type, { fn }] of _listeners) {
         document.removeEventListener(type, fn, { capture: true });
       }
       _listeners.clear();
   
       // Remove toast from DOM
       const toast = document.querySelector(`.${TOAST_CLASS}`);
       if (toast) toast.remove();
       if (_toastTimer !== null) { clearTimeout(_toastTimer); _toastTimer = null; }
   
       _active = false;
       console.log("[ClipboardMonitor] Stopped — all listeners removed.");
       return true;
     }
   
     /**
      * Returns a read-only snapshot of session statistics.
      *
      * @returns {{
      *   active:          boolean,
      *   totalBlocked:    number,
      *   totalViolations: number,
      *   byType: {
      *     copy:        { blocked: number, violations: number },
      *     cut:         { blocked: number, violations: number },
      *     paste:       { blocked: number, violations: number },
      *     contextmenu: { blocked: number, violations: number },
      *   },
      *   cooldownMs: number,
      * }}
      */
     function getStats() {
       return {
         active:          _active,
         totalBlocked:    _stats.totalBlocked,
         totalViolations: _stats.totalViolations,
         byType: {
           copy:        { ..._stats.byType.copy        },
           cut:         { ..._stats.byType.cut         },
           paste:       { ..._stats.byType.paste       },
           contextmenu: { ..._stats.byType.contextmenu },
         },
         cooldownMs:      COOLDOWN_MS,
       };
     }
   
     /* ── Return public surface ─────────────────────────────────── */
     return { start, stop, getStats };
   
   })(); // end ClipboardMonitor IIFE
   
   
   /* ══════════════════════════════════════════════════════════════
      NAMED EXPORT
      ══════════════════════════════════════════════════════════════ */
   
   /**
    * startClipboardMonitoring()
    * ──────────────────────────
    * Convenience wrapper matching the naming convention of the
    * other monitoring modules (startTabMonitoring, etc.).
    *
    * @returns {object}  The ClipboardMonitor object (for testing / stop()).
    *
    * @example
    *   // In script.js DOMContentLoaded:
    *   startClipboardMonitoring();
    *
    *   // Or with a reference for later cleanup:
    *   const cm = startClipboardMonitoring();
    *   cm.stop();
    */
   function startClipboardMonitoring() {
     ClipboardMonitor.start();
     return ClipboardMonitor;
   }
   
   /* ── Global aliases ──────────────────────────────────────────── */
   window.ClipboardMonitor         = ClipboardMonitor;
   window.startClipboardMonitoring = startClipboardMonitoring;
   
   console.log(
     "%c[ClipboardMonitor] Module loaded — call startClipboardMonitoring() to activate.",
     "color:#8b949e;font-family:monospace"
   );