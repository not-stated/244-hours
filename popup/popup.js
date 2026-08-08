const RUBRIC_LABELS = {
  data_collected: "What data is collected",
  sharing: "Who it is shared with",
  tracking: "Whether you are tracked",
  purposes: "Why it is used",
  retention: "How long it is kept",
  rights: "Your rights & controls"
};

const ORDER = ["data_collected", "sharing", "tracking", "purposes", "retention", "rights"];

const GRADE_WORDS = { green: "Low concern", amber: "Some concerns", red: "Serious concerns", unknown: "Not assessed" };
const PILL_TEXT = { green: "OK", amber: "Caution", red: "Warning", not_stated: "Not stated", unavailable: "Unknown" };

let current = null;
let activeTab = null;

const $ = id => document.getElementById(id);

function pillClass(c) {
  if (c.state === "not_stated") return "not_stated";
  if (c.state === "unavailable") return "unavailable";
  return c.grade;
}

function setStatus(text, isError = false, withOptionsLink = false) {
  const el = $("statusLine");
  el.classList.toggle("hidden", !text);
  el.classList.toggle("error", isError);
  el.innerHTML = "";
  if (!text) return;
  el.append(text + " ");
  if (withOptionsLink) {
    const a = document.createElement("a");
    a.href = "#"; a.textContent = "Open settings";
    a.onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    el.append(a);
  }
}

