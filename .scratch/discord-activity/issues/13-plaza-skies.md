# 13 Plaza skies (procedural backgrounds)
Status: done
Blocked by: none

Requested 2026-10-23: procedural sky shader instead of an HDR, several backgrounds switchable from the plaza menu, the
first reproducing a long-exposure light-painting photo (Zak on Unsplash, credited bottom-left while it's on).

## Comments
- 2026-10-23: `js/scene/Sky.js`. "classic" keeps the blade-tinted flat sky (default; Windows unchanged unless picked).
  "neon trails": 12 curtains of stacked wavy anti-aliased neon lines (blue → violet → magenta → red, coil/net layer,
  slow drift) on a wall cylinder round the plaza (the elevated plaza camera barely sees the sky, so a dome alone
  can't carry it), a dark studio dome, and an additive floor glow pooling each curtain's colour. Fixed fog/floor/light
  look while on. Picker in the plaza panel, remembered per viewer; credit links via host OpenExternal. Low tier drops
  the coil layer. Compared side by side with the reference over three tuning passes.
- 2026-10-23: owner checked neon trails in Discord; sky picker turned into a scrolling dropdown (opens in the panel flow, closes on pick or outside click). Reference photo committed with a credit README.
- 2026-10-23: added "city night" (aerial blue-hour city after MF Evelyn's photo): the plaza becomes a 15 m rooftop
  (`floorScale`) over a dome-shader city: rays hit a ground plane 90 m down; varied lots, sparse lit windows, signs,
  blinking aviation lights, parks, a winding highway with tail/headlight streams, distance haze, blue-hour sky.
  Presets now choose their parts (`parts`); low tier drops windows/signs/traffic. Credit bottom-left while on.
