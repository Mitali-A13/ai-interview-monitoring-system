"use strict";

const TabMonitor = (function () {

  const TAB_COOLDOWN_MS = 5_000;
  const INTENT_DELAY_MS = 300;
  const REASON = "Tab switch detected";
  const SEVERITY_KEY = "MEDIUM";

  let _active = false;
  let _lastViolationAt = 0;
  let _intentTimer = null;

  const _stats = {
    totalLeaves: 0,
    totalViolations: 0,
    totalReturns: 0,
    lastLeftAt: null,
    lastReturnedAt: null,
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
    const hidden = document.visibilityState === "hidden";
    const unfocused = typeof document.hasFocus === "function" && !document.hasFocus();
    return hidden || unfocused;
  }

  function _cooldownExpired() {
    return (Date.now() - _lastViolationAt) >= TAB_COOLDOWN_MS;
  }

  function _fmt(date = new Date()) {
    return [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map(n => String(n).padStart(2, "0"))
      .join(":");
  }

  function _confirmAndRegister() {
    _intentTimer = null;

    if (!_candidateIsAway()) {
      console.debug("[TabMonitor] Candidate returned before intent timer fired — no violation.");
      return;
    }

    if (!_cooldownExpired()) {
      const remaining = Math.ceil((TAB_COOLDOWN_MS - (Date.now() - _lastViolationAt)) / 1000);
      console.debug(`[TabMonitor] Cooldown active — ${remaining}s remaining, violation suppressed.`);
      return;
    }

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

    if (_intentTimer !== null) {
      clearTimeout(_intentTimer);
    }

    _intentTimer = setTimeout(_confirmAndRegister, INTENT_DELAY_MS);
  }

  function _onReturn(source) {
    _stats.totalReturns++;
    _stats.lastReturnedAt = new Date();

    const away = Date.now() - (_stats.lastLeftAt?.getTime() ?? Date.now());

    if (_intentTimer !== null) {
      clearTimeout(_intentTimer);
      _intentTimer = null;
      console.debug(`[TabMonitor] Returned via ${source} after ${away}ms — intent timer cancelled.`);
    } else {
      console.debug(`[TabMonitor] Returned via ${source} after ${away}ms.`);
    }
  }

  function _handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      _onLeave("visibility");
    } else {
      _onReturn("visibility");
    }
  }

  function _handleBlur() {
    if (document.visibilityState === "visible") {
      _onLeave("blur");
    }
  }

  function _handleFocus() {
    if (document.visibilityState === "visible") {
      _onReturn("focus");
    }
  }

  function start() {
    if (_active) {
      console.warn("[TabMonitor] Already active — start() ignored.");
      return false;
    }

    document.addEventListener("visibilitychange", _handleVisibilityChange);
    window.addEventListener("blur", _handleBlur);
    window.addEventListener("focus", _handleFocus);

    _active = true;

    console.log(
      `%c[TabMonitor] Started — cooldown: ${TAB_COOLDOWN_MS}ms | intent delay: ${INTENT_DELAY_MS}ms`,
      "color:#3fb950;font-family:monospace"
    );

    if (document.visibilityState === "hidden") {
      console.warn("[TabMonitor] Page loaded in hidden state — registering immediate violation.");
      _onLeave("visibility (load)");
    }

    return true;
  }

  function stop() {
    if (!_active) {
      console.warn("[TabMonitor] Not active — stop() ignored.");
      return false;
    }

    document.removeEventListener("visibilitychange", _handleVisibilityChange);
    window.removeEventListener("blur", _handleBlur);
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
      active: _active,
      totalLeaves: _stats.totalLeaves,
      totalViolations: _stats.totalViolations,
      totalReturns: _stats.totalReturns,
      lastLeftAt: _stats.lastLeftAt,
      lastReturnedAt: _stats.lastReturnedAt,
      cooldownMs: TAB_COOLDOWN_MS,
      intentDelayMs: INTENT_DELAY_MS,
    };
  }

  return { start, stop, getStats };

})();

function startTabMonitoring() {
  TabMonitor.start();
  return TabMonitor;
}

window.TabMonitor = TabMonitor;
window.startTabMonitoring = startTabMonitoring;

console.log(
  "%c[TabMonitor] Module loaded — call startTabMonitoring() to activate.",
  "color:#8b949e;font-family:monospace"
);