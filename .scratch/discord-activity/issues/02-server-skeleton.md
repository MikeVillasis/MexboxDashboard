# 02 Cloudflare server skeleton
Status: in-progress (code + tests done; deploy needs owner setup, see server/README.md)
Blocked by: none

- `server/`: Worker in TypeScript, `wrangler.toml`, D1 migrations (users, devices, libraries, pairing_codes).
- `POST /api/token`: exchange Discord OAuth code; client secret via `wrangler secret`.
- Done when: deployed to workers.dev, token exchange works with a real Discord app.
- Guild allowlist (`ALLOWED_GUILD_IDS`), token verification helper, CORS to the Discord proxy origin only.

## Comments
- 2026-10-21: Worker, D1 schema, token exchange, member verification with guild allowlist, origin check, 11 tests passing, dry-run build OK. Not deployed: needs Discord app + Cloudflare login.
