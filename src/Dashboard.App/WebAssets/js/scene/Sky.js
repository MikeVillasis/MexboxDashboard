// Plaza skies. A preset either keeps the classic flat colour that follows the blade tints, or draws procedural
// backdrops (shaders, no textures, nothing to download) with its own fixed look for the fog, floor and lights:
//   dome   an inverted sphere that follows the camera (the far sky)
//   wall   an open cylinder standing on the floor round the plaza: what the elevated plaza camera actually sees
//   floor  an additive ring on the floor in front of the wall: the lines' glow and reflections
// Each preset picks its parts and may shrink the plaza floor (floorScale: the plaza as a rooftop).
// Plaza.setSky() switches presets; the plaza menu lists them.
import * as THREE from "three";

// "Neon trails": a light-painting look, reproduced from a long-exposure photo by Zak on Unsplash (credited in-app while
// the preset is on). Separate "curtains" of stacked wavy neon lines over near-black: cool blue on the left of the
// default view, a tall blue-violet coiled column in the middle, magenta then red-orange on the right, wrapping round.
const NEON_CURTAINS = [
  // centre (azimuth 0..1, 0.5 = the plaza's default view), half-width, top (0..0.75 of the wall), hue (0 blue → 1 red)
  [0.335, 0.045, 0.62, 0.0], [0.405, 0.03, 0.42, 0.06], [0.49, 0.035, 0.72, 0.28], [0.565, 0.035, 0.46, 0.64],
  [0.65, 0.045, 0.68, 0.96], [0.735, 0.035, 0.40, 1.0], [0.82, 0.04, 0.56, 0.76], [0.90, 0.035, 0.48, 0.50],
  [0.98, 0.04, 0.60, 0.30], [0.07, 0.035, 0.50, 0.12], [0.16, 0.04, 0.62, 0.04], [0.25, 0.035, 0.46, 0.06],
];
const NEON_STYLE = [
  // lines per wall, wave frequency, coil amount (0 = plain stacked lines), phase
  [42, 2.5, 0.0, 0.0], [46, 4.0, 0.8, 1.3], [40, 3.0, 1.0, 2.1], [44, 3.5, 0.35, 0.7],
  [40, 2.0, 0.25, 3.3], [46, 4.5, 0.0, 4.1], [42, 3.0, 0.5, 5.0], [44, 4.0, 0.7, 0.4],
  [40, 3.5, 0.9, 2.7], [42, 3.0, 0.2, 1.9], [44, 2.5, 0.0, 3.8], [46, 4.0, 0.6, 1.1],
];

