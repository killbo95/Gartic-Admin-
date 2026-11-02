// Set this to the deployed Cloudflare Worker URL before publishing.
const API_BASE = "https://YOUR-WORKER.workers.dev";
const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  if (API_BASE.includes("YOUR-WORKER")) throw new Error("The Worker URL has not been configured in app.js yet.");
  const response = await fetch(API_BASE + path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
  return data;
};
const show = (id, visible) => $(id)?.classList.toggle("hidden", !visible);

if (document.body.dataset.page === "student") {
  let code = "";
  let poller;
  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("join-message").textContent = "Checking session…";
    code = $("room-code").value.trim().toUpperCase();
    try {
      const data = await api("/api/status?code=" + encodeURIComponent(code));
      if (!data.active) throw new Error("That session is not active. Check the code with the administrator.");
      show("join-panel", false); show("session-panel", true);
      $("session-status").textContent = "Connected to session " + code + ".";
      await heartbeat();
      poller = setInterval(checkStatus, 4000);
    } catch (error) { $("join-message").textContent = error.message; }
  });
  async function heartbeat() {
    if (!code) return;
    try { await api("/api/heartbeat", { method: "POST", body: JSON.stringify({ code }) }); } catch (_) {}
  }
  async function checkStatus() {
    try {
      const data = await api("/api/status?code=" + encodeURIComponent(code));
      if (!data.active) endLocalSession();
      else heartbeat();
    } catch (_) { $("session-status").textContent = "Connection interrupted. Reconnecting…"; }
  }
  function endLocalSession() {
    clearInterval(poller); code = "";
    show("session-panel", false); show("join-panel", false); show("ended-panel", true);
  }
  $("back-button").addEventListener("click", () => { show("ended-panel", false); show("join-panel", true); $("room-code").value = ""; $("join-message").textContent = ""; });
  window.addEventListener("pagehide", () => { if (code && navigator.sendBeacon) navigator.sendBeacon(API_BASE + "/api/leave", new Blob([JSON.stringify({ code })], { type: "application/json" })); });
}

if (document.body.dataset.page === "admin") {
  let token = "";
  const auth = () => ({ "X-Admin-Token": token });
  $("connect-button").addEventListener("click", async () => {
    token = $("admin-token").value.trim();
    $("admin-message").textContent = "Connecting…";
    try {
      await refresh();
      show("controls-panel", true);
      $("admin-message").textContent = "Connected.";
    } catch (error) { token = ""; $("admin-message").textContent = error.message; }
  });
  async function refresh() {
    const data = await api("/api/admin/status", { headers: auth() });
    const active = Boolean(data.active);
    $("admin-status").textContent = active ? "Session is running" : "No active session";
    $("status-pill").textContent = active ? "ACTIVE" : "IDLE";
    $("status-pill").style.color = active ? "var(--cyan)" : "var(--muted)";
    $("start-button").disabled = active;
    $("end-button").disabled = !active;
    show("code-display", active);
    if (active) $("session-code").textContent = data.code;
  }
  $("start-button").addEventListener("click", async () => {
    try { const data = await api("/api/admin/start", { method: "POST", headers: auth() }); await refresh(); $("session-code").textContent = data.code; }
    catch (error) { $("admin-message").textContent = error.message; }
  });
  $("end-button").addEventListener("click", async () => {
    if (!confirm("End this managed session for all connected portal users?")) return;
    try { await api("/api/admin/end", { method: "POST", headers: auth() }); await refresh(); }
    catch (error) { $("admin-message").textContent = error.message; }
  });
}