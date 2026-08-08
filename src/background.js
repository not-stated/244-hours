export const RUBRIC = [
  { id: "data_collected", label: "What data is collected" },
  { id: "sharing",        label: "Who it is shared with" },
  { id: "tracking",       label: "Whether you are tracked" },
  { id: "purposes",       label: "Why it is used" },
  { id: "retention",      label: "How long it is kept" },
  { id: "rights",         label: "Your rights & controls" }
];

const ERROR_LOG_KEY = "errorLog";
const ERROR_LOG_MAX = 50;

async function logError(stage, host, detail) {
  try {
    const { [ERROR_LOG_KEY]: log = [] } = await chrome.storage.local.get(ERROR_LOG_KEY);
    log.unshift({
      at: new Date().toISOString(),
      stage,
      host: host || "-",
      detail: String(detail == null ? "" : detail).slice(0, 400)
    });
    await chrome.storage.local.set({ [ERROR_LOG_KEY]: log.slice(0, ERROR_LOG_MAX) });
  } catch (_) {

  }
}

async function readErrorLog() {
  const { [ERROR_LOG_KEY]: log = [] } = await chrome.storage.local.get(ERROR_LOG_KEY);
  return log;
}

async function clearErrorLog() {
  await chrome.storage.local.remove(ERROR_LOG_KEY);
  return { ok: true };
}

const CRITERIA_IDS = RUBRIC.map(r => r.id);

const SYSTEM_PROMPT = `You are an adversarial privacy policy auditor acting for the USER, not the website.
Assess the supplied policy text against exactly these six criteria, in this order:
data_collected, sharing, tracking, purposes, retention, rights.

Return ONLY a JSON object, no preamble, no markdown fences, with this exact shape:
{
  "criteria": [
    {
      "id": "data_collected",
      "state": "addressed" | "not_stated",
      "grade": "green" | "amber" | "red" | null,
      "confidence": "high" | "low",
      "summary": "one plain-English sentence, written critically",
      "clause": "VERBATIM excerpt from the policy" | null
    },
    ... one object per criterion, all six, in order ...
  ]
}

Rules:
- "clause" must be copied character-for-character from the supplied text. Do not paraphrase, do not fix typos, do not merge separate sentences. 40-400 characters.
- If you cannot quote a supporting clause, state is "not_stated", grade is null, clause is null.
- grade is null whenever state is "not_stated".
- NEVER reuse the policy's own marketing or reassuring language in the summary. Describe practices critically and concretely.
- Mark confidence "low" whenever the clause is ambiguous or your reading is an interpretation.
- Grading: green = clearly protective/minimal, amber = broad, vague or concerning, red = clearly hostile to the user (selling data, cross-site ad tracking, indefinite retention, waived rights).

MULTI-PART DOCUMENTS: long policies are supplied in parts. Each request tells you which part you are reading and includes your draft findings from earlier parts. Update the draft: replace a "not_stated" with evidence when this part supplies it, and worsen a grade when this part reveals worse practices, quoting clauses ONLY from text you have actually been shown. Add one top-level JSON field "needs_more": true if any criterion is still "not_stated" or "low" confidence AND a later part might resolve it; otherwise "needs_more": false.`;

export async function hashPolicyText(text) {
  const data = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function normalise(s) {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findPolicyLinkInPage() {
  const candidates = [...document.querySelectorAll("a[href]")]
    .map(a => ({ href: a.href, text: (a.textContent || "").toLowerCase() }))
    .filter(a => /privacy/.test(a.text) || /privacy/.test(a.href.toLowerCase()));

  candidates.sort((x, y) =>
    (/privacy (policy|notice|statement)/.test(y.text) ? 1 : 0) -
    (/privacy (policy|notice|statement)/.test(x.text) ? 1 : 0));
  return candidates[0]?.href ?? null;
}

async function discoverPolicyUrl(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: findPolicyLinkInPage
  });
  return result;
}

const PROVIDER_CHAR_BUDGET = { anthropic: 400000, openai: 250000, gemini: 200000, custom: 100000 };
const MAX_PARTS = 4;

