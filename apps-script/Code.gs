/**
 * ECAM Lead Quality Engine — Google Apps Script backend
 *
 * Existing sheet: Sheet1
 * Existing columns are preserved. New quality columns are appended automatically.
 *
 * Optional HLR/network provider:
 *   Script Properties:
 *     HLR_ENDPOINT = https://provider.example/lookup
 *     HLR_API_KEY  = your-secret-key
 *
 * Expected provider response shape (adapter can be changed in lookupNetwork_):
 *   {
 *     "status": "LIVE|UNREACHABLE|INVALID|UNKNOWN",
 *     "carrier": "Carrier name",
 *     "line_type": "MOBILE|VOIP|FIXED|UNKNOWN",
 *     "ported": true|false
 *   }
 *
 * Do not use a provider to infer a person's private identity or ownership.
 */

const SHEET_NAME = "Sheet1";
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const EXTRA_HEADERS = [
  "Mobile E164",
  "Mobile Type",
  "Mobile Valid",
  "Number Pattern",
  "Quality Score",
  "Quality Band",
  "Quality Flags",
  "Form Duration Sec",
  "Session ID",
  "Browser Fingerprint",
  "Client IP",
  "Network Status",
  "Carrier",
  "Porting Status",
  "Ownership Status",
  "Duplicate 24H",
  "Prior Leads",
  "Historical Score",
  "Behavior Score",
  "Identity Consistency Score"
];

function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("Sheet1 not found");

    const data = e.parameter || {};
    ensureHeaders_(sheet);

    const mobile = normalizeIndianMobile_(data.mobile);
    if (!mobile) {
      return json_({ success: false, error: "Invalid Indian mobile number." });
    }

    // Honeypot: reject silently.
    if (String(data.website || "").trim()) {
      return json_({ success: false, error: "Rejected." });
    }

    const now = new Date();
    const history = getMobileHistory_(sheet, mobile);

    const duplicate24h = history.recentCount > 0;
    const priorLeads = history.totalCount;

    const network = lookupNetwork_(mobile);

    const quality = calculateServerScore_({
      mobile,
      data,
      duplicate24h,
      priorLeads,
      network
    });

    const row = buildRow_(sheet, data, mobile, now, history, network, quality);
    sheet.appendRow(row);

    return json_({
      success: true,
      message: "Lead saved successfully",
      quality_score: quality.score,
      quality_band: quality.band,
      ownership_status: "NOT_VERIFIED"
    });

  } catch (error) {
    return json_({
      success: false,
      error: String(error && error.stack ? error.stack : error)
    });
  }
}

function ensureHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(String)
    .map(s => s.trim());

  EXTRA_HEADERS.forEach(function(header) {
    if (existing.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      existing.push(header);
    }
  });
}

function normalizeIndianMobile_(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  if (digits.length === 12 && /^91[6-9]\d{9}$/.test(digits)) return digits.slice(2);
  return "";
}

function getMobileHistory_(sheet, mobile) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return { totalCount: 0, recentCount: 0, cleanCount: 0, suspiciousCount: 0 };
  }

  const headers = values[0].map(String);
  const mobileCol = headers.indexOf("Mobile");
  const dateCol = headers.indexOf("Date");
  const qualityCol = headers.indexOf("Quality Band");

  let totalCount = 0;
  let recentCount = 0;
  let cleanCount = 0;
  let suspiciousCount = 0;
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;

  for (let i = 1; i < values.length; i++) {
    const rowMobile = normalizeIndianMobile_(values[i][mobileCol]);
    if (!rowMobile || rowMobile !== mobile) continue;

    totalCount++;

    const d = dateCol >= 0 ? values[i][dateCol] : "";
    const dt = d instanceof Date ? d.getTime() : Date.parse(d);
    if (dt && dt >= cutoff) recentCount++;

    if (qualityCol >= 0) {
      const band = String(values[i][qualityCol] || "").toUpperCase();
      if (band === "HIGH") cleanCount++;
      if (band === "SUSPICIOUS") suspiciousCount++;
    }
  }

  return { totalCount, recentCount, cleanCount, suspiciousCount };
}

function lookupNetwork_(mobile) {
  const props = PropertiesService.getScriptProperties();
  const endpoint = String(props.getProperty("HLR_ENDPOINT") || "").trim();
  const apiKey = String(props.getProperty("HLR_API_KEY") || "").trim();

  if (!endpoint || !apiKey) {
    return {
      configured: false,
      status: "NOT_CONFIGURED",
      carrier: "",
      lineType: "",
      ported: ""
    };
  }

  try {
    const url = endpoint + (endpoint.indexOf("?") >= 0 ? "&" : "?") +
      "number=" + encodeURIComponent("+91" + mobile);

    const response = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      headers: {
        Authorization: "Bearer " + apiKey
      }
    });

    const text = response.getContentText();
    const obj = JSON.parse(text);

    return {
      configured: true,
      status: String(obj.status || obj.reachability || "UNKNOWN").toUpperCase(),
      carrier: String(obj.carrier || obj.operator || ""),
      lineType: String(obj.line_type || obj.type || "").toUpperCase(),
      ported: obj.ported === true ? "PORTED" : (obj.ported === false ? "NOT_PORTED" : "")
    };
  } catch (err) {
    return {
      configured: true,
      status: "LOOKUP_ERROR",
      carrier: "",
      lineType: "",
      ported: ""
    };
  }
}

