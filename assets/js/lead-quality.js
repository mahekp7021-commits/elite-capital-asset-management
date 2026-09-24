/* ECAM Mobile Quality Engine
 * Uses libphonenumber-js metadata derived from Google's libphonenumber metadata.
 * Network/HLR remains provider-driven; no private identity lookup is performed.
 */
(function () {
  "use strict";

  const SESSION_KEY = "ecam_lead_session_v1";
  const START_KEY = "ecam_form_start_v1";
  const PHONE_TRIES_KEY = "ecam_phone_tries_v1";

  const now = Date.now();
  const sessionId =
    localStorage.getItem(SESSION_KEY) ||
    (crypto.randomUUID ? crypto.randomUUID() : "sess_" + now + "_" + Math.random().toString(36).slice(2));
  localStorage.setItem(SESSION_KEY, sessionId);

  const startAt = Number(localStorage.getItem(START_KEY)) || now;
  localStorage.setItem(START_KEY, String(startAt));

  function hidden(name, value) {
    const form = document.getElementById("leadForm");
    if (!form) return null;
    let el = form.querySelector('[name="' + name + '"]');
    if (!el) {
      el = document.createElement("input");
      el.type = "hidden";
      el.name = name;
      form.appendChild(el);
    }
    el.value = value == null ? "" : String(value);
    return el;
  }

  function cleanDigits(value) {
    return String(value || "").replace(/\D/g, "").slice(0, 10);
  }

  function patternRisk(digits) {
    if (!/^\d{10}$/.test(digits)) return 25;

    if (/^(\d)\1{9}$/.test(digits)) return 25;

    const ascending = "0123456789";
    const descending = "9876543210";
    if (ascending.includes(digits) || descending.includes(digits)) return 25;

    const firstFive = digits.slice(0, 5);
    const lastFive = digits.slice(5);
    if (ascending.includes(firstFive) || descending.includes(firstFive) ||
        ascending.includes(lastFive) || descending.includes(lastFive)) return 18;

    if (/^(\d{2})\1{4}$/.test(digits) || /^(\d{3})\1\d$/.test(digits)) return 18;

    const unique = new Set(digits).size;
    if (unique <= 3) return 12;

    return 0;
  }

  function behaviouralSignals(digits) {
    const durationMs = Math.max(0, Date.now() - startAt);
    const durationSec = Math.round(durationMs / 1000);

    let behaviourScore = 25;
    const flags = [];

    if (durationSec < 7) {
      behaviourScore -= 10;
      flags.push("FORM_TOO_FAST");
    } else if (durationSec > 3600) {
      behaviourScore -= 2;
      flags.push("FORM_SESSION_LONG");
    }

    const tries = JSON.parse(localStorage.getItem(PHONE_TRIES_KEY) || "{}");
    const recent = (tries[digits] || []).filter(t => now - t < 24 * 60 * 60 * 1000);
    if (recent.length >= 2) {
      behaviourScore -= Math.min(10, recent.length * 2);
      flags.push("REPEATED_NUMBER_ATTEMPTS");
    }
    recent.push(now);
    tries[digits] = recent;
    try { localStorage.setItem(PHONE_TRIES_KEY, JSON.stringify(tries)); } catch (_) {}

    const ua = navigator.userAgent || "";
    if (/HeadlessChrome|PhantomJS|Selenium|Playwright|Puppeteer/i.test(ua)) {
      behaviourScore -= 15;
      flags.push("AUTOMATION_UA");
    }

    const honeypot = document.querySelector('[name="website"]');
    if (honeypot && honeypot.value.trim()) {
      behaviourScore -= 25;
      flags.push("HONEYPOT_TRIGGERED");
    }

    const browserSignals = {
      userAgent: ua.slice(0, 350),
      language: navigator.language || "",
      platform: navigator.platform || "",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      screen: (screen.width || 0) + "x" + (screen.height || 0),
      colorDepth: screen.colorDepth || 0,
      cookies: navigator.cookieEnabled ? "1" : "0",
      referrer: document.referrer || ""
    };

    return {
      score: Math.max(0, Math.min(25, behaviourScore)),
      durationMs,
      durationSec,
      flags,
      browserSignals
    };
  }

  function profileConsistency() {
    const form = document.getElementById("leadForm");
    if (!form) return { score: 0, flags: ["FORM_MISSING"] };

    const get = name => {
      const el = form.elements[name];
      return el ? String(el.value || "").trim() : "";
    };

    let score = 15;
    const flags = [];

    const name = get("name");
    const email = get("email");
    const city = get("city");
    const state = get("state");
    const experience = get("experience");
    const status = get("trader_status");

    if (name.length < 3) { score -= 4; flags.push("NAME_WEAK"); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { score -= 3; flags.push("EMAIL_WEAK"); }
    if (city.length < 2 || state.length < 2) { score -= 3; flags.push("LOCATION_INCOMPLETE"); }

    if (experience.includes("New") && status === "Experienced Trader") {
      score -= 5;
      flags.push("EXPERIENCE_STATUS_MISMATCH");
    }
    if (status === "Not Trading Yet" && experience === "More than 3 Years") {
      score -= 3;
      flags.push("STATUS_EXPERIENCE_MISMATCH");
    }

    return { score: Math.max(0, score), flags };
  }

  function band(score) {
    if (score >= 85) return "HIGH";
    if (score >= 60) return "REVIEW";
    return "SUSPICIOUS";
  }

  async function enrichNetworkSignals() {
    // Public-IP enrichment is best-effort. It is a signal only, not proof of identity.
    let ip = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1800);
      const response = await fetch("https://api64.ipify.org?format=json", {
        signal: controller.signal,
        cache: "no-store"
      });
      clearTimeout(timer);
      if (response.ok) ip = (await response.json()).ip || "";
    } catch (_) {}

    hidden("client_ip", ip);
    hidden("network_status", "NOT_CONFIGURED");
    hidden("carrier", "");
    hidden("porting_status", "");
    return { ip, score: 10, status: "NOT_CONFIGURED" };
  }

  async function prepareQuality() {
    const form = document.getElementById("leadForm");
    const mobileField = document.getElementById("mobileField");
    if (!form || !mobileField) return { valid: false };

    const raw = cleanDigits(mobileField.value);
    mobileField.value = raw;

    const result = {
      valid: false,
      type: "UNKNOWN",
      e164: "",
      flags: [],
      score: 0
    };

    try {
      const api = window.libphonenumber;
      if (!api || typeof api.parsePhoneNumberFromString !== "function") {
        result.flags.push("PHONE_LIBRARY_UNAVAILABLE");
      } else {
        const phone = api.parsePhoneNumberFromString(raw, "IN");
        if (phone) {
          result.valid = phone.isValid();
          result.e164 = phone.number || "";
          result.type = typeof phone.getType === "function" ? (phone.getType() || "UNKNOWN") : "UNKNOWN";
          if (phone.country !== "IN") result.valid = false;
          if (result.type === "FIXED_LINE") result.flags.push("LANDLINE_TYPE");
          if (result.type === "VOIP") result.flags.push("VOIP_TYPE");
        }
      }
    } catch (_) {
      result.flags.push("PHONE_PARSE_ERROR");
    }

    const patternPoints = patternRisk(raw);
    if (patternPoints > 0) result.flags.push("SUSPICIOUS_PATTERN");

    const behaviour = behaviouralSignals(raw);
    const identity = profileConsistency();
    const network = await enrichNetworkSignals();

    // Historical reputation is intentionally neutral on first pass;
    // server-side history can add/subtract this layer later.
    const historicalScore = 7.5;

    let layer1 = result.valid ? 25 : 0;
    if (result.valid && ["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(result.type)) layer1 += 0;
    layer1 = Math.max(0, layer1 - patternPoints);

    const layer2 = network.score;
    const layer3 = behaviour.score;
    const layer4 = identity.score;
    const layer5 = historicalScore;

    const total = Math.max(0, Math.min(100, Math.round(layer1 + layer2 + layer3 + layer4 + layer5)));

    hidden("mobile_e164", result.e164);
    hidden("mobile_type", result.type);
    hidden("mobile_valid", result.valid ? "PASS" : "FAIL");
    hidden("number_pattern", patternPoints ? "SUSPICIOUS" : "PASS");
    hidden("quality_score", total);
    hidden("quality_band", band(total));
    hidden("quality_flags", [...result.flags, ...behaviour.flags, ...identity.flags].join(","));
    hidden("form_duration_sec", behaviour.durationSec);
    hidden("session_id", sessionId);
    hidden("browser_fingerprint", btoa(unescape(encodeURIComponent(JSON.stringify(behaviour.browserSignals)))).slice(0, 700));
    hidden("network_status", network.status);
    hidden("risk_ownership", "NOT_VERIFIED");
    hidden("mobile_quality", total + " | " + band(total) + " | OWNERSHIP NOT VERIFIED");
    hidden("form_time", new Date().toISOString());

    return {
      ...result,
      layer1, layer2, layer3, layer4, layer5,
      score: total,
      band: band(total),
      durationSec: behaviour.durationSec,
      flags: [...result.flags, ...behaviour.flags, ...identity.flags]
    };
  }

  window.ECAMQualityEngine = { prepareQuality };

  document.addEventListener("DOMContentLoaded", function () {
    const form = document.getElementById("leadForm");
    if (!form) return;

    const mobileField = document.getElementById("mobileField");
    if (mobileField) {
      mobileField.addEventListener("input", function () {
        mobileField.value = cleanDigits(mobileField.value);
      });
    }

    form.addEventListener("submit", async function (event) {
      if (form.dataset.ecamQualityReady === "1") {
        form.dataset.ecamQualityReady = "0";
        return;
      }

      event.preventDefault();

      const result = await prepareQuality();

      if (!result.valid) {
        alert("Please enter a valid Indian mobile number.");
        return;
      }

      if (result.flags.includes("LANDLINE_TYPE") || result.flags.includes("VOIP_TYPE")) {
        alert("Please enter an Indian mobile number.");
        return;
      }

      form.dataset.ecamQualityReady = "1";
      HTMLFormElement.prototype.submit.call(form);
    }, true);
  });
})();
