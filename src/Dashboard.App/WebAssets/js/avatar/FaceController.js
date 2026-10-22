// 2D UV-atlas faces: eyes and mouth are textures on thin shells over the head, animated purely by shifting
// texture.offset across a 4x4 atlas. No extra geometry, no morph targets.
//
//   rows    = style  (DNA eyeUV / mouthUV picks the row)
//   columns = frame  (eyes: open, half, closed, happy · mouth: neutral, smile, open "a", round "o")
import * as THREE from "three";

export const STYLES = 4;
const FRAMES = 4;
const CELL = 128;

export const EYE_STYLE_NAMES = ["classic", "bright", "calm", "lashes"];
export const MOUTH_STYLE_NAMES = ["simple", "full", "wide", "small"];

const EYE = { open: 0, half: 1, closed: 2, happy: 3 };
const MOUTH = { neutral: 0, smile: 1, open: 2, round: 3 };

let atlases = null;

/// One shared canvas per atlas; every avatar gets its own Texture (own offset) over the same image.
function getAtlases() {
  if (!atlases) atlases = { eyes: drawEyes(), mouth: drawMouth() };
  return atlases;
}

export function createFaceTextures() {
  const { eyes, mouth } = getAtlases();
  return { eyes: makeTexture(eyes), mouth: makeTexture(mouth) };
}

function makeTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(1 / FRAMES, 1 / STYLES);
  texture.anisotropy = 4;
  return texture;
}

export class FaceController {
  constructor(textures, eyeStyle, mouthStyle) {
    this.textures = textures;
    this.eyeStyle = eyeStyle;
    this.mouthStyle = mouthStyle;
    this.mood = "neutral";          // neutral | happy | surprised
    this.sleeping = false;          // eyes shut until woken (napping away members)
    this.moodUntil = 0;
    this.blinkAt = 1 + Math.random() * 3;
    this.blinkUntil = 0;
    this.talkUntil = 0;
    this.nextMouthFlip = 0;
    this.talkFrame = MOUTH.open;
    this.time = 0;
    this.apply(EYE.open, MOUTH.neutral);
  }

  setStyles(eyeStyle, mouthStyle) {
    this.eyeStyle = clampStyle(eyeStyle);
    this.mouthStyle = clampStyle(mouthStyle);
  }

  /// Short-lived expression, e.g. reacting to an outfit change or an emote.
  express(mood, seconds = 1.5) {
    this.mood = mood;
    this.moodUntil = this.time + seconds;
  }

  talk(seconds = 1.5) { this.talkUntil = this.time + seconds; }

  update(dt) {
    this.time += dt;
    const t = this.time;
    if (this.mood !== "neutral" && t > this.moodUntil) this.mood = "neutral";

    if (this.sleeping) { this.apply(EYE.closed, MOUTH.neutral); return; }

    // Blink: closed for ~120 ms, half-lids on either side, every 2–6 s.
    if (t > this.blinkAt) { this.blinkUntil = t + 0.16; this.blinkAt = t + 2 + Math.random() * 4; }
    const blinkLeft = this.blinkUntil - t;
    let eyes = this.mood === "happy" ? EYE.happy : EYE.open;
    if (blinkLeft > 0) eyes = blinkLeft > 0.12 || blinkLeft < 0.04 ? EYE.half : EYE.closed;

    let mouth = this.mood === "happy" ? MOUTH.smile : this.mood === "surprised" ? MOUTH.round : MOUTH.neutral;
    if (t < this.talkUntil) {
      if (t > this.nextMouthFlip) {
        this.talkFrame = [MOUTH.open, MOUTH.round, MOUTH.neutral, MOUTH.open][Math.floor(Math.random() * 4)];
        this.nextMouthFlip = t + 0.08 + Math.random() * 0.07;
      }
      mouth = this.talkFrame;
    }
    this.apply(eyes, mouth);
  }

  apply(eyeFrame, mouthFrame) {
    setCell(this.textures.eyes, eyeFrame, this.eyeStyle);
    setCell(this.textures.mouth, mouthFrame, this.mouthStyle);
  }
}

function setCell(texture, column, row) {
  // Canvas row 0 is the top of the image, texture v = 1 is the top.
  texture.offset.set(column / FRAMES, 1 - (row + 1) / STYLES);
}

function clampStyle(value) { return Math.max(0, Math.min(STYLES - 1, value | 0)); }

