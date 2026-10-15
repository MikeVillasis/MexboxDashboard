// Plaza AI: a small finite state machine per avatar, plus boids-style separation so nobody walks through anyone.
//
//   IDLE ──timer──▶ WANDER ──arrived──▶ IDLE
//     │               │
//     │               └─within 2 m of a free avatar──▶ SOCIALIZE (both) ──timer──▶ IDLE (+ cooldown for that pair)
//     └──random──▶ EMOTE ──gesture done──▶ IDLE
//   any ──pointer grab──▶ GRABBED ──drop──▶ IDLE, or SOCIALIZE with whoever it was dropped next to
//
// Everything here is local simulation; phase 5 only syncs movement targets/emotes between peers.
import * as THREE from "three";
import { GESTURE_SECONDS } from "./AvatarBuilder.js";

export const State = Object.freeze({ IDLE: "IDLE", WANDER: "WANDER", SOCIALIZE: "SOCIALIZE", EMOTE: "EMOTE", GRABBED: "GRABBED" });

const PLAZA_RADIUS = 8.5;
const WALK_SPEED = 0.95;          // m/s
const STRIDE = 7.5;               // walk phase radians per metre
const SOCIAL_RANGE = 2.0;         // start chatting within this distance
const CHAT_DISTANCE = 1.15;       // comfortable talking distance
const SEPARATION_RADIUS = 0.85;   // boids: personal space
const PAIR_COOLDOWN = 10;         // seconds before the same two chat again
const HOLD_HEIGHT = 0.9;          // how high a grabbed avatar hangs
const GESTURES = ["wave", "laugh", "nod"];

const rand = (a, b) => a + Math.random() * (b - a);
const pairKey = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

class Agent {
  constructor(avatar) {
    this.avatar = avatar;
    this.state = State.IDLE;
    this.timer = rand(0.5, 3);
    this.target = new THREE.Vector2();
    this.velocity = new THREE.Vector2();
    this.heading = avatar.root.rotation.y;
    this.partner = null;
    this.nextGestureAt = 0;
    this.anchored = false;        // local avatar while the customiser is open: stays home, facing the camera
    this.remote = false;          // a live friend: moves only to targets their peer sends (MOVE packets)
    this.dropTarget = null;
    this.fall = 0;                // vertical speed after a drop
  }

  get id() { return this.avatar.id; }
  get position() { return this.avatar.root.position; }
  get busy() { return this.state === State.SOCIALIZE || this.state === State.GRABBED || this.anchored || this.remote; }
}

export class PlazaAI {
  constructor() {
    this.agents = new Map();
    this.cooldowns = new Map(); // pairKey → time when allowed again
    this.time = 0;
    this.onEvent = null;  // (event, agent, other?) → used to report plaza activity
    this.onTarget = null; // (agent, x, z) → an agent started walking somewhere (the local one is broadcast to peers)
  }

  add(avatar) {
    const agent = new Agent(avatar);
    this.agents.set(avatar.id, agent);
    return agent;
  }

  get(avatar) { return this.agents.get(avatar.id); }

  /// Live friends are driven by their peer; offline (or disconnected) friends roam like any resident.
  setRemote(avatar, remote) {
    const agent = this.get(avatar);
    if (!agent) return;
    agent.remote = remote;
    this.endSocial(agent);
    agent.state = State.IDLE;
    agent.timer = remote ? Infinity : 2;
  }

  /// Walk an agent to a point: a MOVE packet for remotes, a floor click for the local avatar.
  walkTo(avatar, x, z, announce = false) {
    const agent = this.get(avatar);
    if (!agent || agent.state === State.GRABBED) return;
    this.endSocial(agent);
    agent.state = State.WANDER;
    agent.target.set(x, z);
    agent.timer = agent.remote ? Infinity : 12;
    if (announce) this.onTarget?.(agent, x, z);
  }

  /// The local avatar is pinned home while the customiser blade is open.
  setAnchored(avatar, anchored) {
    const agent = this.get(avatar);
    if (!agent) return;
    agent.anchored = anchored;
    if (anchored) this.endSocial(agent);
  }

  // ───────────── Pointer interaction ─────────────

  grab(avatar) {
    const agent = this.get(avatar);
    if (!agent) return;
    this.endSocial(agent);
    agent.state = State.GRABBED;
    agent.velocity.set(0, 0);
    agent.avatar.face.express("surprised", 99);
  }

  /// While held: follow the pointer's floor point, hanging HOLD_HEIGHT above it.
  drag(avatar, floorPoint) {
    const agent = this.get(avatar);
    if (agent?.state !== State.GRABBED) return;
    agent.dropTarget = floorPoint.clone();
  }