async function fetchPolicyText(url) {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Policy fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { text, truncated: false };
}

function extractRenderedText() {
  return document.body ? document.body.innerText : "";
}

async function renderPolicyInTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error("render timeout")); }, 20000);
      function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") { cleanup(); resolve(); }
      }
      function cleanup() { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); }
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise(r => setTimeout(r, 2500));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractRenderedText
    });
    return (result || "").replace(/\s+/g, " ").trim();
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
  }
}

const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-4-6",
    request: ({ apiKey, model, system, user }) => ({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: { model, max_tokens: 4000, temperature: 0, system,
              messages: [{ role: "user", content: user }] }
    }),
    parse: data => (data.content || []).map(b => b.text || "").join("\n")
  },

  openai: {
    label: "OpenAI (GPT)",
    defaultModel: "gpt-4o",
    request: ({ apiKey, model, system, user }) => ({
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: { model, max_completion_tokens: 4000, temperature: 0,
              messages: [{ role: "system", content: system },
                         { role: "user", content: user }] }
    }),
    parse: data => data.choices?.[0]?.message?.content ?? ""
  },

  gemini: {
    label: "Google (Gemini)",
    defaultModel: "gemini-3.5-flash",
    request: ({ apiKey, model, system, user }) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4000,
                            responseMimeType: "application/json" }
      }
    }),
    parse: data => (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n")
  },

  custom: {
    label: "Custom (OpenAI-compatible)",
    defaultModel: "",
    request: ({ apiKey, model, system, user, baseUrl }) => ({
      url: `${(baseUrl || "").replace(/\/$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {})
      },
      body: { model, max_tokens: 4000, temperature: 0,
              messages: [{ role: "system", content: system },
                         { role: "user", content: user }] }
    }),
    parse: data => data.choices?.[0]?.message?.content ?? ""
  }
};

async function assessWithLLM(policyText, cfg) {
  const adapter = PROVIDERS[cfg.provider] ?? PROVIDERS.anthropic;
  const { url, headers, body } = adapter.request({
    apiKey: cfg.apiKey,
    model: cfg.model || adapter.defaultModel,
    baseUrl: cfg.baseUrl,
    system: SYSTEM_PROMPT,
    user: policyText
  });
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 429) throw new Error(
      `${adapter.label} rate limit reached. Free tiers cap requests and tokens per minute and per day. ` +
      `Wait a minute and press \u21BB. If it persists, the daily allowance is spent (Gemini's resets at 08:00 UK time).`);
    throw new Error(`${adapter.label} API error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = adapter.parse(data);
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

function validateSchema(out) {
  if (!out || !Array.isArray(out.criteria)) throw new Error("Schema: missing criteria array");
  const seen = new Set();
  for (const c of out.criteria) {
    if (!CRITERIA_IDS.includes(c.id)) throw new Error(`Schema: unknown criterion ${c.id}`);
    if (seen.has(c.id)) throw new Error(`Schema: duplicate criterion ${c.id}`);
    seen.add(c.id);
    if (!["addressed", "not_stated"].includes(c.state)) throw new Error(`Schema: bad state on ${c.id}`);
    if (c.state === "addressed" && !["green", "amber", "red"].includes(c.grade))
      throw new Error(`Schema: addressed without grade on ${c.id}`);
    if (c.state === "not_stated") { c.grade = null; c.clause = null; }
    if (typeof c.summary !== "string" || !c.summary) throw new Error(`Schema: missing summary on ${c.id}`);
  }
  if (seen.size !== CRITERIA_IDS.length) throw new Error("Schema: not all six criteria returned");
  if (typeof out.needs_more !== "boolean") out.needs_more = false;

  out.criteria.sort((a, b) => CRITERIA_IDS.indexOf(a.id) - CRITERIA_IDS.indexOf(b.id));
  return out;
}

function verifyClauses(assessment, policyText) {
  const haystack = normalise(policyText);
  let failures = 0;
  for (const c of assessment.criteria) {
    if (c.state !== "addressed") continue;
    if (!c.clause || !haystack.includes(normalise(c.clause))) {
      failures++;
      c.state = "not_stated";
      c.grade = null;
      c.confidence = "low";
      c.summary = "The AI's claimed evidence for this criterion could not be verified against the policy text, so no verdict is shown.";
      c.clause = null;
      c.verificationFailed = true;
    }
  }
  assessment.clauseVerification = {
    checked: assessment.criteria.length,
    failed: failures
  };
  return assessment;
}

function looksLikePolicyText(text) {
  if (!text || text.length < 800) return false;
  const signals = text.match(/privacy|personal (data|information)|data protection|cookies|lawful basis|controller/gi);
  return (signals?.length || 0) >= 5;
}

async function runAssessment(tabId, host, force = false, mode = "auto") {
  const { provider = "anthropic", providerConfigs = {} } =
    await chrome.storage.local.get(["provider", "providerConfigs"]);
  const cfg = { provider, ...(providerConfigs[provider] || {}) };
  if (!cfg.apiKey && provider !== "custom") return { error: "no_key" };

  const cacheKey = `assessment:${host}`;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  if (mode === "page") {

    let pageText, pageUrl;
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractRenderedText });
      pageText = (result || "").replace(/\s+/g, " ").trim();
      pageUrl = (await chrome.tabs.get(tabId)).url;
    } catch (e) {
      return unavailable(host, `The current page could not be read (${e.message}).`);
    }
    if (!looksLikePolicyText(pageText)) {
      return { error: "not_policy_page" };
    }
    return assessSuppliedText(host, pageUrl, pageText, cacheKey);
  }
  if (!force) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached && Date.now() - new Date(cached.assessedAt).getTime() < CACHE_TTL_MS) {
      return { ...cached, fromCache: true };
    }
  }

  let policyUrl;
  try { policyUrl = await discoverPolicyUrl(tabId); }
  catch (e) { return unavailable(host, "This page could not be inspected for a policy link (" + (e.message || e) + ")."); }
  if (!policyUrl) return unavailable(host, "No privacy policy link was found on this page.");

  let fetched;
  try { fetched = await fetchPolicyText(policyUrl); }
  catch (e) { return unavailable(host, `The policy could not be retrieved (${e.message}).`); }
  if (fetched.text.length < 1000) {
    try {
      const rendered = await renderPolicyInTab(policyUrl);
      if (rendered.length >= 1000) {
        fetched = { text: rendered, truncated: false, viaRender: true };
      } else {
        return unavailable(host,
          "The policy page was rendered in a background tab but still yielded almost no readable text. " +
          "It may sit behind a consent screen or an interactive wall, so it could not be assessed.",
          policyUrl);
      }
    } catch (e) {
      return unavailable(host,
        `The policy page appears to be JavaScript-rendered and the render fallback failed (${e.message}).`,
        policyUrl);
    }
  }

  return assessSuppliedText(host, policyUrl, fetched.text, cacheKey, fetched.viaRender);
}

async function assessSuppliedText(host, policyUrl, text, cacheKey, viaRender = false) {
  const { provider = "anthropic", providerConfigs = {} } =
    await chrome.storage.local.get(["provider", "providerConfigs"]);
  const cfg = { provider, ...(providerConfigs[provider] || {}) };
  if (!cfg.apiKey && provider !== "custom") return { error: "no_key" };
  const fetched = { text, viaRender };
  const policyHash = await hashPolicyText(fetched.text);

  {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached && cached.policyHash === policyHash) {
      const refreshed = { ...cached, assessedAt: new Date().toISOString() };
      await chrome.storage.local.set({ [cacheKey]: refreshed });
      return { ...refreshed, fromCache: true };
    }
  }

  let assessment, partsUsed = 1, ranOutOfParts = false;
  try {
    const budget = PROVIDER_CHAR_BUDGET[cfg.provider] ?? 100000;
    const parts = [];
    for (let i = 0; i < fetched.text.length; i += budget) parts.push(fetched.text.slice(i, i + budget));
    const totalParts = parts.length;

    let draft = null;
    for (let i = 0; i < Math.min(totalParts, MAX_PARTS); i++) {
      partsUsed = i + 1;
      const userMsg =
        `POLICY TEXT - PART ${i + 1} of ${totalParts}` +
        (draft ? `\n\nYOUR DRAFT FINDINGS FROM EARLIER PARTS (update these):\n${JSON.stringify({ criteria: draft.criteria })}` : "") +
        `\n\n${parts[i]}`;
      draft = validateSchema(await assessWithLLM(userMsg, cfg));
      const morePartsExist = i + 1 < totalParts;
      if (!morePartsExist || draft.needs_more === false) break;
      if (i + 1 === MAX_PARTS && morePartsExist) ranOutOfParts = true;
    }
    assessment = verifyClauses(draft, fetched.text);
  } catch (e) {
    const detail = String(e.message || e);
    await logError("assessment", host, detail);
    return { error: "assessment_failed", detail };
  }

  const grades = assessment.criteria.map(c => c.grade).filter(Boolean);
  const overall = grades.includes("red") ? "red" : grades.includes("amber") ? "amber"
                : grades.length ? "green" : "unknown";
  const reason = overall === "unknown"
    ? "A policy page was retrieved and read, but no criterion could be evidenced from it. The fetched page may be a navigation shell, a consent screen, or a JavaScript-rendered page whose content the extension cannot see. Check the assessed page via the link below."
    : undefined;

  const record = {
    host,
    reason,
    policyUrl,
    policyHash,
    model: `${cfg.provider}:${cfg.model || (PROVIDERS[cfg.provider]?.defaultModel ?? "?")}`,
    parts: partsUsed,
    viaRender: !!fetched.viaRender,
    truncated: ranOutOfParts,
    grade: overall,
    assessedAt: new Date().toISOString(),
    criteria: assessment.criteria,
    clauseVerification: assessment.clauseVerification
  };
  await chrome.storage.local.set({ [cacheKey]: record });
  return record;
}

function unavailable(host, reason, policyUrl = null) {
  logError("retrieval", host, reason);
  return {
    host, grade: "unknown", policyHash: null, assessedAt: null, reason, policyUrl,
    criteria: RUBRIC.map(r => ({
      id: r.id, state: "unavailable", grade: null, confidence: null,
      summary: reason, clause: null
    }))
  };
}

async function recordConsentSnapshot(host) {
  const rec = (await chrome.storage.local.get(`assessment:${host}`))[`assessment:${host}`];
  if (!rec) return { error: "nothing_to_snapshot" };
  const snapshot = {
    host, policyHash: rec.policyHash, grade: rec.grade,
    consentedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [`consent:${host}`]: snapshot });
  return snapshot;
}

const inflight = new Map();

function assessDeduped(tabId, host, force, mode = "auto") {
  const key = `${mode}:${host}`;
  if (!force && inflight.has(key)) return inflight.get(key);
  const job = runAssessment(tabId, host, force, mode)
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function getCachedAssessment(host) {
  const rec = (await chrome.storage.local.get(`assessment:${host}`))[`assessment:${host}`];
  if (rec) return { ...rec, fromCache: true };
  for (const key of inflight.keys()) {
    if (key.endsWith(`:${host}`)) return { inProgress: true };
  }
  return { noCache: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "cached") sendResponse(await getCachedAssessment(msg.host));
      else if (msg.type === "errorLog") sendResponse(await readErrorLog());
      else if (msg.type === "clearErrorLog") sendResponse(await clearErrorLog());
      else if (msg.type === "assess") sendResponse(await assessDeduped(msg.tabId, msg.host, msg.force, msg.mode || "auto"));
      else if (msg.type === "consent") sendResponse(await recordConsentSnapshot(msg.host));
    } catch (e) {

      const detail = String(e?.message || e);
      await logError("worker", msg?.host, detail);
      try { sendResponse({ error: "assessment_failed", detail }); } catch (_) {}
    }
  })();
  return true;
});
