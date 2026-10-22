// Local multi-user Activity: the real Worker, room and D1 (wrangler dev, all local) with a fake Discord API and the
// --dev front end (fake SDK). Nothing touches Discord or your Cloudflare account.
//
//   node tools/activity-dev/dev.mjs
//   then open http://localhost:8787/?user=ana&guild=111111111111111111&instance=room1
//        and http://localhost:8787/?user=ben&guild=111111111111111111&instance=room1   (another tab = another member)
//
// Any alphanumeric ?user= is a member of the dev guild; ?user=outsider is a member of no guild.
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const GUILD = "111111111111111111";
const FAKE_DISCORD_PORT = 8788;
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
    send(404, { message: "not faked" });
  });
});
fakeDiscord.listen(FAKE_DISCORD_PORT, "127.0.0.1");

execFileSync("node", [path.join(root, "activity", "build.mjs"), "--dev"], { stdio: "inherit" });
const wrangler = ["--prefix", path.join(root, "server"), "wrangler"];
const config = ["--config", path.join(root, "server", "wrangler.toml")];
execFileSync("npx", [...wrangler, "d1", "migrations", "apply", "mexbox", "--local", ...config], { stdio: "inherit", cwd: root, input: "y\n" });

const dev = spawn("npx", [
  ...wrangler, "dev", ...config, "--local", "--port", String(PORT),
  "--assets", path.join(root, "activity", "dist-dev"),
  "--var", `DISCORD_API:http://127.0.0.1:${FAKE_DISCORD_PORT}/api`,
  "--var", `ALLOWED_GUILD_IDS:${GUILD}`,
  "--var", "DISCORD_CLIENT_SECRET:dev-only",
  "--var", `EXTRA_ORIGINS:http://localhost:${PORT}`,
], { stdio: "inherit", cwd: root });

console.log(`\nfake discord on :${FAKE_DISCORD_PORT}; activity on http://localhost:${PORT}/?user=ana&guild=${GUILD}&instance=room1\n`);
const stop = () => { dev.kill("SIGINT"); fakeDiscord.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dev.on("exit", (code) => { fakeDiscord.close(); process.exit(code ?? 0); });