// ───────────── Atlas drawing (procedural, so no image assets are needed) ─────────────

function atlasCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = CELL * FRAMES;
  return canvas;
}

function drawEyes() {
  const canvas = atlasCanvas();
  const g = canvas.getContext("2d");
  g.lineCap = "round";
  for (let style = 0; style < STYLES; style++) {
    for (let frame = 0; frame < FRAMES; frame++) {
      g.save();
      g.translate(frame * CELL, style * CELL);
      for (const side of [-1, 1]) drawEye(g, CELL / 2 + side * 30, CELL / 2, style, frame, side);
      g.restore();
    }
  }
  return canvas;
}

function drawEye(g, x, y, style, frame, side) {
  const rx = [11, 14, 12, 12][style];
  const ry = [14, 17, 9, 14][style];
  g.strokeStyle = "#1b1b1b";
  g.lineWidth = 4;

  if (frame === 2) { // closed
    g.beginPath(); g.arc(x, y - 2, rx, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    return;
  }
  if (frame === 3) { // happy ^
    g.beginPath(); g.arc(x, y + 6, rx, 1.15 * Math.PI, 1.85 * Math.PI); g.stroke();
    return;
  }

  const lid = frame === 1 ? 0.55 : 0; // half-closed: clip the top of the eye
  g.save();
  g.beginPath(); g.rect(x - rx - 4, y - ry + ry * 2 * lid, rx * 2 + 8, ry * 2 + 8); g.clip();
  g.fillStyle = "#fff";
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = ["#3a2a1a", "#2a5ad8", "#3d6b35", "#5a3a20"][style];
  g.beginPath(); g.ellipse(x, y + 2, rx * 0.62, ry * 0.68, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#111";
  g.beginPath(); g.ellipse(x, y + 2, rx * 0.34, ry * 0.38, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#fff";
  g.beginPath(); g.arc(x - rx * 0.25, y - ry * 0.2, style === 1 ? 4 : 2.5, 0, Math.PI * 2); g.fill();
  g.restore();

  if (lid) { g.beginPath(); g.moveTo(x - rx, y - ry + ry * 2 * lid); g.lineTo(x + rx, y - ry + ry * 2 * lid); g.stroke(); }
  if (style === 3) { // lashes
    for (let i = 0; i < 3; i++) {
      const a = Math.PI * (1.15 + i * 0.12) + (side > 0 ? 0.1 : -0.1);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * rx, y + Math.sin(a) * ry);
      g.lineTo(x + Math.cos(a) * (rx + 7), y + Math.sin(a) * (ry + 7));
      g.stroke();
    }
  }
}

function drawMouth() {
  const canvas = atlasCanvas();
  const g = canvas.getContext("2d");
  g.lineCap = "round";
  g.lineJoin = "round";
  for (let style = 0; style < STYLES; style++) {
    for (let frame = 0; frame < FRAMES; frame++) {
      g.save();
      g.translate(frame * CELL + CELL / 2, style * CELL + CELL / 2);
      drawMouthCell(g, style, frame);
      g.restore();
    }
  }
  return canvas;
}

function drawMouthCell(g, style, frame) {
  const w = [18, 20, 28, 12][style];
  const lip = style === 1 ? "#b8505a" : "#5a2a22";
  g.strokeStyle = lip;
  g.lineWidth = style === 1 ? 6 : 4;

  switch (frame) {
    case 0: // neutral
      g.beginPath(); g.moveTo(-w, 0); g.quadraticCurveTo(0, 3, w, 0); g.stroke();
      break;
    case 1: // smile
      g.beginPath(); g.moveTo(-w, -4); g.quadraticCurveTo(0, 14, w, -4); g.stroke();
      break;
    case 2: // open "a" (talking, laughing)
      g.fillStyle = "#3a1010";
      g.beginPath(); g.moveTo(-w, -4); g.quadraticCurveTo(0, 26, w, -4); g.quadraticCurveTo(0, 2, -w, -4); g.fill(); g.stroke();
      g.fillStyle = "#e06070";
      g.beginPath(); g.ellipse(0, 9, w * 0.45, 4, 0, 0, Math.PI * 2); g.fill();
      break;
    case 3: // round "o"
      g.fillStyle = "#3a1010";
      g.beginPath(); g.ellipse(0, 4, w * 0.45, 9, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      break;
  }
}
