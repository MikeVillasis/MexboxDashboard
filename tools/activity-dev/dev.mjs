// Local multi-user Activity: the real Worker, room and D1 (wrangler dev, all local) with a fake Discord API and the
// --dev front end (fake SDK). Nothing touches Discord or your Cloudflare account.
//
//   node tools/activity-dev/dev.mjs
//   then open http://localhost:8787/?user=ana&guild=111111111111111111&instance=room1
//        and http://localhost:8787/?user=ben&guild=111111111111111111&instance=room1   (another tab = another member)
//
// Any alphanumeric ?user= is a member of the dev guild; ?user=outsider is a member of no guild.
//
// A fake Discord Gateway (thought bubbles) starts with ana listening to music and ben playing a game. Change someone's
// status while it runs:  curl "http://127.0.0.1:8788/dev/presence?user=ben&playing=Portal%202"
//                        (&listening=Song%20–%20Artist, &watching=..., or nothing to clear)
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const GUILD = "111111111111111111";
const FAKE_DISCORD_PORT = 8788;
const FAKE_GATEWAY_PORT = 8789;
const { WebSocketServer } = createRequire(path.join(root, "activity", "package.json"))("ws");
const PORT = 8787;

/** Stable fake snowflake per user name. */
const idFor = (user) => String(400000000000000000n + BigInt([...user].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e9, 7)));

const fakeDiscord = http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/oauth2/token") {
      const code = new URLSearchParams(body).get("code") ?? "";
      if (!code.startsWith("devcode")) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `devtoken-${code.slice(7)}`, expires_in: 604800, scope: "identify guilds.members.read" });
    }
    const member = req.url?.match(/^\/api\/users\/@me\/guilds\/(\d+)\/member$/);
    if (member) {
      const user = (req.headers.authorization ?? "").replace(/^Bearer devtoken-/, "");
      if (!user || user === req.headers.authorization) return send(401, { message: "401: Unauthorized" });
      if (user === "outsider" || member[1] !== GUILD) return send(404, { message: "Unknown Guild" });
      return send(200, { nick: null, user: { id: idFor(user), username: user, global_name: user[0].toUpperCase() + user.slice(1) } });
    }
    if (req.url?.startsWith("/dev/presence")) {
      const q = new URL(req.url, "http://x").searchParams;
      const user = q.get("user") ?? "";
      presences.set(user, activitiesFrom(q));
      for (const ws of gateway.clients) dispatch(ws, "PRESENCE_UPDATE", presence(user));
      return send(200, { user, activities: presences.get(user) });
    }
    send(404, { message: "not faked" });
  });
});
fakeDiscord.listen(FAKE_DISCORD_PORT, "127.0.0.1");

// ───────────── Fake Gateway: HELLO → IDENTIFY → READY + GUILD_CREATE (presences) → PRESENCE_UPDATE ─────────────

const presences = new Map([
  ["ana", [{ type: 2, name: "Spotify", details: "Still Alive", state: "GLaDOS" }]],
  ["ben", [{ type: 0, name: "Halo Infinite" }]],
]);
function activitiesFrom(q) {
  if (q.get("playing")) return [{ type: 0, name: q.get("playing") }];
  if (q.get("listening")) { const [details, state] = q.get("listening").split(" – "); return [{ type: 2, name: "Spotify", details, state }]; }
  if (q.get("watching")) return [{ type: 3, name: "YouTube", details: q.get("watching") }];
  return [];
}
const presence = (user) => ({ guild_id: GUILD, user: { id: idFor(user) }, status: "online", activities: presences.get(user) ?? [] });
let seq = 0;
const dispatch = (ws, t, d) => ws.send(JSON.stringify({ op: 0, s: ++seq, t, d }));

const gateway = new WebSocketServer({ port: FAKE_GATEWAY_PORT, host: "127.0.0.1" });
gateway.on("connection", (ws) => {
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 10000 } }));
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
    if (m.op === 2) {
      if (m.d?.token !== "dev-bot" || !(m.d?.intents & (1 << 8))) { ws.close(4004, "bad token or missing presence intent"); return; }
      console.log("fake gateway: bot identified");
      dispatch(ws, "READY", { session_id: "dev", user: { id: "1", username: "mexbox" } });
      dispatch(ws, "GUILD_CREATE", { id: GUILD, presences: [...presences.keys()].map(presence) });
    }
  });
});

execFileSync("node", [path.join(root, "activity", "build.mjs"), "--dev"], { stdio: "inherit" });
const wrangler = ["--prefix", path.join(root, "server"), "wrangler"];
const config = ["--config", path.join(root, "server", "wrangler.toml")];
// Windows: npx is npx.cmd, and Node only runs .cmd files through a shell (arguments here contain no spaces).
const win = process.platform === "win32";
const NPX = win ? "npx.cmd" : "npx";
execFileSync(NPX, [...wrangler, "d1", "migrations", "apply", "mexbox", "--local", ...config], { stdio: "inherit", cwd: root, input: "y\n", shell: win });

const dev = spawn(NPX, [
  ...wrangler, "dev", ...config, "--local", "--port", String(PORT),
  "--assets", path.join(root, "activity", "dist-dev"),
  "--var", `DISCORD_API:http://127.0.0.1:${FAKE_DISCORD_PORT}/api`,
  "--var", `ALLOWED_GUILD_IDS:${GUILD}`,
  "--var", "DISCORD_CLIENT_SECRET:dev-only",
  "--var", "DISCORD_BOT_TOKEN:dev-bot",
  "--var", `DISCORD_GATEWAY:http://127.0.0.1:${FAKE_GATEWAY_PORT}/`,
  "--var", `EXTRA_ORIGINS:http://localhost:${PORT}`,
], { stdio: "inherit", cwd: root, shell: win });

console.log(`\nfake discord on :${FAKE_DISCORD_PORT}; activity on http://localhost:${PORT}/?user=ana&guild=${GUILD}&instance=room1\n`);
const stop = () => { dev.kill("SIGINT"); fakeDiscord.close(); gateway.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dev.on("exit", (code) => { fakeDiscord.close(); gateway.close(); process.exit(code ?? 0); });
