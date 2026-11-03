// Cloudflare Worker API for the Gartic Admin session service.
const API_BASE = "https://gartic-admin-session.yahyamsalam2.workers.dev";
const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed (" + response.status + ")");
  return data;
};
const show = (id, visible) => $(id)?.classList.toggle("hidden", !visible);
const isOfficialRoomUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["garticphone.com", "www.garticphone.com"].includes(url.hostname);
  } catch (_) { return false; }
};

if (document.body.dataset.page === "student") {
  let code = "", poller = null, gameLoaded = false, sessionEnded = false;
  const clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "client-" + Math.random().toString(36).slice(2);
  const gameFrame = $("game-frame"), gameLink = $("game-room-link");
  const displayName = () => $("student-name").value.trim().slice(0, 24) || "Student";
  $("join-form").addEventListener("submit", async event => {
    event.preventDefault(); $("join-message").textContent = "Checking session…";
    code = $("room-code").value.trim().toUpperCase();
    sessionEnded = false;
    try {
      const data = await getStudentStatus();
      if (!data.active) throw new Error("That session is not active. Check the code with the administrator.");
      if (data.kicked) throw new Error("You have been disconnected by the administrator.");
      if (data.locked) throw new Error("This session is locked. Ask the administrator to reopen joining.");
      if (data.full) throw new Error("This session has reached its participant limit.");
      show("join-panel", false);
      if (data.waiting) { show("waiting-panel", true); $("waiting-status").textContent = "Your request has been sent. Keep this page open while the administrator reviews it."; }
      else activateSession(data);
      poller = setInterval(checkStatus, 1500);
    } catch (error) { code = ""; $("join-message").textContent = error.message; }
  });
  async function getStudentStatus() {
    return api("/api/status?code=" + encodeURIComponent(code) + "&clientId=" + encodeURIComponent(clientId) + "&displayName=" + encodeURIComponent(displayName()));
  }
  function activateSession(data) {
    if (gameLoaded || !data.gameUrl || !isOfficialRoomUrl(data.gameUrl)) return;
    gameLoaded = true; show("waiting-panel", false); show("session-panel", true);
    $("session-status").textContent = "Connected to session " + code + (data.paused ? " · Session paused by administrator." : ".");
    gameLink.href = data.gameUrl; gameFrame.src = data.gameUrl; updateAnnouncement(data.announcement); heartbeat();
  }
  function updateWarning(message) {
    const box = $("student-warning");
    if (message) { box.textContent = "ADMIN WARNING: " + message; show("student-warning", true); }
    else show("student-warning", false);
  }
  function updateAnnouncement(message) {
    const box = $("student-announcement");
    if (message) { box.textContent = "ADMIN: " + message; show("student-announcement", true); }
    else show("student-announcement", false);
  }
  async function heartbeat() {
    const currentCode = code;
    if (!currentCode || !gameLoaded || sessionEnded) return;
    try { await api("/api/heartbeat", { method: "POST", body: JSON.stringify({ code: currentCode, clientId }) }); }
    catch (error) { if (code === currentCode && /disconnected|ended|approval/i.test(error.message)) endLocalSession(error.message); }
  }
  async function checkStatus() {
    const currentCode = code;
    if (!currentCode || sessionEnded) return;
    try {
      const data = await api("/api/status?code=" + encodeURIComponent(currentCode) + "&clientId=" + encodeURIComponent(clientId) + "&displayName=" + encodeURIComponent(displayName()));
      // Ignore delayed responses from a previous session or requests that finish after disconnect.
      if (sessionEnded || code !== currentCode) return;
      if (!data.active) return endLocalSession("The administrator ended the session.");
      if (data.kicked) return endLocalSession("The administrator disconnected you.");
      if (data.full || data.locked) return endLocalSession(data.full ? "The session is full." : "New joining has been locked.");
      if (data.waiting) { show("waiting-panel", true); show("session-panel", false); $("waiting-status").textContent = "Your request is waiting for administrator approval."; return; }
      activateSession(data); updateAnnouncement(data.announcement); updateWarning(data.warning);
      $("session-status").textContent = data.paused ? "Session paused by administrator. Please wait." : "Connected to session " + code + ".";
      await heartbeat();
    } catch (_) { if (!sessionEnded && code === currentCode) $("session-status").textContent = "Connection interrupted. Reconnecting…"; }
  }
  $("student-message-form").addEventListener("submit", async event => {
    event.preventDefault(); const message = $("student-message").value.trim(); if (!message) return;
    try { await api("/api/message", { method: "POST", body: JSON.stringify({ clientId, message }) }); $("student-message").value = ""; $("student-message-status").textContent = "Message sent to the administrator."; }
    catch (error) { $("student-message-status").textContent = error.message; }
  });
  function endLocalSession(message = "The managed session has ended.") {
    if (sessionEnded) return;
    sessionEnded = true;
    clearInterval(poller); poller = null; code = ""; gameLoaded = false; gameFrame.src = "about:blank"; gameLink.href = "#";
    show("session-panel", false); show("waiting-panel", false); show("join-panel", false); show("ended-panel", true);
    const endedText = $("ended-panel").querySelector("p");
    if (endedText) endedText.textContent = message + " This tab will try to close automatically.";
    window.close();
    window.setTimeout(() => { if (!window.closed && endedText) endedText.textContent = message + " Your browser did not allow this tab to close. You can close it manually."; }, 300);
  }
  $("back-button").addEventListener("click", () => { show("ended-panel", false); show("join-panel", true); $("room-code").value = ""; $("join-message").textContent = ""; });
  window.addEventListener("pagehide", () => {
    if (code && navigator.sendBeacon) navigator.sendBeacon(API_BASE + "/api/leave", new Blob([JSON.stringify({ code, clientId })], { type: "application/json" }));
  });
}
if (document.body.dataset.page === "admin") {
  let token = "";
  let adminPoller = null;
  const auth = () => ({ "X-Admin-Token": token });
  let latestStatus = null;

  const roomCreator = $("room-creator-container");
  const fullscreenButton = $("room-fullscreen-button");
  fullscreenButton.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) {
        if (!roomCreator.requestFullscreen) throw new Error("Fullscreen is not supported by this browser.");
        await roomCreator.requestFullscreen();
      } else if (document.fullscreenElement === roomCreator) {
        await document.exitFullscreen();
      }
    } catch (error) {
      $("admin-message").textContent = error.message || "Could not enter full screen. Try the browser's full-screen option.";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.textContent = document.fullscreenElement === roomCreator
      ? "Exit full screen ✕"
      : "Enter full screen ⛶";
  });
  $("connect-button").addEventListener("click", async () => {
    token = $("admin-token").value.trim();
    $("admin-message").textContent = "Connecting…";
    try {
      await refresh();
      show("room-creator-panel", true);
      show("controls-panel", true);
      if (adminPoller) clearInterval(adminPoller);
      adminPoller = setInterval(() => refresh().catch(error => { $("admin-message").textContent = "Refresh failed: " + error.message; }), 5000);
      $("admin-message").textContent = "Connected.";
    } catch (error) {
      token = "";
      $("admin-message").textContent = error.message;
    }
  });

  async function refresh() {
    const data = await api("/api/admin/status", { headers: auth() });
    latestStatus = data;
    const active = Boolean(data.active);
    $("admin-status").textContent = active ? "Session is running" : "No active session";
    $("status-pill").textContent = active ? "ACTIVE" : "IDLE";
    $("status-pill").style.color = active ? "var(--cyan)" : "var(--muted)";
    $("start-button").disabled = active;
    $("end-button").disabled = !active;
    $("regenerate-code-button").disabled = !active;
    $("lock-button").disabled = !active;
    $("lock-button").textContent = data.locked ? "Unlock new joins" : "Lock new joins";
    $("pause-button").disabled = !active;
    $("pause-button").textContent = data.paused ? "Resume session" : "Pause session";
    if (document.activeElement !== $("max-participants")) $("max-participants").value = data.maxParticipants || 0;
    if (document.activeElement !== $("waiting-room-toggle")) $("waiting-room-toggle").checked = Boolean(data.waitingRoom);
    if (document.activeElement !== $("announcement-input")) $("announcement-input").value = data.announcement || "";
    if (document.activeElement !== $("duration-minutes")) $("duration-minutes").value = data.durationMinutes || $("duration-minutes").value || 0;
    $("session-countdown").value = data.endsAt ? Math.max(0, Math.ceil((data.endsAt - Date.now()) / 60000)) + " min remaining" : "Not timed";
    renderEvents("message-list", data.messages || [], item => item.from + ": " + item.message);
    renderEvents("activity-list", data.activity || [], item => item.type + (item.detail ? " — " + item.detail : ""));
    renderEvents("history-list", data.history || [], item => item.code + " · " + new Date(item.startedAt).toLocaleString() + " · " + item.participants + " participants");
    show("code-display", active);
    renderParticipants(data.members || []);
    if (active) {
      $("session-code").textContent = data.code;
      $("game-url").value = data.gameUrl || "";
      $("admin-game-link").href = data.gameUrl || "#";
      $("active-room-wrap").hidden = !data.gameUrl;
    } else {
      $("active-room-wrap").hidden = true;
    }
  }

  function renderParticipants(members) {
    const list = $("participant-list");
    list.replaceChildren();
    const query = ($("participant-search").value || "").toLowerCase();
    members = members.filter(m => (m.displayName || "Student").toLowerCase().includes(query));
    if (!members.length) {
      const empty = document.createElement("p");
      empty.className = "small muted";
      empty.textContent = "No participants connected.";
      list.append(empty);
      return;
    }
    members.forEach((member, index) => {
      const row = document.createElement("div");
      row.className = "participant-row";
      const label = document.createElement("span");
      label.textContent = (member.displayName || "Student") + (member.approved ? (member.connected ? " · Connected" : " · Reconnecting") : " · Waiting approval");
      const button = document.createElement("button");
      button.className = "danger";
      button.type = "button";
      button.textContent = member.approved ? "Disconnect" : "Reject";
      row.append(label);
      if (!member.approved) { const approve = document.createElement("button"); approve.className = "secondary"; approve.type = "button"; approve.textContent = "Approve"; approve.addEventListener("click", async () => { try { await api("/api/admin/approve", { method: "POST", headers: auth(), body: JSON.stringify({ clientId: member.clientId }) }); await refresh(); } catch (error) { $("admin-message").textContent = error.message; } }); row.append(approve); }
      button.addEventListener("click", async () => {
        if (!confirm("Disconnect this participant from the managed portal?")) return;
        try {
          await api("/api/admin/kick", { method: "POST", headers: auth(), body: JSON.stringify({ clientId: member.clientId }) });
          await refresh();
        } catch (error) { $("admin-message").textContent = error.message; }
      });
      if (member.approved) { const warn = document.createElement("button"); warn.className = "secondary"; warn.type = "button"; warn.textContent = "Warn"; warn.addEventListener("click", async () => { const message = prompt("Enter a short private warning for this participant:"); if (!message) return; try { await api("/api/admin/warn", { method: "POST", headers: auth(), body: JSON.stringify({ clientId: member.clientId, message }) }); await refresh(); } catch (error) { $("admin-message").textContent = error.message; } }); row.append(warn); }
      row.append(button);
      list.append(row);
    });
  }

  $("lock-button").addEventListener("click", async () => {
    const lock = $("lock-button").textContent.includes("Lock new joins");
    try {
      await api("/api/admin/lock", { method: "POST", headers: auth(), body: JSON.stringify({ locked: lock }) });
      await refresh();
      $("admin-message").textContent = lock ? "New joins are locked." : "New joins are open.";
    } catch (error) { $("admin-message").textContent = error.message; }
  });

  $("start-button").addEventListener("click", async () => {
    const gameUrl = $("game-url").value.trim();
    if (!isOfficialRoomUrl(gameUrl)) {
      $("admin-message").textContent = "Paste a valid HTTPS invitation URL from garticphone.com first.";
      $("game-url").focus();
      return;
    }
    $("admin-message").textContent = "Starting session…";
    try {
      const data = await api("/api/admin/start", {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ gameUrl, durationMinutes: Number($("duration-minutes").value) || 0 })
      });
      await refresh();
      $("session-code").textContent = data.code;
      $("admin-message").textContent = "Session started. Share the code with your participants.";
    } catch (error) {
      $("admin-message").textContent = error.message;
    }
  });

  $("end-button").addEventListener("click", async () => {
    if (!confirm("Force disconnect everyone and end this managed session?")) return;
    try {
      await api("/api/admin/end", { method: "POST", headers: auth() });
      await refresh();
      $("game-url").value = "";
      $("admin-message").textContent = "Everyone has been disconnected. Session ended.";
    } catch (error) {
      $("admin-message").textContent = error.message;
    }
  });
}

  function renderEvents(id, items, formatter) {
    const list = $(id); list.replaceChildren();
    if (!items.length) { const empty = document.createElement("p"); empty.className = "small muted"; empty.textContent = "Nothing to show yet."; list.append(empty); return; }
    items.slice(0, 30).forEach(item => { const row = document.createElement("div"); row.className = "event-row"; const main = document.createElement("span"); main.textContent = formatter(item); const time = document.createElement("time"); time.textContent = new Date(item.at || item.startedAt).toLocaleString(); row.append(main, time); list.append(row); });
  }
  $("participant-search").addEventListener("input", () => renderParticipants(latestStatus?.members || []));
  $("save-settings-button").addEventListener("click", async () => {
    const button = $("save-settings-button");
    button.disabled = true;
    $("admin-message").textContent = "Saving settings…";
    try {
      await api("/api/admin/settings", { method: "POST", headers: auth(), body: JSON.stringify({ waitingRoom: $("waiting-room-toggle").checked, maxParticipants: Number($("max-participants").value) || 0 }) });
      await refresh();
      $("admin-message").textContent = "Session settings saved successfully.";
    } catch (error) { $("admin-message").textContent = "Could not save settings: " + error.message; }
    finally { button.disabled = false; }
  });
  $("pause-button").addEventListener("click", async () => {
    try { const paused = $("pause-button").textContent === "Pause session"; await api("/api/admin/pause", { method: "POST", headers: auth(), body: JSON.stringify({ paused }) }); await refresh(); }
    catch (error) { $("admin-message").textContent = error.message; }
  });
  $("announce-button").addEventListener("click", async () => {
    const message = $("announcement-input").value.trim();
    if (!message) { $("admin-message").textContent = "Type an announcement before publishing."; $("announcement-input").focus(); return; }
    const button = $("announce-button");
    button.disabled = true;
    $("admin-message").textContent = "Publishing announcement…";
    try {
      await api("/api/admin/announce", { method: "POST", headers: auth(), body: JSON.stringify({ message }) });
      if (document.activeElement !== $("announcement-input")) $("announcement-input").value = message;
      await refresh();
      $("admin-message").textContent = "Announcement published successfully.";
    } catch (error) {
      $("admin-message").textContent = "Could not publish: " + error.message;
    } finally { button.disabled = false; }
  });
  $("export-attendance-button").addEventListener("click", () => {
    const rows = [["Display name","Status","Joined at"], ...(latestStatus?.members || []).map(m => [m.displayName, m.approved ? (m.connected ? "Connected" : "Reconnecting") : "Waiting approval", new Date(m.joinedAt).toISOString()])];
    const csv = rows.map(row => row.map(value => '"' + String(value ?? "").replace(/"/g, '""') + '"').join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "gartic-attendance.csv"; a.click(); URL.revokeObjectURL(url);
  });
  document.body.insertAdjacentHTML("afterbegin", '<button class="theme-toggle" id="theme-toggle" type="button">Toggle theme</button>');
  $("theme-toggle").addEventListener("click", () => document.body.classList.toggle("light-mode"));

  $("announcement-template").addEventListener("change", () => { if ($("announcement-template").value) $("announcement-input").value = $("announcement-template").value; });
  function loadPresets() {
    const select = $("preset-select"); select.replaceChildren(new Option("Saved presets…", ""));
    let presets = []; try { presets = JSON.parse(localStorage.getItem("gartic-admin-presets") || "[]"); } catch (_) {}
    presets.forEach((preset, index) => select.add(new Option(preset.name, String(index))));
  }
  loadPresets();
  $("save-preset-button").addEventListener("click", () => {
    const name = $("preset-name").value.trim(); if (!name) { $("admin-message").textContent = "Enter a name for this preset."; return; }
    let presets = []; try { presets = JSON.parse(localStorage.getItem("gartic-admin-presets") || "[]"); } catch (_) {}
    presets.push({ name, durationMinutes: Number($("duration-minutes").value) || 0, maxParticipants: Number($("max-participants").value) || 0, waitingRoom: $("waiting-room-toggle").checked });
    localStorage.setItem("gartic-admin-presets", JSON.stringify(presets.slice(-20))); loadPresets(); $("admin-message").textContent = "Preset saved in this browser.";
  });
  $("load-preset-button").addEventListener("click", () => {
    const index = Number($("preset-select").value); let presets = [];
    try { presets = JSON.parse(localStorage.getItem("gartic-admin-presets") || "[]"); } catch (_) {}
    const preset = presets[index]; if (!preset) return;
    $("duration-minutes").value = preset.durationMinutes || 0; $("max-participants").value = preset.maxParticipants || 0; $("waiting-room-toggle").checked = Boolean(preset.waitingRoom);
    $("admin-message").textContent = "Preset loaded. Save session settings to apply participant rules.";
  });

  $("regenerate-code-button").addEventListener("click", async () => {
    if (!confirm("Regenerate the session code? All current portal participants will be disconnected and must join with the new code.")) return;
    try { const data = await api("/api/admin/regenerate", { method: "POST", headers: auth() }); await refresh(); $("session-code").textContent = data.code; $("admin-message").textContent = "New session code created. Share it with participants."; }
    catch (error) { $("admin-message").textContent = error.message; }
  });
