# 05 Mobile and performance pass
Status: done
Blocked by: 04

- Quality tiers (shadows, pixel ratio, avatar cap), touch input for blades and drag/grab.
- Done when: usable on Discord mobile and a low-end laptop at a steady frame rate.
- No gamepad support (decided).

## Comments
- 2026-10-22: `js/scene/Quality.js` tiers (high/medium/low: pixel ratio, shadows, avatar cap 48/24/12) + FrameMonitor
  (auto: steps down below 40 fps, never up). Hosts pick: Windows "high" (unchanged), Discord phones "low"
  (`?platform=mobile`), Discord desktop "auto". Avatar cap draws you + followed + live friends first, residents last.
  Phone CSS (≤760px wide or ≤520px tall), touch: no browser pan/zoom on the canvas, swipe blades, bigger targets,
  hints hidden on coarse pointers. Portrait camera widens FOV (cap 78°); follow framing centred on narrow screens.
  Host option `manualFriends: false` hides add-a-friend in Discord. Checked at 375x812 touch: layout, swipe,
  follow + collapse, cap (12 of 26), step-down high→medium→low with no GL errors; stub (Windows path) unchanged.
- 2026-10-22: tested on two Android phones in Discord (needed Supported Platforms → Android in the developer portal).
  Fixed: a friend who rejoined could stay asleep. Cause: the away list and the room could spawn the same friend at
  once, leaving an orphan sleeping copy. `Plaza.upsertFriend` now shares one build per id and applies the latest role;
  presence beats the away list; leaves go through `Plaza.setAway`. Phone blade space moved to ticket 10 (with 07).
