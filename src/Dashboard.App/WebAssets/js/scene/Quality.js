// Render quality tiers for the plaza. Hosts pick the starting tier (Xbox.quality): the Windows app stays on "high";
// the Discord Activity starts phones on "low" and desktops on "auto" (high, stepping down while frames are slow).
//
//   pixelRatio  cap on devicePixelRatio for the canvas backing store
//   shadows     sun shadow map on/off, its size, and soft (PCFSoft) vs plain PCF filtering
//   avatarCap   most avatars drawn at once (nearest-to-you first; see Plaza.refreshVisibility)
export const TIERS = {
  high: { pixelRatio: 1.25, shadows: true, shadowSize: 2048, softShadows: true, avatarCap: 48 },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 1024, softShadows: false, avatarCap: 24 },
  low: { pixelRatio: 1, shadows: false, shadowSize: 512, softShadows: false, avatarCap: 12 },
};
export const TIER_ORDER = ["high", "medium", "low"];

const WARMUP_S = 4;      // ignore loading hitches right after start or a tier change
const WINDOW_S = 3;      // judge the frame rate over this long
const SLOW_FPS = 40;     // below this on average, step down a tier

/// Watches real frame times and asks for a lower tier when the plaza can't keep up. Only ever steps down, so it never
/// oscillates between tiers.
export class FrameMonitor {
  constructor(onSlow) {
    this.onSlow = onSlow;
    this.reset();
  }

  reset() {
    this.skip = WARMUP_S;
    this.elapsed = 0;
    this.frames = 0;
  }

  /// rawDt: the unclamped seconds since the previous frame.
  sample(rawDt) {
    if (this.skip > 0) { this.skip -= rawDt; return; }
    this.elapsed += rawDt;
    this.frames++;
    if (this.elapsed < WINDOW_S) return;
    const fps = this.frames / this.elapsed;
    this.elapsed = 0;
    this.frames = 0;
    if (fps < SLOW_FPS) this.onSlow(fps);
  }
}