function render(a) {
  clearInterval(workTimer);
  current = a;
  const dot = $("gradeDot");
  dot.className = "grade-dot " + (a.grade || "unknown");
  $("gradeHost").textContent = a.host === "unknown" ? "This site" : a.host;
  $("gradeWord").textContent = GRADE_WORDS[a.grade || "unknown"];

  const ov = $("overview"); ov.innerHTML = "";
  const issues = a.criteria.filter(c => c.grade === "red" || c.grade === "amber" || c.state === "not_stated");
  if (a.grade === "unknown") {
    const d = document.createElement("div");
    d.className = "overview-item not_stated";
    d.textContent = a.reason || "No policy could be retrieved. No grade is given: absence of information is not a good sign.";
    ov.appendChild(d);
    if (activeTab && !a.__demo) {
      const page = document.createElement("button");
      page.className = "assess-cta secondary";
      page.textContent = "\u25B6 Open the policy yourself, then assess THAT page (1 request)";
      page.addEventListener("click", () => runLive(true, "page"));
      ov.appendChild(page);
    }
  } else if (!issues.length) {
    const d = document.createElement("div");
    d.className = "overview-empty";
    d.textContent = "No serious issues found across the six criteria.";
    ov.appendChild(d);
  } else {
    const rank = c => (c.grade === "red" ? 0 : c.state === "not_stated" ? 1 : 2);
    issues.sort((x, y) => rank(x) - rank(y)).slice(0, 3).forEach(c => {
      const d = document.createElement("div");
      d.className = "overview-item " + (c.grade === "amber" ? "amber" : c.state === "not_stated" ? "not_stated" : "");
      d.textContent = RUBRIC_LABELS[c.id] + ": " + c.summary;
      ov.appendChild(d);
    });
  }

  const list = $("criteria"); list.innerHTML = "";
  [...a.criteria].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id)).forEach(c => {
    const li = document.createElement("li"); li.className = "criterion";

    const row = document.createElement("button");
    row.className = "criterion-row"; row.setAttribute("aria-expanded", "false");
    const name = document.createElement("span"); name.textContent = RUBRIC_LABELS[c.id];
    const pill = document.createElement("span");
    pill.className = "pill " + pillClass(c); pill.textContent = PILL_TEXT[pillClass(c)];
    row.append(name, pill); li.appendChild(row);

    const body = document.createElement("div"); body.className = "criterion-body hidden";
    const summary = document.createElement("span"); summary.textContent = c.summary; body.appendChild(summary);

    if (c.confidence === "low") {
      const flag = document.createElement("span");
      flag.className = "low-confidence"; flag.textContent = "Low confidence";
      flag.title = "The policy wording here is ambiguous, or the AI's evidence could not be verified.";
      body.appendChild(flag);
    }
    if (c.clause) {
      const toggle = document.createElement("button");
      toggle.className = "clause-toggle"; toggle.textContent = "Show exact policy wording";
      const clause = document.createElement("blockquote");
      clause.className = "clause hidden"; clause.textContent = "\u201C" + c.clause + "\u201D";
      toggle.addEventListener("click", e => {
        e.stopPropagation();
        const h = clause.classList.toggle("hidden");
        toggle.textContent = h ? "Show exact policy wording" : "Hide policy wording";
      });
      body.append(document.createElement("br"), toggle, clause);
    }
    li.appendChild(body);

    if (c.grade === "red") {
      const cover = document.createElement("button");
      cover.className = "friction-cover"; cover.textContent = "Serious finding - tap to reveal";
      cover.addEventListener("click", () => {
        cover.remove(); body.classList.remove("hidden"); row.setAttribute("aria-expanded", "true");
      });
      li.appendChild(cover);
      row.addEventListener("click", () => cover.click());
    } else {
      row.addEventListener("click", () => {
        const h = body.classList.toggle("hidden");
        row.setAttribute("aria-expanded", String(!h));
      });
    }
    list.appendChild(li);
  });

  const bits = [];
  if (a.assessedAt) bits.push("Assessed " + new Date(a.assessedAt).toLocaleDateString("en-GB"));
  if (a.model) bits.push(a.model);
  if (a.fromCache) bits.push("cached - policy unchanged");
  if (a.parts > 1) bits.push(`read in ${a.parts} parts`);
  if (a.viaRender) bits.push("page rendered to read it");
  if (a.truncated) bits.push("very long policy - tail not read");
  $("labelSub").textContent = bits.length ? bits.join(" · ") : "Assessed against the same 6 criteria for every site";

  const v = $("verifyLine");
  const quoted = a.criteria.filter(c => c.clause).length;
  if (a.clauseVerification && (quoted > 0 || a.clauseVerification.failed > 0)) {
    v.classList.remove("hidden");
    const { checked, failed } = a.clauseVerification;
    v.textContent = failed === 0
      ? `Evidence check: all ${quoted} quoted clauses verified verbatim against the policy text.`
      : `Evidence check: ${failed} of ${checked} claimed clauses could NOT be verified and were downgraded.`;
  } else if (a.clauseVerification) {
    v.classList.remove("hidden");
    v.textContent = "Evidence check: no verifiable claims were made for this page.";
  } else v.classList.add("hidden");

  if (a.policyUrl) {
    const link = document.createElement("a");
    link.href = a.policyUrl; link.target = "_blank";
    link.textContent = "View the policy page this was based on";
    link.style.cssText = "display:block;font-size:10px;font-weight:700;margin-top:4px;color:#000;";
    v.classList.remove("hidden");
    v.appendChild(document.createElement("br"));
    v.appendChild(link);
  }

  $("consentBtn").disabled = a.grade === "unknown" || !a.policyHash;
  $("consentBtn").textContent = "I'm agreeing to this site's terms now - save a record of this version";
  $("reassessBtn").classList.toggle("hidden", !activeTab || a.__demo);
}

async function runLive(force = false, mode = "auto") {
  document.querySelectorAll(".demo-btn").forEach(x => x.classList.remove("active"));
  $("liveBtn").classList.add("active");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!tab?.url || !/^https?:/.test(tab.url)) {
    activeTab = null;
    setStatus("This page can't be assessed (browser-internal or restricted page). Open a normal website, or use the demo modes below.");
    render(emptyState("this page"));
    $("gradeWord").textContent = "Not assessable";
    return;
  }
  const host = new URL(tab.url).hostname;
  renderWorking(host);
  const res = await chrome.runtime.sendMessage({ type: "assess", tabId: tab.id, host, force, mode });
  if (res?.error === "no_key") {
    setStatus("No API key set. Live assessment needs your Anthropic key.", true, true);
    return;
  }
  if (res?.error === "not_policy_page") {
    setStatus("This page doesn't look like a privacy policy, so nothing was assessed and no request was spent. " +
      "If you meant this site's policy, use Automatic assess instead.", true);
    renderIdle(host);
    return;
  }
  if (res?.error === "assessment_failed") {
    setStatus("Assessment failed: " + res.detail, true);
    return;
  }
  setStatus("");
  render(res);
}

const WORK_STEPS = [
  "Finding the privacy policy link\u2026",
  "Fetching and reading the policy\u2026",
  "Assessing against the six criteria\u2026",
  "Verifying every quoted clause against the source\u2026"
];
let workTimer = null;

