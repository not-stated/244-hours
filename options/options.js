const $ = id => document.getElementById(id);
const DEFAULTS = { anthropic: "claude-sonnet-4-6", openai: "gpt-4o", gemini: "gemini-3.5-flash", custom: "" };

let providerConfigs = {};

async function load() {
  const st = await chrome.storage.local.get(["provider", "providerConfigs"]);
  providerConfigs = st.providerConfigs || {};
  $("provider").value = st.provider || "anthropic";
  fill();
}

function fill() {
  const p = $("provider").value;
  const cfg = providerConfigs[p] || {};
  $("apiKey").value = cfg.apiKey || "";
  $("model").value = cfg.model || "";
  $("model").placeholder = DEFAULTS[p] ? `default: ${DEFAULTS[p]}` : "e.g. llama3, mistral, provider/model";
  $("baseUrl").value = cfg.baseUrl || "";
  $("baseUrlWrap").classList.toggle("hidden", p !== "custom");
  $("keyProviderName").textContent = `(${$("provider").selectedOptions[0].text})`;
}

function stash() {
  const p = $("provider").value;
  providerConfigs[p] = {
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    baseUrl: $("baseUrl").value.trim()
  };
}

$("provider").addEventListener("change", () => { fill(); });
["apiKey", "model", "baseUrl"].forEach(id => $(id).addEventListener("input", stash));

$("save").addEventListener("click", async () => {
  stash();
  await chrome.storage.local.set({ provider: $("provider").value, providerConfigs });
  $("status").textContent = "Saved ✓";
  setTimeout(() => ($("status").textContent = ""), 2000);
});

const STAGE_LABEL = { retrieval: "Retrieval", assessment: "Assessment", worker: "Worker" };

function renderLog(entries) {
  const view = $("logView");
  view.innerHTML = "";
  $("logCount").textContent = entries.length
    ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
    : "";
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "log-empty";
    p.textContent = "No errors recorded.";
    view.appendChild(p);
    return;
  }
  const table = document.createElement("table");
  table.className = "log";
  const head = document.createElement("tr");
  ["When", "Stage", "Site", "Message"].forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);
  entries.forEach(e => {
    const tr = document.createElement("tr");
    const when = document.createElement("td");
    when.className = "when";
    when.textContent = new Date(e.at).toLocaleString("en-GB");
    const stage = document.createElement("td");
    stage.className = "stage";
    stage.textContent = STAGE_LABEL[e.stage] || e.stage;
    const host = document.createElement("td");
    host.textContent = e.host;
    const detail = document.createElement("td");
    detail.textContent = e.detail;
    tr.append(when, stage, host, detail);
    table.appendChild(tr);
  });
  view.appendChild(table);
}

async function loadLog() {
  try {
    renderLog(await chrome.runtime.sendMessage({ type: "errorLog" }) || []);
  } catch (_) {
    renderLog([]);
  }
}

$("clearLog").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearErrorLog" });
  loadLog();
});

load();
loadLog();