const NEON_SHADER = {
  uniforms: {
    uTime: { value: 0 },
    uCurtains: { value: NEON_CURTAINS.map((c) => new THREE.Vector4(...c)) },
    uStyle: { value: NEON_STYLE.map((s) => new THREE.Vector4(...s)) },
    uDetail: { value: 1 },     // 0 on the low quality tier: no coil layer
    uMode: { value: 0 },       // 0 dome (dark studio), 1 wall (curtains), 2 floor glow
    uWallHeight: { value: 16 },
    uWallRadius: { value: 24 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    #define TAU 6.28318530718
    #define CURTAINS ${NEON_CURTAINS.length}
    uniform float uTime;
    uniform vec4 uCurtains[CURTAINS];
    uniform vec4 uStyle[CURTAINS];
    uniform float uDetail;
    uniform float uMode;
    uniform float uWallHeight;
    uniform float uWallRadius;
    varying vec3 vPos;

    // Blue → violet → magenta → red, the photo's sweep.
    vec3 neon(float t) {
      vec3 blue = vec3(0.10, 0.36, 1.0), violet = vec3(0.50, 0.24, 1.0), magenta = vec3(1.0, 0.06, 0.55), red = vec3(1.0, 0.16, 0.08);
      if (t < 0.33) return mix(blue, violet, t / 0.33);
      if (t < 0.66) return mix(violet, magenta, (t - 0.33) / 0.33);
      return mix(magenta, red, (t - 0.66) / 0.34);
    }

    // Lines at integer values of 'coord': an anti-aliased core about 'thick' wide (in line spacings), plus a glow.
    vec2 lines(float coord, float thick) {
      float d = 0.5 - abs(fract(coord) - 0.5);    // distance to the nearest line, in line spacings
      float px = max(fwidth(coord), 1e-4);
      float w = max(thick, px * 0.75);
      float core = 1.0 - smoothstep(w - px, w + px, d);
      float glow = exp(-d / (w * 3.0 + px * 2.0));
      return vec2(core, glow);
    }

    float azimuth(vec3 p) { return atan(p.x, -p.z) / TAU + 0.5; } // 0.5 straight ahead (-Z), increasing to the right

    void main() {
      float az = azimuth(vPos);

      if (uMode < 0.5) { // dome: near-black studio, a hair lighter towards the horizon
        float el = normalize(vPos).y;
        gl_FragColor = vec4(mix(vec3(0.026, 0.03, 0.07), vec3(0.006, 0.007, 0.018), smoothstep(-0.05, 0.5, el)), 1.0);
        return;
      }

      if (uMode > 1.5) { // floor glow: each curtain's colour pooled at its foot, with faint reflected streaks
        float r = length(vPos.xz);
        float near = smoothstep(uWallRadius * 0.45, uWallRadius, r);
        vec3 glow = vec3(0.0);
        for (int i = 0; i < CURTAINS; i++) {
          float dx = fract(az - uCurtains[i].x + 0.5) - 0.5;
          glow += neon(uCurtains[i].w) * smoothstep(uCurtains[i].y * 1.6, 0.0, abs(dx));
        }
        vec2 streak = lines(r * 1.6 + 0.6 * sin(az * TAU * 24.0 + r * 0.7 + uTime * 0.1), 0.05);
        gl_FragColor = vec4(glow * near * near * (0.3 + streak.x * 0.7 + streak.y * 0.12), 1.0);
        return;
      }

      // Wall: height up the wall mapped to 0..0.75, the range the curtain tops are given in.
      float el = clamp(vPos.y / uWallHeight, 0.0, 1.0) * 0.75;
      vec3 col = mix(vec3(0.03, 0.034, 0.075), vec3(0.008, 0.009, 0.022), smoothstep(0.0, 0.45, el));

      for (int i = 0; i < CURTAINS; i++) {
        vec4 c = uCurtains[i];
        vec4 s = uStyle[i];
        float dx = fract(az - c.x + 0.5) - 0.5;     // signed azimuth distance, wrapping round
        float width = c.y * (1.0 + 0.3 * sin(el * 6.0 + s.w));
        float side = smoothstep(width, width * 0.7, abs(dx));
        float top = c.z + 0.04 * sin(dx / width * 3.0 + uTime * 0.25 + s.w); // curling, uneven tops
        float mask = side * smoothstep(top, top - 0.05, el);
        if (mask < 0.002) continue;

        // Stacked lines, waving along the curtain (stronger towards its edges, like a draped ribbon) and drifting.
        float across = dx / width;                  // -1..1 across the curtain
        float wave = (0.25 + 0.35 * across * across) * sin(across * s.y * 3.0 + el * 6.0 + uTime * 0.12 + s.w);
        vec2 l = lines(el * s.x + wave, 0.045);
        // Coils: a looser family looping back and forth across the curtain, crossing the first into a net.
        if (uDetail > 0.5 && s.z > 0.0) {
          vec2 coil = lines(el * s.x * 0.5 + s.z * 0.9 * sin(across * 4.0 + uTime * 0.2 + s.w), 0.04);
          l = max(l, coil * s.z);
        }
        vec3 tint = neon(clamp(c.w + 0.1 * across, 0.0, 1.0));
        float pulse = 0.7 + 0.3 * sin(el * 8.0 + across * 3.0 + s.w);
        col += mask * pulse * (tint * (l.x * 1.5 + l.y * 0.5) + vec3(0.9, 0.92, 1.0) * l.x * 0.22); // a little white in the cores
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// "City night": an aerial blue-hour city, reproduced from a photo by MF Evelyn on Unsplash (credited in-app while the
// preset is on). The plaza becomes a rooftop high above it: below the horizon each view ray meets a ground plane far
// down, where a block grid of blue rooftops, lit windows, signs, aviation lights, parks and a winding highway with
// streams of car lights fades into haze; above it, a blue-hour gradient.
const CITY_SHADER = {
  uniforms: {
    uTime: { value: 0 },
    uDetail: { value: 1 },             // 0 on the low quality tier: no windows, signs or traffic
    uCam: { value: new THREE.Vector3() }, // the city stays put while the dome follows the camera
  },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime;
    uniform float uDetail;
    uniform vec3 uCam;
    varying vec3 vPos;

    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

    const vec3 HAZE = vec3(0.20, 0.28, 0.44);
    const float BLOCK = 24.0;   // metres per city block (including its roads)
    const float STREET = 3.2;   // road width at the block edges
    const float DEPTH = 90.0;   // the city lies this far below the rooftop

    // The highway: a gentle S-curve heading away from the default view (-Z), 11 m wide.
    float highwayX(float z) { return 26.0 * sin(z * 0.0045) + 9.0 * sin(z * 0.013 + 1.3); }

    void main() {
      vec3 d = normalize(vPos);
      if (d.y > -0.003) { // blue-hour sky over the haze line
        vec3 zenith = vec3(0.035, 0.06, 0.16);
        gl_FragColor = vec4(mix(HAZE, zenith, pow(smoothstep(-0.003, 0.55, d.y), 0.55)), 1.0);
        return;
      }
      float t = DEPTH / -d.y;                  // distance along the ray to the city
      vec2 p = uCam.xz + d.xz * t;
      float px = max(fwidth(p.x), fwidth(p.y)); // metres per pixel here: fades detail before it can shimmer
      float near = smoothstep(2.0, 0.35, px);
      float detail = near * uDetail;

      vec2 cell = floor(p / BLOCK);
      vec2 f = mod(p, BLOCK);
      float park = step(hash(cell * 3.7), 0.07);

      // Lots: each block split into 2-3 by 2-3 buildings, separated by dark alleys.
      vec2 counts = 1.0 + floor(vec2(hash(cell + 1.7), hash(cell + 9.2)) * 3.99);
      vec2 lotP = clamp((f - STREET) / (BLOCK - STREET), 0.0, 0.999) * counts;
      vec2 lot = floor(lotP);
      vec2 lf = fract(lotP);
      float id = hash(cell * 7.13 + lot * 1.31);
      float height = id * id;                   // taller buildings catch more of the sky: lighter roofs
      vec3 col = mix(vec3(0.045, 0.075, 0.17), vec3(0.25, 0.34, 0.55), height * 0.9 + 0.15 * hash(lot + cell * 2.3));
      float edge = min(min(lf.x, 1.0 - lf.x), min(lf.y, 1.0 - lf.y));
      col *= mix(0.3, 1.0, smoothstep(0.03, 0.12, edge));        // alleys and roof edges
      col = mix(col, vec3(0.05, 0.09, 0.13), park);              // parks and shrines: dark green-blue

      // Lit windows: a fine grid on each roof, a few cells lit warm or cool (more on tall buildings).
      if (detail > 0.0 && park < 0.5) {
        vec2 w = p * vec2(0.9, 0.75);
        vec2 wc = floor(w);
        float lit = step(0.94 - height * 0.08, hash(wc + cell * 13.0));
        float pane = step(0.45, fract(w.x)) * step(0.5, fract(w.y));
        vec3 glow = mix(vec3(1.0, 0.76, 0.42), vec3(0.78, 0.88, 1.0), step(0.75, hash(wc * 1.7)));
        col += glow * lit * pane * detail * 0.85 * smoothstep(0.08, 0.16, edge);
        // Rare signs and red aviation lights on the tallest towers.
        float sign = step(0.985, id) * step(0.15, lf.y) * step(lf.y, 0.45) * step(0.1, lf.x) * step(lf.x, 0.9);
        vec3 signCol = id > 0.993 ? vec3(0.25, 0.95, 0.45) : (id > 0.989 ? vec3(1.0, 0.45, 0.15) : vec3(0.95, 0.95, 1.0));
        col = mix(col, signCol, sign * detail);
        float beacon = step(0.93, height) * step(length(lf - 0.15), 0.06) * step(0.0, sin(uTime * 2.5 + id * 20.0));
        col += vec3(1.0, 0.12, 0.1) * beacon * detail * 1.5;
      }

      // Streets: dark, with a dotted line of street lights.
      float street = 1.0 - step(STREET, f.x) * step(STREET, f.y);
      vec3 streetCol = vec3(0.025, 0.035, 0.075) + vec3(1.0, 0.75, 0.4) * step(0.93, fract((f.x + f.y) * 0.3)) * 0.4 * detail;
      col = mix(col, streetCol, street * (1.0 - park));

      // The highway: purple-grey asphalt with glowing edges and streams of tail lights (red) and headlights (white).
      float hx = p.x - highwayX(p.y);
      float road = 1.0 - smoothstep(4.2, 4.2 + px * 1.5, abs(hx));
      if (road > 0.0) {
        vec3 asphalt = vec3(0.06, 0.055, 0.12);
        float rail = smoothstep(px * 1.2 + 0.18, 0.0, abs(abs(hx) - 4.2));
        asphalt += vec3(0.6, 0.5, 0.9) * rail * 0.45;
        float lane = hx < 0.0 ? 1.0 : -1.0;
        float flow = fract(p.y * 0.12 + uTime * 0.35 * lane + hash(vec2(floor(hx * 0.7), 3.0)));
        float car = step(0.7, flow) * step(0.8, abs(hx)) * step(abs(hx), 3.6) * detail;
        asphalt += car * (hx < 0.0 ? vec3(1.0, 0.3, 0.12) : vec3(1.0, 0.9, 0.75)) * 1.4;
        col = mix(col, asphalt, road);
      }

      // Haze with distance, as in the photo's horizon.
      col = mix(col, HAZE, smoothstep(250.0, 2200.0, t));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export const SKIES = {
  classic: { label: "classic", tinted: true },
  neon: {
    label: "neon trails",
    tinted: false,
    shader: NEON_SHADER,
    // Fixed look while this sky is on: fog/horizon, floor, hemisphere sky + ground light, sun.
    look: { sky: 0x05060f, floor: 0x0d0f1f, light: 0x8a90ff, ground: 0x4a1236, sun: 0xf2e6ff, sunIntensity: 1.25, hemiIntensity: 1.0 },
    credit: {
      html: 'Photo by <a href="https://unsplash.com/@zaks?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Zak</a> on ' +
        '<a href="https://unsplash.com/photos/blue-red-and-pink-abstract-artwork-7wBFsHWQDlk?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Unsplash</a>',
    },
  },
  city: {
    label: "city night",
    tinted: false,
    shader: CITY_SHADER,
    parts: ["dome"],
    floorScale: 0.5, // a 15 m rooftop: avatars stay within 8.5 m, the city shows all round it
    look: { sky: 0x2b3b5e, floor: 0x1b2438, light: 0x9db2ff, ground: 0x141a2c, sun: 0xc4d2ff, sunIntensity: 1.0, hemiIntensity: 1.15 },
    credit: {
      html: 'Photo by <a href="https://unsplash.com/@liaoweimeifang?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">MF Evelyn</a> on ' +
        '<a href="https://unsplash.com/photos/aerial-photo-of-city-QifOXDApdsw?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText">Unsplash</a>',
    },
  },
};
export const DEFAULT_SKY = "classic";

const WALL_RADIUS = 24;  // inside the 30 m floor disc, well beyond where avatars wander (8.5 m)
const WALL_HEIGHT = 16;

/// The backdrop meshes for the current preset (none for classic): dome round the camera, wall and floor glow round
/// the plaza.
export class SkyDome {
  constructor(scene) {
    this.scene = scene;
    this.meshes = [];
    this.dome = null;
    this.name = DEFAULT_SKY;
  }

  set(name) {
    const preset = SKIES[name] ?? SKIES[DEFAULT_SKY];
    this.name = SKIES[name] ? name : DEFAULT_SKY;
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshes = [];
    this.dome = null;
    if (!preset.shader) return preset;

    const material = (mode, extra = {}) => {
      const m = new THREE.ShaderMaterial({
        ...preset.shader,
        uniforms: THREE.UniformsUtils.clone(preset.shader.uniforms),
        side: THREE.BackSide,
        depthWrite: false,
        toneMapped: false,
        ...extra,
      });
      if (m.uniforms.uMode) m.uniforms.uMode.value = mode;
      if (m.uniforms.uWallHeight) m.uniforms.uWallHeight.value = WALL_HEIGHT;
      if (m.uniforms.uWallRadius) m.uniforms.uWallRadius.value = WALL_RADIUS;
      return m;
    };
    const parts = preset.parts ?? ["dome", "wall", "floor"];
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(80, 32, 16), material(0));
    this.dome.renderOrder = -2;
    this.dome.frustumCulled = false;
    this.meshes = [this.dome];

    if (parts.includes("wall")) {
      const wallGeometry = new THREE.CylinderGeometry(WALL_RADIUS, WALL_RADIUS, WALL_HEIGHT, 96, 1, true);
      wallGeometry.translate(0, WALL_HEIGHT / 2, 0); // stands on the floor; local y = height up the wall
      this.meshes.push(new THREE.Mesh(wallGeometry, material(1, { depthWrite: true }))); // hides the floor beyond it
    }
    if (parts.includes("floor")) {
      const floorGeometry = new THREE.RingGeometry(WALL_RADIUS * 0.4, WALL_RADIUS, 96, 4).rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(floorGeometry, material(2, { side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending }));
      floor.position.y = 0.01;
      floor.renderOrder = 1;
      this.meshes.push(floor);
    }
    this.scene.add(...this.meshes);
    return preset;
  }

  setDetail(high) {
    for (const mesh of this.meshes) mesh.material.uniforms.uDetail.value = high ? 1 : 0;
  }

  update(time, camera) {
    if (!this.dome) return;
    this.dome.position.copy(camera.position); // infinitely far: it never gets closer as the camera moves
    for (const mesh of this.meshes) {
      mesh.material.uniforms.uTime.value = time;
      mesh.material.uniforms.uCam?.value.copy(camera.position);
    }
  }
}
