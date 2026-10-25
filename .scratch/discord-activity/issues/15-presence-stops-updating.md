# 15 Thought bubbles stop updating after ~20 minutes
Status: needs-triage
Blocked by: none (follows 11)

Reported 2026-10-24 by the owner, from testing in Discord: after about 20 minutes in the Activity, members' statuses
(thought bubbles from Discord presence) stop being tracked. Bubbles freeze on whatever they last showed and no longer
change when someone starts/stops a game or song.

## Repro (to confirm)
- Open the Activity with two members, both with "Share my activity" on; change a status every few minutes.
- Note the time the last change shows up. Check whether it's tied to elapsed time (~20 min) or to something else
  (room emptying briefly, phone backgrounding, a member leaving and rejoining).
- Does closing and reopening the Activity bring updates back? (Separates a dead hub connection from a stale client.)

## Leads (unverified)
- `server/src/presence-hub.ts` heartbeats with `setInterval`; a comment in the same file notes timers set after an
  invocation ends may never fire in a Durable Object. If the heartbeat stops, Discord drops the connection after missed
  ACKs; does the 5 s alarm then reconnect and re-IDENTIFY, or does it think the socket is still open?
- Gateway reconnect handling: op 7 (reconnect) and op 9 (invalid session) closes, and whether a reconnect re-subscribes
  the guild / re-sends statuses to the rooms. Discord periodically asks long-lived sessions to reconnect.
- After a reconnect, rooms may need a fresh status snapshot (WELCOME.statuses only goes to new joiners).
- Client side: `activity/src/RoomTransport.js` could stop receiving `STATUS` while moves still work (check both).
- Worker logs (observability is on) around the time updates stop: close codes, reconnects, alarm activity.

## Done when
Statuses keep updating through an hour-long session in Discord, and a dropped Gateway connection recovers on its own
(covered by a server test with the fake Gateway forcing a close / op 7 mid-session).