function renderWorking(host) {
  clearInterval(workTimer);
  $("gradeDot").className = "grade-dot working";
  $("gradeHost").textContent = host;
  $("gradeWord").textContent = "Assessing\u2026";
  $("labelSub").textContent = "Live assessment in progress";
  $("overview").innerHTML = "";
  $("verifyLine").classList.add("hidden");
  $("consentBtn").disabled = true;
  $("reassessBtn").classList.add("hidden");

  const list = $("criteria"); list.innerHTML = "";
  ORDER.forEach(id => {
    const li = document.createElement("li"); li.className = "criterion";
    const row = document.createElement("div"); row.className = "criterion-row";
    const name = document.createElement("span"); name.textContent = RUBRIC_LABELS[id];
    const pill = document.createElement("span"); pill.className = "pill scanning"; pill.textContent = "Scanning";
    row.append(name, pill); li.appendChild(row); list.appendChild(li);
  });

  let i = 0;
  setStatus(WORK_STEPS[0] + " This can take 10-30 seconds.");
  workTimer = setInterval(() => {
    i = Math.min(i + 1, WORK_STEPS.length - 1);
    setStatus(WORK_STEPS[i] + " This can take 10-30 seconds.");
  }, 4000);
}

function emptyState(host) {
  return { host, grade: "unknown", criteria: ORDER.map(id => ({
    id, state: "unavailable", grade: null, confidence: null,
    summary: "Working…", clause: null })), __demo: false };
}

async function runDemo(host) {
  activeTab = null;
  setStatus("Demo data (mock assessment, no API call).");
  const data = await fetch(chrome.runtime.getURL("data/mock-assessments.json")).then(r => r.json());
  const rec = data[host] ?? data["__unavailable__"];
  rec.__demo = true;
  render(rec);
}

$("liveBtn").addEventListener("click", () => runLive(false));
$("reassessBtn").addEventListener("click", () => runLive(true));
document.querySelectorAll(".demo-btn:not(.live)").forEach(b =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".demo-btn").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    runDemo(b.dataset.host);
  })
);
$("consentBtn").addEventListener("click", async () => {
  if (!current) return;
  const res = await chrome.runtime.sendMessage({ type: "consent", host: current.host });
  if (!res.error) {
    $("consentBtn").textContent = "✓ Saved - you'll be able to see if this policy later changes";
    $("consentBtn").disabled = true;
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    activeTab = null;
    setStatus("This page can't be assessed (browser-internal or restricted page). Use the demo modes below.");
    render(emptyState("this page"));
    $("gradeWord").textContent = "Not assessable";
    return;
  }
  const host = new URL(tab.url).hostname;
  const cached = await chrome.runtime.sendMessage({ type: "cached", host });
  if (cached?.inProgress) { renderWorking(host); pollForResult(host); return; }
  if (cached && !cached.noCache) { render(cached); return; }
  renderIdle(host);
}

function renderIdle(host) {
  $("gradeDot").className = "grade-dot unknown";
  $("gradeHost").textContent = host;
  $("gradeWord").textContent = "Not yet assessed";
  $("labelSub").textContent = "No requests are made until you ask";
  $("overview").innerHTML = "";
  $("verifyLine").classList.add("hidden");
  $("consentBtn").disabled = true;
  $("reassessBtn").classList.add("hidden");
  const list = $("criteria"); list.innerHTML = "";
  const auto = document.createElement("button");
  auto.className = "assess-cta";
  auto.textContent = "\u25B6 Automatic assess - finds this site's policy for you (1 request)";
  auto.addEventListener("click", () => runLive(false, "auto"));
  const page = document.createElement("button");
  page.className = "assess-cta secondary";
  page.textContent = "\u25B6 Assess THIS page as the policy - use when you are viewing a privacy policy (1 request)";
  page.addEventListener("click", () => runLive(true, "page"));
  list.append(auto, page);
  setStatus("");
}

async function pollForResult(host) {

  const t = setInterval(async () => {
    const c = await chrome.runtime.sendMessage({ type: "cached", host });
    if (c && !c.noCache && !c.inProgress) { clearInterval(t); setStatus(""); render(c); }
  }, 1500);
}

init();
