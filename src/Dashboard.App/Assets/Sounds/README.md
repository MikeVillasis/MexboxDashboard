# UI sound cues

These 44.1 kHz 16-bit stereo `.wav` files are synthesised from scratch by `tools/generate_sounds.py`
(sine partials, filtered noise, envelopes), so they are original and free of third-party rights.
They are copied next to the exe on build and preloaded at startup; any missing file is skipped.

Regenerate (deterministic) or tweak them with:

    python tools/generate_sounds.py

| File                 | Played when                              |
|----------------------|------------------------------------------|
| `blade_swoosh.wav`   | sliding between blades                   |
| `channel_change.wav` | launching a game                         |
| `navigate.wav`       | moving through a list (keys, pad, hover) |
| `select.wav`         | pressing A / Enter                       |
| `back.wav`           | pressing B / Esc                         |

To use your own sounds instead, replace the files (keep the names).