  /// Release: fall back to the floor; dropped next to someone → they chat immediately.
  drop(avatar) {
    const agent = this.get(avatar);
    if (agent?.state !== State.GRABBED) return;
    agent.state = State.IDLE;
    agent.timer = rand(1, 2);
    agent.fall = 0;
    agent.avatar.face.express("neutral", 0);

    let nearest = null;
    let best = SOCIAL_RANGE * 1.25;
    for (const other of this.agents.values()) {
      if (other === agent || other.state === State.GRABBED || other.anchored || other.remote) continue;
      const d = flatDistance(agent.position, other.position);
      if (d < best) { best = d; nearest = other; }
    }
    if (nearest) {
      this.endSocial(nearest);
      this.startSocial(agent, nearest, true);
    }
  }

  // ───────────── Simulation ─────────────

  update(dt) {
    this.time += dt;
    const agents = [...this.agents.values()];

    for (const agent of agents) this.think(agent, dt);
    this.tryStartConversations(agents);
    for (const agent of agents) this.move(agent, agents, dt);
  }

  think(agent, dt) {
    agent.timer -= dt;
    const avatar = agent.avatar;

    if (agent.remote) {
      // Peer-driven: arrive and wait for the next MOVE; never wander, emote or chat on our own initiative.
      if (agent.state === State.WANDER && flatDistance(agent.position, agent.target) < 0.25) { agent.state = State.IDLE; agent.timer = Infinity; }
      return;
    }

    if (agent.anchored) {
      agent.state = State.WANDER;
      agent.target.set(0, 0);
      if (flatDistance(agent.position, ORIGIN) < 0.08) { agent.state = State.IDLE; agent.desiredHeading = 0; }
      return;
    }

    switch (agent.state) {
      case State.IDLE:
        if (agent.timer > 0) return;
        if (Math.random() < 0.22) {
          agent.state = State.EMOTE;
          avatar.gesture(GESTURES[Math.floor(Math.random() * GESTURES.length)]);
          agent.timer = GESTURE_SECONDS[avatar.motion.gesture] ?? 1.5;
        } else {
          agent.state = State.WANDER;
          pickWanderTarget(agent);
          agent.timer = 12; // give up on unreachable targets
          this.onTarget?.(agent, agent.target.x, agent.target.y);
        }
        break;

      case State.WANDER:
        if (agent.timer <= 0 || flatDistance(agent.position, agent.target) < 0.25) {
          agent.state = State.IDLE;
          agent.timer = rand(1.5, 4.5);
        }
        break;

      case State.EMOTE:
        if (agent.timer <= 0) { agent.state = State.IDLE; agent.timer = rand(1, 3); }
        break;

      case State.SOCIALIZE: {
        const partner = agent.partner;
        if (!partner || partner.state !== State.SOCIALIZE || agent.timer <= 0) { this.endSocial(agent); return; }
        // Turn-taking: whoever's "turn" it is talks and occasionally gestures; the listener nods now and then.
        if (this.time > agent.nextGestureAt && !avatar.motion.gesture) {
          const speaking = Math.floor(this.time / 1.8 + (agent.id < partner.id ? 0 : 1)) % 2 === 0;
          if (speaking) {
            avatar.face.talk(1.2);
            if (Math.random() < 0.45) avatar.gesture(Math.random() < 0.5 ? "laugh" : "wave");
          } else if (Math.random() < 0.4) {
            avatar.gesture("nod");
          }
          agent.nextGestureAt = this.time + rand(1.2, 2.4);
        }
        break;
      }

      case State.GRABBED:
        break;
    }
  }

