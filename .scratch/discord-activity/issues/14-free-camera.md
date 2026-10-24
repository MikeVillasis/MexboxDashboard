# 14 Free camera on the plaza
Status: done (tested in Discord 2026-10-24)
Blocked by: none

Requested 2026-10-24: move freely across the plaza with mouse/trackpad: hold left click and drag to move; scroll wheel
and trackpad gestures to zoom. Discord Activity only for now (host option `cameraControls`; Windows unchanged).

## Comments
- 2026-10-24: `CameraDirector` user pan (≤16 m) and zoom (0.3–1.6×) on the plaza shot, kept across blade changes, R
  resets. Ground drag is "grab the map": measured against the director's intended view from the press point, the
  camera snaps (no easing) while dragging; verified the grabbed point lands 4 mm from the cursor. Click without moving
  still walks your avatar (on release); dragging an avatar still carries it; dragging while following a friend takes
  over from the follow view and clears the selection. Wheel zooms (pinch = ctrl+wheel, finer), sideways two-finger
  swipes pan; touch: one-finger drag pans, two-finger pinch zooms. Idle drift is now a sideways glide (position and
  look-at) so taking control never jumps; it stops once you move the camera, returns after R.
- 2026-10-24: plaza-only mode (menu hidden, H) keeps a camera tips pill on the HUD (`#camera-tips`): drag/scroll/
  click/r/h keys with a fine pointer, "drag to move · pinch to zoom · tap to walk" on touch; sits above the sky credit
  on phones. Only shown with `cameraControls`, so the Windows/stub hosts never show it.