function calculateServerScore_(ctx) {
  let score = 0;
  const flags = [];

  // Layer 1 — Number authenticity (25)
  const valid = /^[6-9]\d{9}$/.test(ctx.mobile) && ctx.mobile.length === 10;
  let l1 = valid ? 25 : 0;

  if (/^(\d)\1{9}$/.test(ctx.mobile) ||
      "0123456789".indexOf(ctx.mobile) >= 0 ||
      "9876543210".indexOf(ctx.mobile) >= 0) {
    l1 = 0;
    flags.push("SUSPICIOUS_PATTERN");
  }

  if (String(ctx.data.mobile_type || "").toUpperCase() === "VOIP") {
    l1 = Math.max(0, l1 - 12);
    flags.push("VOIP_TYPE");
  }

  if (String(ctx.data.mobile_valid || "").toUpperCase() === "FAIL") {
    l1 = Math.min(l1, 5);
    flags.push("CLIENT_VALIDATION_FAIL");
  }

  // Layer 2 — Network intelligence (20)
  let l2 = 10;
  if (ctx.network.configured) {
    if (ctx.network.status === "LIVE" || ctx.network.status === "ACTIVE") l2 = 20;
    else if (ctx.network.status === "UNREACHABLE") l2 = 8;
    else if (ctx.network.status === "INVALID") l2 = 0;
    else l2 = 10;

    if (ctx.network.lineType === "VOIP") {
      l2 = Math.max(0, l2 - 8);
      flags.push("NETWORK_VOIP");
    }
  }

  // Layer 3 — Behaviour (25)
  let l3 = 25;
  const seconds = Math.max(0, Number(ctx.data.form_duration_sec || 0));
  if (seconds > 0 && seconds < 7) {
    l3 -= 10;
    flags.push("FORM_TOO_FAST");
  }
  if (ctx.duplicate24h) {
    l3 -= 8;
    flags.push("DUPLICATE_24H");
  }

  const browser = String(ctx.data.browser_fingerprint || "");
  if (/HeadlessChrome|PhantomJS|Selenium|Playwright|Puppeteer/i.test(browser)) {
    l3 -= 15;
    flags.push("AUTOMATION_SIGNAL");
  }

  // Layer 4 — Consistency (15)
  let l4 = 15;
  const name = String(ctx.data.name || "").trim();
  const email = String(ctx.data.email || "").trim();
  const city = String(ctx.data.city || "").trim();
  const state = String(ctx.data.state || "").trim();
  const experience = String(ctx.data.experience || "");
  const traderStatus = String(ctx.data.trader_status || "");

  if (name.length < 3) { l4 -= 4; flags.push("NAME_WEAK"); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { l4 -= 3; flags.push("EMAIL_WEAK"); }
  if (city.length < 2 || state.length < 2) { l4 -= 3; flags.push("LOCATION_INCOMPLETE"); }
  if (experience.indexOf("New") >= 0 && traderStatus === "Experienced Trader") {
    l4 -= 5;
    flags.push("EXPERIENCE_STATUS_MISMATCH");
  }

  // Layer 5 — Historical ECAM reputation (15)
  let l5 = 7;
  if (ctx.priorLeads === 0) {
    l5 = 7;
  } else if (ctx.suspiciousCount === 0 && ctx.cleanCount > 0 && !ctx.duplicate24h) {
    l5 = 15;
  } else if (ctx.suspiciousCount > 0 || ctx.duplicate24h) {
    l5 = 2;
  } else {
    l5 = 9;
  }

  score = Math.max(0, Math.min(100, Math.round(l1 + l2 + l3 + l4 + l5)));

  return {
    score: score,
    band: score >= 85 ? "HIGH" : (score >= 60 ? "REVIEW" : "SUSPICIOUS"),
    flags: flags,
    layer1: l1,
    layer2: l2,
    layer3: Math.max(0, l3),
    layer4: Math.max(0, l4),
    layer5: l5
  };
}

function buildRow_(sheet, data, mobile, now, history, network, quality) {
  const base = {
    "Date": now,
    "Name": data.name || "",
    "Email": data.email || "",
    "Mobile": mobile,
    "City": data.city || "",
    "State": data.state || "",
    "Experience": data.experience || "",
    "Trader Status": data.trader_status || "",
    "Loss Experience": data.loss_experience || "",
    "Loss Segment": data.loss_segment || "",
    "Trading Capital": data.fund_to_trade || "",
    "Topic": data.topic || "",
    "Message": data.message || "",
    "Mobile Quality": quality.score + " | " + quality.band + " | OWNERSHIP NOT VERIFIED",
    "Form Time": data.form_time || now.toISOString(),

    "Mobile E164": data.mobile_e164 || "+91" + mobile,
    "Mobile Type": data.mobile_type || network.lineType || "UNKNOWN",
    "Mobile Valid": /^[6-9]\d{9}$/.test(mobile) ? "PASS" : "FAIL",
    "Number Pattern": data.number_pattern || "UNKNOWN",
    "Quality Score": quality.score,
    "Quality Band": quality.band,
    "Quality Flags": quality.flags.join(","),
    "Form Duration Sec": data.form_duration_sec || "",
    "Session ID": data.session_id || "",
    "Browser Fingerprint": data.browser_fingerprint || "",
    "Client IP": data.client_ip || "",
    "Network Status": network.status || "NOT_CONFIGURED",
    "Carrier": network.carrier || "",
    "Porting Status": network.ported || "",
    "Ownership Status": "NOT_VERIFIED",
    "Duplicate 24H": history.recentCount > 0 ? "YES" : "NO",
    "Prior Leads": history.totalCount,
    "Historical Score": quality.layer5,
    "Behavior Score": quality.layer3,
    "Identity Consistency Score": quality.layer4
  };

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.map(function(h) {
    return Object.prototype.hasOwnProperty.call(base, h) ? base[h] : "";
  });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