  tryStartConversations(agents) {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!isFree(a)) continue;
      for (let j = i + 1; j < agents.length; j++) {
        const b = agents[j];
        if (!isFree(b)) continue;
        if (flatDistance(a.position, b.position) > SOCIAL_RANGE) continue;
        if ((this.cooldowns.get(pairKey(a, b)) ?? 0) > this.time) continue;
        this.startSocial(a, b, false);
        break;
      }
    }
  }

  startSocial(a, b, eager) {
    const seconds = rand(4, 7);
    for (const [self, other] of [[a, b], [b, a]]) {
      self.state = State.SOCIALIZE;
      self.partner = other;
      self.timer = seconds;
      self.nextGestureAt = this.time + rand(0.1, 0.6);
    }
    // Greeting: one waves straight away (both if they were just dropped together).
    a.avatar.gesture("wave");
    if (eager) b.avatar.gesture("laugh");
    this.cooldowns.set(pairKey(a, b), this.time + seconds + PAIR_COOLDOWN);
    this.onEvent?.(eager ? "dropped-into-chat" : "socialize", a, b);
  }

  endSocial(agent) {
    const partner = agent.partner;
    agent.partner = null;
    if (agent.state === State.SOCIALIZE) { agent.state = State.IDLE; agent.timer = rand(1, 3); }
    if (partner && partner.partner === agent) {
      partner.partner = null;
      if (partner.state === State.SOCIALIZE) { partner.state = State.IDLE; partner.timer = rand(1, 3); }
    }
  }

  move(agent, agents, dt) {
    const pos = agent.position;
    const motion = agent.avatar.motion;

    if (agent.state === State.GRABBED) {
      if (agent.dropTarget) {
        pos.x += (agent.dropTarget.x - pos.x) * Math.min(1, dt * 12);
        pos.z += (agent.dropTarget.z - pos.z) * Math.min(1, dt * 12);
      }
      pos.y += (HOLD_HEIGHT - pos.y) * Math.min(1, dt * 10);
      motion.dangle = Math.min(1, motion.dangle + dt * 4);
      motion.walk = Math.max(0, motion.walk - dt * 6);
      return;
    }

    // Falling back after a drop.
    motion.dangle = Math.max(0, motion.dangle - dt * 3);
    if (pos.y > 0) {
      agent.fall += 9.8 * dt;
      pos.y = Math.max(0, pos.y - agent.fall * dt);
      if (pos.y === 0) agent.fall = 0;
      return;
    }

    // Steering: seek the target (wander) or a chatting distance from the partner, plus separation.
    const desired = new THREE.Vector2();
    if (agent.state === State.WANDER) {
      desired.set(agent.target.x - pos.x, agent.target.y - pos.z);
      const d = desired.length();
      if (d > 0.001) desired.multiplyScalar(Math.min(1, d / 0.6) * WALK_SPEED / d);
    } else if (agent.state === State.SOCIALIZE && agent.partner) {
      const p = agent.partner.position;
      const toPartner = new THREE.Vector2(p.x - pos.x, p.z - pos.z);
      const d = toPartner.length();
      if (Math.abs(d - CHAT_DISTANCE) > 0.12 && d > 0.001) desired.copy(toPartner).multiplyScalar(((d - CHAT_DISTANCE) / d) * 1.4);
      agent.desiredHeading = Math.atan2(toPartner.x, toPartner.y); // face each other (lookAt on the floor plane)
    }

    for (const other of agents) {
      if (other === agent || other.state === State.GRABBED) continue;
      const dx = pos.x - other.position.x;
      const dz = pos.z - other.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.0001 && d < SEPARATION_RADIUS) desired.add(new THREE.Vector2(dx / d, dz / d).multiplyScalar((SEPARATION_RADIUS - d) * 3));
    }
    if (desired.length() > WALK_SPEED * 1.3) desired.setLength(WALK_SPEED * 1.3);

    agent.velocity.lerp(desired, Math.min(1, dt * 5));
    pos.x += agent.velocity.x * dt;
    pos.z += agent.velocity.y * dt;

    // Keep everyone on the plaza.
    const r = Math.hypot(pos.x, pos.z);
    if (r > PLAZA_RADIUS) { pos.x *= PLAZA_RADIUS / r; pos.z *= PLAZA_RADIUS / r; }

    const speed = agent.velocity.length();
    motion.walk = Math.min(1, speed / WALK_SPEED);
    motion.walkPhase += speed * STRIDE * dt;

    // Face the direction of travel, or the partner/camera when standing.
    const heading = speed > 0.2 ? Math.atan2(agent.velocity.x, agent.velocity.y) : agent.desiredHeading;
    if (heading !== undefined) agent.heading = turnTowards(agent.heading, heading, dt * 6);
    agent.avatar.root.rotation.y = agent.heading;
  }
}

const ORIGIN = new THREE.Vector3();

function isFree(agent) {
  return (agent.state === State.IDLE || agent.state === State.WANDER) && !agent.anchored && !agent.remote && agent.position.y === 0;
}

function pickWanderTarget(agent) {
  // Mostly short strolls; occasionally cross the plaza.
  const far = Math.random() < 0.25;
  const angle = Math.random() * Math.PI * 2;
  const distance = far ? rand(3, 6) : rand(1, 2.8);
  let x = agent.position.x + Math.cos(angle) * distance;
  let z = agent.position.z + Math.sin(angle) * distance;
  const r = Math.hypot(x, z);
  if (r > PLAZA_RADIUS - 0.5) { x *= (PLAZA_RADIUS - 0.5) / r; z *= (PLAZA_RADIUS - 0.5) / r; }
  agent.target.set(x, z);
}

function flatDistance(a, b) {
  const bz = b.isVector2 ? b.y : b.z;
  return Math.hypot(a.x - b.x, a.z - bz);
}

function turnTowards(current, target, maxStep) {
  let delta = target - current;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest way round
  return current + Math.max(-maxStep, Math.min(maxStep, delta));
}
