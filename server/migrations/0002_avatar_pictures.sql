-- Discord profile pictures for gamercards: the avatar hashes Discord returns with the member on sign-in.
-- Only hashes are stored; images are fetched from Discord's CDN on demand (GET /api/avatar-image/:code).
ALTER TABLE members ADD COLUMN avatar_hash TEXT;        -- the user's Discord avatar
ALTER TABLE members ADD COLUMN guild_avatar_hash TEXT;  -- their server-specific avatar, if they set one (preferred)
