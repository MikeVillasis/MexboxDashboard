# 10 Phone layout: blades take the whole screen
Status: ready-for-agent
Blocked by: 05
Phase: do alongside 07 (owner's call: not a focus before then)

Reported 2026-10-22 after testing on two phones (Discord Android). On a phone the blade stack and its side panel cover
the entire screen, so the plaza is only visible after "hide menu".

## What we know
- Phone CSS from phase 05 (`css/shell.css`, `@media (max-width: 760px), (max-height: 520px)`) makes the side panel span
  the blade width; the blade stack spans the screen minus 6 px gutters.
- "hide menu" (friends blade) works on phones and the followed friend is centred, so the plaza is reachable, just not
  alongside the panel.

## Directions to weigh (pick one with the owner)
- Bottom sheet on phones: the panel docks to the bottom ~40% of the screen, the plaza fills the top; drag to expand.
- Collapsed by default on phones, with a compact floating toolbar (friends list, avatar, menu).
- Shorter panel content on phones (hide residents/help text), panel height capped.

## Done when
- On a phone in portrait, the plaza and the friends list are visible at the same time without tapping "hide menu".
- The avatar customiser still shows your avatar while editing.
- Desktop and the Windows app layouts are unchanged.
