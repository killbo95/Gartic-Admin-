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
  let code = "";
  let poller;
  const gameFrame = $("game-frame");
  const gameLink = $("game-room-link");

  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("join-message").textContent = "Checking session…";
    code = $("room-code").value.trim().toUpperCase();
    try {
      const data = await api("/api/status?code=" + encodeURIComponent(code));
      if (!data.active) throw new Error("That session is not active. Check the code with the administrator.");
      if (!data.gameUrl || !isOfficialRoomUrl(data.gameUrl)) throw new Error("The administrator has not added a valid private Gartic Phone room link yet.");
      show("join-panel", false);
      show("session-panel", true);
      $("session-status").textContent = "Connected to session " + code + ".";
      gameLink.href = data.gameUrl;
      gameFrame.src = data.gameUrl;
      await heartbeat();
      poller = setInterval(checkStatus, 4000);
    } catch (error) {
      code = "";
      $("join-message").textContent = error.message;
    }
  });

  async function heartbeat() {
    if (!code) return;
    try { await api("/api/heartbeat", { method: "POST", body: JSON.stringify({ code }) }); } catch (_) {}
  }
  async function checkStatus() {
    try {
      const data = await api("/api/status?code=" + encodeURIComponent(code));
      if (!data.active) endLocalSession();
      else {
        if (data.gameUrl && gameLink.href !== data.gameUrl) {
          gameLink.href = data.gameUrl;
          gameFrame.src = data.gameUrl;
        }
        await heartbeat();
      }
    } catch (_) {
      $("session-status").textContent = "Connection interrupted. Reconnecting…";
    }
  }
  function endLocalSession() {
    clearInterval(poller);
    code = "";
    gameFrame.src = "about:blank";
    gameLink.href = "#";
    show("session-panel", false);
    show("join-panel", false);
    show("ended-panel", true);
  }
  $("back-button").addEventListener("click", () => {
    show("ended-panel", false);
    show("join-panel", true);
    $("room-code").value = "";
    $("join-message").textContent = "";
  });
  window.addEventListener("pagehide", () => {
    if (code && navigator.sendBeacon) {
      navigator.sendBeacon(API_BASE + "/api/leave", new Blob([JSON.stringify({ code })], { type: "application/json" }));
    }
  });
}

if (document.body.dataset.page === "admin") {
  let token = "";
  const auth = () => ({ "X-Admin-Token": token });

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
      $("admin-message").textContent = "Connected.";
    } catch (error) {
      token = "";
      $("admin-message").textContent = error.message;
    }
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
    if (active) {
      $("session-code").textContent = data.code;
      $("game-url").value = data.gameUrl || "";
      $("admin-game-link").href = data.gameUrl || "#";
      $("active-room-wrap").hidden = !data.gameUrl;
    } else {
      $("active-room-wrap").hidden = true;
    }
  }

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
        body: JSON.stringify({ gameUrl })
      });
      await refresh();
      $("session-code").textContent = data.code;
      $("admin-message").textContent = "Session started. Share the code with your participants.";
    } catch (error) {
      $("admin-message").textContent = error.message;
    }
  });

  $("end-button").addEventListener("click", async () => {
    if (!confirm("End this managed session for all connected portal users?")) return;
    try {
      await api("/api/admin/end", { method: "POST", headers: auth() });
      await refresh();
      $("game-url").value = "";
      $("admin-message").textContent = "Session ended.";
    } catch (error) {
      $("admin-message").textContent = error.message;
    }
  });
}
