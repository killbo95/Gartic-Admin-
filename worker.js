export class SessionRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const body = async () => { try { return await request.json(); } catch { return {}; } };
    let state = await this.ctx.storage.get("session") || { active: false, code: null, members: {} };
    if (url.pathname === "/status" && request.method === "GET") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      return Response.json({ active: state.active && state.code === code });
    }
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const data = await body();
      if (!state.active || state.code !== String(data.code || "").toUpperCase()) return Response.json({ error: "Session ended" }, { status: 410 });
      state.members ||= {}; state.members[data.clientId || "portal"] = Date.now();
      await this.ctx.storage.put("session", state);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/leave" && request.method === "POST") return Response.json({ ok: true });
    if (url.pathname === "/admin-status" && request.method === "GET") return Response.json({ active: state.active, code: state.active ? state.code : null });
    if (url.pathname === "/start" && request.method === "POST") {
      if (state.active) return Response.json({ error: "A session is already active." }, { status: 409 });
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = new Uint8Array(6); crypto.getRandomValues(bytes);
      const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
      state = { active: true, code, startedAt: Date.now(), members: {} };
      await this.ctx.storage.put("session", state);
      return Response.json({ active: true, code });
    }
    if (url.pathname === "/end" && request.method === "POST") {
      state = { active: false, code: null, endedAt: Date.now(), members: {} };
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
    const headers = { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token", "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const adminPaths = ["/api/admin/status", "/api/admin/start", "/api/admin/end"];
    if (adminPaths.includes(url.pathname) && request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) return Response.json({ error: "Unauthorized. Check the admin token." }, { status: 401, headers });
    const room = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName("main"));
    const routes = { "/api/status": "/status", "/api/heartbeat": "/heartbeat", "/api/leave": "/leave", "/api/admin/status": "/admin-status", "/api/admin/start": "/start", "/api/admin/end": "/end" };
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