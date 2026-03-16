"use strict";

const ClipboardMonitor = (function () {

  const COOLDOWN_MS = 4_000;
  const TOAST_DURATION_MS = 2_500;
  const CODE_EDITOR_ID = "codeEditor";
  const TOAST_CLASS = "clipboard-toast";

  const WATCHED_EVENTS = [
    {
      type:            "copy",
      reason:          "Clipboard copy attempt",
      severity:        "MEDIUM",
      blockFromEditor: false,
      toastMsg:        "⛔  Copying is not allowed during the interview.",
    },
    {
      type:            "cut",
      reason:          "Clipboard cut attempt",
      severity:        "MEDIUM",
      blockFromEditor: false,
      toastMsg:        "⛔  Cutting is not allowed during the interview.",
    },
    {
      type:            "paste",
      reason:          "Clipboard paste attempt",
      severity:        "HIGH",
      blockFromEditor: true,
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

  let _active = false;
  const _lastAccepted = new Map();
  const _listeners = new Map();
  let _toastTimer = null;

  const _stats = {
    totalBlocked: 0,
    totalViolations: 0,
    byType: {
      copy:        { blocked: 0, violations: 0 },
      cut:         { blocked: 0, violations: 0 },
      paste:       { blocked: 0, violations: 0 },
      contextmenu: { blocked: 0, violations: 0 },
    },
  };

  function _getRegisterFn() {
    if (window.ViolationManager?.registerViolation) {
      return window.ViolationManager.registerViolation;
    }
    if (typeof window.registerViolation === "function") {
      return window.registerViolation;
    }
    return null;
  }

  function _fromEditor(evt) {
    const editorEl = document.getElementById(CODE_EDITOR_ID);
    return editorEl !== null && (evt.target === editorEl || editorEl.contains(evt.target));
  }

  function _cooldownExpired(type) {
    if (!_lastAccepted.has(type)) return true;
    return (Date.now() - _lastAccepted.get(type)) >= COOLDOWN_MS;
  }

  function _now() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, "0"))
      .join(":");
  }

  function _showToast(message) {
    let toast = document.querySelector(`.${TOAST_CLASS}`);

    if (!toast) {
      toast = document.createElement("div");
      toast.className = TOAST_CLASS;
      document.body.appendChild(toast);
    }

    toast.style.opacity = "1";
    toast.style.display = "flex";
    toast.textContent = message;

    if (_toastTimer !== null) {
      clearTimeout(_toastTimer);
    }

    _toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => { toast.style.display = "none"; }, 400);
      _toastTimer = null;
    }, TOAST_DURATION_MS);
  }

  function _makeHandler(cfg) {
    return function _handler(evt) {
      if (!cfg.blockFromEditor && _fromEditor(evt)) {
        console.debug(`[ClipboardMonitor] Allowed ${cfg.type} from code editor.`);
        return;
      }

      evt.preventDefault();
      evt.stopPropagation();

      _stats.totalBlocked++;
      _stats.byType[cfg.type].blocked++;

      if (!_cooldownExpired(cfg.type)) {
        const remaining = Math.ceil(
          (COOLDOWN_MS - (Date.now() - _lastAccepted.get(cfg.type))) / 1000
        );
        console.debug(`[ClipboardMonitor] ${cfg.type} blocked (cooldown: ${remaining}s remaining).`);
        _showToast(cfg.toastMsg);
        return;
      }

      if (window.ViolationManager?.isTerminated()) {
        console.debug(`[ClipboardMonitor] Interview terminated — ${cfg.type} blocked silently.`);
        return;
      }

      const registerFn = _getRegisterFn();
      if (!registerFn) {
        console.error(
          "[ClipboardMonitor] registerViolation not available — ensure violationManager.js loads first."
        );
      } else {
        _lastAccepted.set(cfg.type, Date.now());
        _stats.totalViolations++;
        _stats.byType[cfg.type].violations++;
        registerFn(cfg.reason, cfg.severity);
      }

      _showToast(cfg.toastMsg);

      const colours = { LOW: "#8b949e", MEDIUM: "#d29922", HIGH: "#f85149" };
      console.warn(
        `%c[ClipboardMonitor] ${_now()} — ${cfg.type.toUpperCase()} blocked. Violation: "${cfg.reason}"`,
        `color:${colours[cfg.severity] || "#8b949e"};font-family:monospace;font-weight:600`
      );
    };
  }

  function _injectToastStyles() {
    const STYLE_ID = "clipboard-monitor-styles";
    if (document.getElementById(STYLE_ID)) return;

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

  function start() {
    if (_active) {
      console.warn("[ClipboardMonitor] Already active — start() ignored.");
      return false;
    }

    _injectToastStyles();

    for (const cfg of WATCHED_EVENTS) {
      const fn = _makeHandler(cfg);
      _listeners.set(cfg.type, { cfg, fn });
      document.addEventListener(cfg.type, fn, { capture: true });
    }

    _active = true;

    console.log(
      `%c[ClipboardMonitor] Started — monitoring: ${WATCHED_EVENTS.map(e => e.type).join(", ")} | cooldown: ${COOLDOWN_MS}ms`,
      "color:#3fb950;font-family:monospace"
    );

    return true;
  }

  function stop() {
    if (!_active) {
      console.warn("[ClipboardMonitor] Not active — stop() ignored.");
      return false;
    }

    for (const [type, { fn }] of _listeners) {
      document.removeEventListener(type, fn, { capture: true });
    }
    _listeners.clear();

    const toast = document.querySelector(`.${TOAST_CLASS}`);
    if (toast) toast.remove();
    if (_toastTimer !== null) { clearTimeout(_toastTimer); _toastTimer = null; }

    _active = false;
    console.log("[ClipboardMonitor] Stopped — all listeners removed.");
    return true;
  }

  function getStats() {
    return {
      active: _active,
      totalBlocked: _stats.totalBlocked,
      totalViolations: _stats.totalViolations,
      byType: {
        copy:        { ..._stats.byType.copy },
        cut:         { ..._stats.byType.cut },
        paste:       { ..._stats.byType.paste },
        contextmenu: { ..._stats.byType.contextmenu },
      },
      cooldownMs: COOLDOWN_MS,
    };
  }

  return { start, stop, getStats };

})();

function startClipboardMonitoring() {
  ClipboardMonitor.start();
  return ClipboardMonitor;
}

window.ClipboardMonitor = ClipboardMonitor;
window.startClipboardMonitoring = startClipboardMonitoring;

console.log(
  "%c[ClipboardMonitor] Module loaded — call startClipboardMonitoring() to activate.",
  "color:#8b949e;font-family:monospace"
);