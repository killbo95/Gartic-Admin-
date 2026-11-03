export class SessionRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const readBody = async () => { try { return await request.json(); } catch { return {}; } };
    let state = await this.ctx.storage.get("session") || { active: false, code: null, gameUrl: null, members: {}, kicked: {}, locked: false };

    if (url.pathname === "/status" && request.method === "GET") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      const clientId = url.searchParams.get("clientId") || "";
      const matches = state.active && state.code === code;
      if (!matches) return Response.json({ active: false });
      if (clientId && state.kicked?.[clientId]) return Response.json({ active: true, kicked: true, locked: Boolean(state.locked) });
      return Response.json({ active: true, locked: Boolean(state.locked), gameUrl: state.gameUrl });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const data = await readBody();
      if (!state.active || state.code !== String(data.code || "").toUpperCase()) {
        return Response.json({ error: "Session ended" }, { status: 410 });
      }
      const clientId = String(data.clientId || "");
      if (!clientId || state.kicked?.[clientId]) return Response.json({ error: "You were disconnected by the administrator." }, { status: 403 });
      state.members ||= {};
      if (state.locked && !state.members[clientId]) return Response.json({ error: "This session is locked to new participants." }, { status: 423 });
      state.members[clientId] = { lastSeen: Date.now() };
      await this.ctx.storage.put("session", state);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/leave" && request.method === "POST") {
      const data = await readBody();
      if (data.clientId && state.members) delete state.members[data.clientId];
      await this.ctx.storage.put("session", state);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/admin-status" && request.method === "GET") {
      const now = Date.now();
      state.members ||= {};
      const members = Object.entries(state.members)
        .filter(([, member]) => now - (member.lastSeen || 0) < 20000)
        .map(([clientId]) => ({ clientId, joined: true }));
      for (const [id, member] of Object.entries(state.members)) {
        if (now - (member.lastSeen || 0) >= 20000) delete state.members[id];
      }
      await this.ctx.storage.put("session", state);
      return Response.json({
        active: Boolean(state.active), code: state.active ? state.code : null,
        gameUrl: state.active ? state.gameUrl || null : null,
        locked: Boolean(state.locked), members
      });
    }

    if (url.pathname === "/lock" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      state.locked = Boolean(data.locked);
      await this.ctx.storage.put("session", state);
      return Response.json({ active: true, locked: state.locked });
    }

    if (url.pathname === "/kick" && request.method === "POST") {
      const data = await readBody();
      if (!state.active) return Response.json({ error: "No active session." }, { status: 409 });
      const clientId = String(data.clientId || "");
      if (!clientId || !state.members?.[clientId]) return Response.json({ error: "Participant is no longer connected." }, { status: 404 });
      state.kicked ||= {};
      state.kicked[clientId] = true;
      delete state.members[clientId];
      await this.ctx.storage.put("session", state);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      if (state.active) return Response.json({ error: "A session is already active." }, { status: 409 });
      const data = await readBody();
      let parsed;
      try { parsed = new URL(String(data.gameUrl || "")); } catch (_) {
        return Response.json({ error: "Enter a valid Gartic Phone invitation URL." }, { status: 400 });
      }
      if (parsed.protocol !== "https:" || !["garticphone.com", "www.garticphone.com"].includes(parsed.hostname)) {
        return Response.json({ error: "Only HTTPS invitation links from garticphone.com are accepted." }, { status: 400 });
      }
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
      state = { active: true, code, gameUrl: parsed.href, startedAt: Date.now(), members: {}, kicked: {}, locked: false };
      await this.ctx.storage.put("session", state);
      return Response.json({ active: true, code, gameUrl: state.gameUrl });
    }

    if (url.pathname === "/end" && request.method === "POST") {
      state = { active: false, code: null, gameUrl: null, endedAt: Date.now(), members: {}, kicked: {}, locked: false };
      await this.ctx.storage.put("session", state);
      return Response.json({ active: false });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGIN || "*";
    const headers = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers });

    const adminPaths = ["/api/admin/status", "/api/admin/start", "/api/admin/end", "/api/admin/lock", "/api/admin/kick"];
    if (adminPaths.includes(url.pathname) && request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) {
      return Response.json({ error: "Unauthorized. Check the admin token." }, { status: 401, headers });
    }

    const room = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName("main"));
    const routes = {
      "/api/status": "/status", "/api/heartbeat": "/heartbeat", "/api/leave": "/leave",
      "/api/admin/status": "/admin-status", "/api/admin/start": "/start", "/api/admin/end": "/end",
      "/api/admin/lock": "/lock", "/api/admin/kick": "/kick"
    };
    const target = routes[url.pathname];
    if (!target) return Response.json({ error: "Not found" }, { status: 404, headers });

    const internalUrl = new URL("https://session.internal" + target);
    if (request.method === "GET") internalUrl.search = url.search;
    const forwarded = new Request(internalUrl, request);
    const response = await room.fetch(forwarded);
    const outHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) outHeaders.set(key, value);
    return new Response(response.body, { status: response.status, headers: outHeaders });
  }
};
