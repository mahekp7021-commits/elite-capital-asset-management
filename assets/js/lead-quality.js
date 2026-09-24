/* ECAM Mobile Quality Engine - non-blocking client signals */
(function () {
  "use strict";

  const SESSION_KEY = "ecam_lead_session_v1";
  const START_KEY = "ecam_form_start_v1";

  function getSessionId() {
    try {
      const existing = localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      const id =
        (window.crypto && typeof window.crypto.randomUUID === "function")
          ? window.crypto.randomUUID()
          : "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      localStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (_) {
      return "sess_" + Date.now();
    }
  }

  function getStartTime() {
    try {
      const existing = localStorage.getItem(START_KEY);
      if (existing) return Number(existing);
      const t = Date.now();
      localStorage.setItem(START_KEY, String(t));
      return t;
    } catch (_) {
      return Date.now();
    }
  }

  function hidden(form, name) {
    let el = form.querySelector('[name="' + name + '"]');
    if (!el) {
      el = document.createElement("input");
      el.type = "hidden";
      el.name = name;
      form.appendChild(el);
    }
    return el;
  }

  function cleanMobile(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 10);
  }

  function browserFingerprint() {
    const payload = {
      userAgent: String(navigator.userAgent || "").slice(0, 350),
      language: navigator.language || "",
      platform: navigator.platform || "",
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || ""),
      screen: (screen.width || 0) + "x" + (screen.height || 0),
      colorDepth: screen.colorDepth || 0,
      cookies: navigator.cookieEnabled ? "1" : "0",
      referrer: document.referrer || ""
    };

    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).slice(0, 700);
    } catch (_) {
      return "";
    }
  }

  function syncSignals(form) {
    const mobile = form.elements.mobile;
    if (mobile) mobile.value = cleanMobile(mobile.value);

    const started = getStartTime();
    const duration = Math.max(0, Math.round((Date.now() - started) / 1000));

    hidden(form, "form_started_at").value = new Date(started).toISOString();
    hidden(form, "form_duration_sec").value = duration;
    hidden(form, "session_id").value = getSessionId();
    hidden(form, "browser_fingerprint").value = browserFingerprint();
    hidden(form, "mobile_e164").value = /^[6-9]\d{9}$/.test(mobile ? mobile.value : "")
      ? "+91" + mobile.value
      : "";
    hidden(form, "mobile_valid").value = /^[6-9]\d{9}$/.test(mobile ? mobile.value : "")
      ? "PASS"
      : "FAIL";
    hidden(form, "number_pattern").value = "PASS";
    hidden(form, "risk_ownership").value = "NOT_VERIFIED";
    hidden(form, "network_status").value = "NOT_CONFIGURED";
    hidden(form, "form_time").value = new Date().toISOString();
  }

  window.addEventListener("DOMContentLoaded", function () {
    const form = document.getElementById("leadForm");
    if (!form) return;

    getStartTime();
    syncSignals(form);

    const mobile = form.elements.mobile;
    if (mobile) {
      mobile.addEventListener("input", function () {
        mobile.value = cleanMobile(mobile.value);
        syncSignals(form);
      });
    }

    form.addEventListener("submit", function () {
      syncSignals(form);
    });
  });

  window.ECAMQualityEngine = {
    sync: syncSignals
  };
})();
