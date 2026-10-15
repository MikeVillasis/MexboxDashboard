"""
Synthesises the dashboard's UI sound cues into src/Dashboard.App/Assets/Sounds.

Every sound is generated from scratch (sine partials, filtered noise, envelopes), so the output is original and free
of third-party rights. Standard library only; deterministic (fixed noise seed), so re-running gives identical files.

    python tools/generate_sounds.py
"""
import math
import os
import random
import struct
import wave

RATE = 44100
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "Dashboard.App", "Assets", "Sounds")


def silence(seconds):
    return [0.0] * int(RATE * seconds)


def mix_into(buffer, signal, start_s=0.0, gain=1.0):
    start = int(start_s * RATE)
    needed = start + len(signal)
    if needed > len(buffer):
        buffer.extend([0.0] * (needed - len(buffer)))
    for i, v in enumerate(signal):
        buffer[start + i] += v * gain
    return buffer


def bell(freq, seconds, decay, partials=((1.0, 1.0), (2.76, 0.28), (5.40, 0.08)), attack=0.003):
    """Glassy struck tone: a few inharmonic partials, each decaying faster the higher it is."""
    n = int(RATE * seconds)
    out = []
    for i in range(n):
        t = i / RATE
        env = min(1.0, t / attack) * math.exp(-t / decay)
        v = 0.0
        for ratio, amp in partials:
            v += amp * math.exp(-t * ratio * 0.6 / decay) * math.sin(2 * math.pi * freq * ratio * t)
        out.append(v * env)
    return out


class Bandpass:
    """RBJ biquad band-pass (constant 0 dB peak gain); coefficients can change per sample for sweeps."""

    def __init__(self):
        self.x1 = self.x2 = self.y1 = self.y2 = 0.0

    def process(self, x, freq, q):
        w0 = 2 * math.pi * freq / RATE
        alpha = math.sin(w0) / (2 * q)
        b0, b1, b2 = alpha, 0.0, -alpha
        a0, a1, a2 = 1 + alpha, -2 * math.cos(w0), 1 - alpha
        y = (b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2) / a0
        self.x2, self.x1 = self.x1, x
        self.y2, self.y1 = self.y1, y
        return y


def whoosh(seconds, f_start, f_peak, f_end, peak_at, q=1.6, seed=7):
    """Filtered-noise swoosh whose band centre glides start → peak → end on an exponential curve."""
    rng = random.Random(seed)
    bp = Bandpass()
    n = int(RATE * seconds)
    out = []
    for i in range(n):
        p = i / n
        if p < peak_at:
            k = p / peak_at
            freq = f_start * (f_peak / f_start) ** k
            env = math.sin(k * math.pi / 2) ** 2
        else:
            k = (p - peak_at) / (1 - peak_at)
            freq = f_peak * (f_end / f_peak) ** k
            env = (1 - k) ** 2.2
        out.append(bp.process(rng.uniform(-1, 1), freq, q) * env)
    return out


def tone(freq, seconds, decay):
    n = int(RATE * seconds)
    return [math.exp(-(i / RATE) / decay) * math.sin(2 * math.pi * freq * i / RATE) for i in range(n)]


def normalize(signal, peak_db):
    peak = max(abs(v) for v in signal) or 1.0
    target = 10 ** (peak_db / 20)
    return [v * target / peak for v in signal]


def fade_tail(signal, seconds=0.01):
    n = min(len(signal), int(RATE * seconds))
    for i in range(n):
        signal[-1 - i] *= i / n
    return signal


def stereo_pan(signal, pan_from, pan_to):
    """Equal-power pan sweep; pan -1 = left, +1 = right."""
    frames = []
    n = len(signal)
    for i, v in enumerate(signal):
        pan = pan_from + (pan_to - pan_from) * i / max(1, n - 1)
        angle = (pan + 1) * math.pi / 4
        frames.append((v * math.cos(angle), v * math.sin(angle)))
    return frames


def write(name, signal, pan=None):
    signal = fade_tail(signal)
    frames = stereo_pan(signal, *pan) if pan else [(v, v) for v in signal]
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(
            struct.pack("<hh", int(max(-1, min(1, l)) * 32767), int(max(-1, min(1, r)) * 32767)) for l, r in frames))
    print(f"{name}: {len(signal) / RATE * 1000:.0f} ms")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # Blade slide: airy left-to-right swoosh with a soft low thump as the blade lands.
    swoosh = whoosh(0.42, 350, 2600, 700, peak_at=0.35, q=1.4)
    mix_into(swoosh, tone(95, 0.18, 0.05), start_s=0.12, gain=0.35)
    write("blade_swoosh.wav", normalize(swoosh, -5), pan=(-0.6, 0.6))

    # List move: tiny glassy tick.
    tick = bell(2093, 0.07, 0.014, partials=((1.0, 1.0), (1.5, 0.25)), attack=0.001)
    write("navigate.wav", normalize(tick, -12))

    # Accept: rising two-note chime (C6 → G6).
    select = silence(0.32)
    mix_into(select, bell(1046.5, 0.26, 0.09), 0.0)
    mix_into(select, bell(1568.0, 0.26, 0.10), 0.06)
    write("select.wav", normalize(select, -7))

    # Back: falling, softer two-note chime (G6 → C6).
    back = silence(0.30)
    mix_into(back, bell(1568.0, 0.24, 0.08), 0.0, gain=0.8)
    mix_into(back, bell(1046.5, 0.24, 0.09), 0.055)
    write("back.wav", normalize(back, -9))

    # Game launch: rising C-major arpeggio over a swelling swoosh, ending in a shimmer.
    launch = silence(1.1)
    for i, freq in enumerate((523.25, 659.25, 783.99, 1046.5, 1318.5)):
        mix_into(launch, bell(freq, 0.6, 0.16), 0.07 * i, gain=0.55 + 0.1 * i)
    mix_into(launch, whoosh(0.8, 300, 3200, 1800, peak_at=0.6, q=1.2, seed=11), 0.0, gain=0.6)
    mix_into(launch, bell(2093.0, 0.7, 0.25, partials=((1.0, 1.0), (2.0, 0.3), (3.0, 0.1))), 0.36, gain=0.5)
    write("channel_change.wav", normalize(launch, -5), pan=(-0.25, 0.25))


if __name__ == "__main__":
    main()
