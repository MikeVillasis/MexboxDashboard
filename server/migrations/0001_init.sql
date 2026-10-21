-- Everything is keyed by guild: a member of one server never sees another server's rows.

CREATE TABLE members (
  guild_id     TEXT NOT NULL,
  discord_id   TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_dna   TEXT,                 -- validated recipe JSON (phase 04); NULL until they save one
  last_seen    INTEGER NOT NULL,     -- unix ms
  PRIMARY KEY (guild_id, discord_id)
);

-- Paired Windows apps (phase 06). The device token is only ever stored hashed.
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  discord_id  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  FOREIGN KEY (guild_id, discord_id) REFERENCES members (guild_id, discord_id) ON DELETE CASCADE
);
CREATE INDEX devices_owner ON devices (guild_id, discord_id);

-- Last library summary a device published (phase 07); visible to the whole guild.
CREATE TABLE libraries (
  device_id    TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  games_json   TEXT NOT NULL,
  now_playing  TEXT,
  updated_at   INTEGER NOT NULL
);

-- Short-lived codes shown in the Activity and typed into the Windows app (phase 06).
CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  discord_id  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
