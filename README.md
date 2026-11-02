# Gartic Admin

A small classroom session portal with an administrator-controlled session lifecycle. Use only for teacher-approved game sessions.

## Repository files

- `index.html`: student portal
- `admin.html`: administrator dashboard
- `style.css`: shared styling
- `app.js`: browser client
- `worker.js`: Cloudflare Worker API and Durable Object
- `wrangler.toml`: Worker configuration

## Important limitations

- Gartic Phone may block iframe embedding through its own security policy. The portal includes an official-site link as a fallback; do not attempt to bypass those protections.
- Ending a managed session disconnects portal participants and shows an ended screen on their portal. It cannot close an external Gartic Phone tab, control a device, or prevent someone opening the game separately.
- A device that powers off cannot report its departure immediately. This starter version does not yet implement reliable per-device presence reporting.
- This is a session coordination tool, not classroom monitoring or a way to evade school rules.

## Deploy the Worker

1. Install Wrangler on a computer with Node.js, then run `npx wrangler login`.
2. In this repository, run `npx wrangler secret put ADMIN_TOKEN` and enter a long random token. Never put this token in a committed file.
3. Deploy with `npx wrangler deploy`.
4. Copy the deployed Worker URL (for example, `https://gartic-admin-session.<your-subdomain>.workers.dev`).
5. Edit `app.js` and replace `https://YOUR-WORKER.workers.dev` in `API_BASE` with the real URL. Commit the change.

## Publish the website

Enable GitHub Pages for the `main` branch and repository root in the repository's Pages settings. The student portal will be at `/index.html` and the dashboard at `/admin.html`.

## Admin use

1. Open `admin.html` and enter the Worker secret.
2. Select **Start session** and share the generated six-character code with participants.
3. Select **End session** to invalidate the code and show the ended screen to connected portal users.

For a production classroom deployment, add teacher approval, stronger identity-based admin authentication, rate limiting, and a proper participant heartbeat/client identifier before use.