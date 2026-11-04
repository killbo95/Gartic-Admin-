export class SessionRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async alarm() {
    let state = await this.ctx.storage.get("session");
    if (!state?.active || !state.endsAt) return;
    if (state.endsAt > Date.now()) { await this.ctx.storage.setAlarm(state.endsAt); return; }
    state.history ||= [];
    state.history.unshift({ code: state.code, startedAt: state.startedAt, endedAt: Date.now(), participants: Object.keys(state.members || {}).length, reason: "Time limit reached" });
    state.history = state.history.slice(0, 30);
    state.active = false; state.code = null; state.gameUrl = null; state.members = {}; state.kicked = {}; state.locked = false; state.paused = false; state.announcement = "";
    await this.ctx.storage.put("session", state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const readBody = async () => { try { return await request.json(); } catch { return {}; } };
    let state = await this.ctx.storage.get("session") || {
      active: false, code: null, gameUrl: null, gameType: "garticphone", members: {}, kicked: {}, locked: false,
      paused: false, waitingRoom: false, maxParticipants: 0, announcement: "",
      messages: [], activity: [], history: []
    };
    state.members ||= {}; state.kicked ||= {}; state.messages ||= [];
    state.activity ||= []; state.history ||= [];
    const log = (type, detail = "") => {
      state.activity.unshift({ type, detail, at: Date.now() });
      state.activity = state.activity.slice(0, 100);
    };
    const save = async () => this.ctx.storage.put("session", state);
    const cleanName = value => String(value || "Student").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, 24) || "Student";

    if (url.pathname === "/status" && request.method === "GET") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      const clientId = url.searchParams.get("clientId") || "";
      const displayName = cleanName(url.searchParams.get("displayName"));
      if (!state.active || state.code !== code) return Response.json({ active: false });
      if (clientId && state.kicked[clientId]) return Response.json({ active: true, kicked: true });
      let member = state.members[clientId];
      if (clientId && !member) {
        if (state.locked) return Response.json({ active: true, locked: true });
        const activeCount = Object.values(state.members).filter(m => m.approved).length;
        if (state.maxParticipants > 0 && activeCount >= state.maxParticipants) return Response.json({ active: true, full: true });
        member = { displayName, joinedAt: Date.now(), lastSeen: Date.now(), approved: !state.waitingRoom };
        state.members[clientId] = member;
        log(state.waitingRoom ? "Join request" : "Participant joined", displayName);
        await save();
      }
      member = state.members[clientId] || {};
      return Response.json({
        active: true, waiting: Boolean(member.approved === false), paused: Boolean(state.paused),
        gameUrl: member.approved ? state.gameUrl : null, gameType: state.gameType || "garticphone", announcement: state.announcement || "",
        warning: member.warning || "", displayName: member.displayName || displayName
      });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const data = await readBody();
      if (!state.active || state.code !== String(data.code || "").toUpperCase()) return Response.json({ error: "Session ended" }, { status: 410 });
      const clientId = String(data.clientId || "");
      const member = state.members[clientId];
      if (!clientId || state.kicked[clientId]) return Response.json({ error: "You were disconnected by the administrator." }, { status: 403 });
      if (!member || !member.approved) return Response.json({ error: "Waiting for administrator approval." }, { status: 403 });
      member.lastSeen = Date.now();
      await save();
      return Response.json({ ok: true, paused: Boolean(state.paused) });
    }

    if (url.pathname === "/leave" && request.method === "POST") {
      const data = await readBody();
      if (data.clientId && state.members[data.clientId]) {
        log("Participant left", state.members[data.clientId].displayName);
        delete state.members[data.clientId];
      }
      await save();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/admin-status" && request.method === "GET") {
      const now = Date.now();
      for (const [id, member] of Object.entries(state.members)) {
        const staleLimit = member.approved ? 25000 : 10 * 60 * 1000;
        const lastActivity = member.approved ? (member.lastSeen || 0) : (member.joinedAt || 0);
        if (now - lastActivity >= staleLimit) {
          if (member.approved) log("Participant timed out", member.displayName);
          delete state.members[id];
        }
      }
      await save();
      const members = Object.entries(state.members).map(([clientId, m]) => ({
        clientId, displayName: m.displayName, warning: m.warning || "", approved: Boolean(m.approved),
        connected: !m.approved ? false : now - (m.lastSeen || 0) < 12000,
        joinedAt: m.joinedAt
      }));
      return Response.json({
        active: Boolean(state.active), code: state.active ? state.code : null,
        gameUrl: state.active ? state.gameUrl || null : null, gameType: state.active ? state.gameType || "garticphone" : null, locked: Boolean(state.locked),
        paused: Boolean(state.paused), waitingRoom: Boolean(state.waitingRoom), endsAt: state.endsAt || null,
        maxParticipants: state.maxParticipants || 0, announcement: state.announcement || "",
        members, messages: state.messages, activity: state.activity, history: state.history
      });
    }

    if (url.pathname === "/lock" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      state.locked = Boolean(data.locked); log(state.locked ? "Joining locked" : "Joining unlocked");
      await save(); return Response.json({ active: true, locked: state.locked });
    }

    if (url.pathname === "/pause" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      state.paused = Boolean(data.paused); log(state.paused ? "Session paused" : "Session resumed");
      await save(); return Response.json({ active: true, paused: state.paused });
    }

    if (url.pathname === "/settings" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      state.waitingRoom = Boolean(data.waitingRoom);
      state.maxParticipants = Math.max(0, Math.min(200, Number(data.maxParticipants) || 0));
      log("Session settings updated");
      await save(); return Response.json({ waitingRoom: state.waitingRoom, maxParticipants: state.maxParticipants });
    }

    if (url.pathname === "/approve" && request.method === "POST") {
      const data = await readBody(); const member = state.members[String(data.clientId || "")];
      if (!state.active || !member) return Response.json({ error: "Participant is no longer waiting." }, { status: 404 });
      const approvedCount = Object.values(state.members).filter(item => item.approved).length;
      if (state.maxParticipants > 0 && approvedCount >= state.maxParticipants) return Response.json({ error: "The participant limit has been reached." }, { status: 409 });
      member.approved = true; member.lastSeen = Date.now(); log("Participant approved", member.displayName);
      await save(); return Response.json({ ok: true });
    }

    if (url.pathname === "/warn" && request.method === "POST") {
      const data = await readBody(); const member = state.members[String(data.clientId || "")];
      const warning = String(data.message || "").trim().slice(0, 180);
      if (!state.active || !member || !member.approved || !warning) return Response.json({ error: "Could not send warning to this participant." }, { status: 400 });
      member.warning = warning; log("Participant warning", member.displayName + ": " + warning);
      await save(); return Response.json({ ok: true });
    }

    if (url.pathname === "/regenerate" && request.method === "POST") {
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
      state.code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
      state.members = {}; state.kicked = {}; log("Session code regenerated; participants must rejoin");
      await save(); return Response.json({ ok: true, code: state.code });
    }

    if (url.pathname === "/announce" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      state.announcement = String(data.message || "").trim().slice(0, 240);
      log("Announcement updated", state.announcement);
      await save(); return Response.json({ ok: true });
    }

    if (url.pathname === "/message" && request.method === "POST") {
      const data = await readBody(); const clientId = String(data.clientId || "");
      const member = state.members[clientId]; const message = String(data.message || "").trim().slice(0, 300);
      if (!state.active || !member?.approved || !message) return Response.json({ error: "Message could not be sent." }, { status: 400 });
      state.messages.unshift({ from: member.displayName, message, at: Date.now() });
      state.messages = state.messages.slice(0, 100); log("Student message", member.displayName);
      await save(); return Response.json({ ok: true });
    }

    if (url.pathname === "/kick" && request.method === "POST") {
      const data = await readBody(); const clientId = String(data.clientId || "");
      if (!state.active || !state.members[clientId]) return Response.json({ error: "Participant is no longer connected." }, { status: 404 });
      state.kicked[clientId] = true; log("Participant disconnected", state.members[clientId].displayName);
      delete state.members[clientId]; await save(); return Response.json({ ok: true });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      if (state.active) return Response.json({ error: "A session is already active." }, { status: 409 });
      const data = await readBody(); let parsed;
      const gameType = data.gameType === "makeitmeme" ? "makeitmeme" : "garticphone";
      try { parsed = new URL(String(data.gameUrl || "")); } catch { return Response.json({ error: "Enter a valid official game invitation URL." }, { status: 400 }); }
      const allowedHosts = gameType === "makeitmeme" ? ["makeitmeme.com", "www.makeitmeme.com"] : ["garticphone.com", "www.garticphone.com"];
      if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) return Response.json({ error: gameType === "makeitmeme" ? "Only HTTPS invitation links from makeitmeme.com are accepted." : "Only HTTPS invitation links from garticphone.com are accepted." }, { status: 400 });
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
      const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
      const durationMinutes = Math.max(0, Math.min(360, Number(data.durationMinutes) || 0));
      const endsAt = durationMinutes ? Date.now() + durationMinutes * 60000 : null;
      state = {
        active: true, code, gameUrl: parsed.href, gameType, startedAt: Date.now(), endsAt, members: {}, kicked: {},
        locked: false, paused: false, waitingRoom: false, maxParticipants: 0,
        announcement: "", messages: [], activity: [{ type: "Session started", detail: "", at: Date.now() }],
        history: state.history || []
      };
      await save();
      if (endsAt) await this.ctx.storage.setAlarm(endsAt); else await this.ctx.storage.deleteAlarm();
      return Response.json({ active: true, code, gameUrl: state.gameUrl, gameType: state.gameType, endsAt });
    }

    if (url.pathname === "/end" && request.method === "POST") {
      if (state.active) {
        state.history.unshift({ code: state.code, startedAt: state.startedAt, endedAt: Date.now(), participants: Object.keys(state.members).length });
        state.history = state.history.slice(0, 30);
      }
      state = { ...state, active: false, code: null, gameUrl: null, endedAt: Date.now(), endsAt: null, members: {}, kicked: {}, locked: false, paused: false, announcement: "" };
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("session", state); return Response.json({ active: false });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGIN || "*";
    const headers = {
      "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token", "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const adminPaths = ["/api/admin/status", "/api/admin/start", "/api/admin/end", "/api/admin/lock", "/api/admin/kick", "/api/admin/pause", "/api/admin/settings", "/api/admin/approve", "/api/admin/announce", "/api/admin/warn", "/api/admin/regenerate"];
    if (adminPaths.includes(url.pathname) && request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) return Response.json({ error: "Unauthorized. Check the admin token." }, { status: 401, headers });
    const room = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName("main"));
    const routes = {
      "/api/status": "/status", "/api/heartbeat": "/heartbeat", "/api/leave": "/leave", "/api/message": "/message",
      "/api/admin/status": "/admin-status", "/api/admin/start": "/start", "/api/admin/end": "/end",
      "/api/admin/lock": "/lock", "/api/admin/kick": "/kick", "/api/admin/pause": "/pause",
      "/api/admin/settings": "/settings", "/api/admin/approve": "/approve", "/api/admin/announce": "/announce",
      "/api/admin/warn": "/warn", "/api/admin/regenerate": "/regenerate"
    };
    const target = routes[url.pathname];
    if (!target) return Response.json({ error: "Not found" }, { status: 404, headers });
    const internalUrl = new URL("https://session.internal" + target);
    if (request.method === "GET") internalUrl.search = url.search;
    const response = await room.fetch(new Request(internalUrl, request));
    const outHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) outHeaders.set(key, value);
    return new Response(response.body, { status: response.status, headers: outHeaders });
  }
};