// Plaza networking, independent of how packets travel (see PeerTransport.js for the transport contract).
//
// Event-driven, low bandwidth: packets are sent only when something changes, never per-frame transforms.
//   JOIN_SYNC   { type, dna, x, z }   on connect: who I am and where I stand
//   MOVE        { type, x, z }        my avatar started walking to (x, z); peers walk their copy there locally
//   EMOTE       { type, emote }       wave | laugh | nod
//   DNA_UPDATE  { type, dna }         I changed my look
//
// Peers are identified by the channel they arrive on (their friend code), never by ids inside packets, so one
// peer cannot speak for another. Every packet is size/shape checked and rate limited before it reaches the plaza;
// recipes are additionally validated by the host (RememberFriend) before they are rendered or cached.

import { PeerTransport } from "./PeerTransport.js";

const MAX_PACKET_BYTES = 2048;
const MAX_PACKETS_PER_SECOND = 20;
const PLAZA_LIMIT = 9;
const EMOTES = new Set(["wave", "laugh", "nod"]);
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;

export class NetworkManager extends EventTarget {
  constructor(friendCode, log, transport = new PeerTransport(friendCode)) {
    super();
    this.code = friendCode;
    this.log = log;                 // (event, peer, detail) → host log
    this.transport = transport;
    this.peers = new Set();         // codes with an open channel
    this.rates = new Map();         // code → { windowStart, count }
    this.status = "offline";
  }

  start() {
    this.transport.start({
      status: (status) => this.setStatus(status),
      log: this.log,
      failed: (code) => this.dispatch("connectfailed", { code }),
      open: (code) => {
        if (!CODE.test(code) || this.peers.size >= PLAZA_LIMIT) { this.transport.disconnect(code); return; }
        this.peers.add(code);
        this.log("connected", code);
        this.dispatch("peeropen", { code });
      },
      data: (code, data) => { if (this.peers.has(code)) this.receive(code, data); },
      close: (code) => {
        if (!this.peers.delete(code)) return;
        this.log("disconnected", code);
        this.dispatch("peerleave", { code });
      },
    });
  }

  connect(code) {
    code = String(code).toUpperCase();
    if (code !== this.code && !this.peers.has(code)) this.transport.connect(code);
  }

  disconnect(code) { this.transport.disconnect(code); }

  send(code, packet) { this.transport.send(code, packet); }

  /// Sends to every connected friend.
  broadcast(packet) { this.transport.broadcast(packet); }

  receive(code, data) {
    if (!this.allow(code)) return;
    let size;
    try { size = JSON.stringify(data).length; } catch { return; }
    if (size > MAX_PACKET_BYTES || typeof data !== "object" || data === null) return;

    switch (data.type) {
      case "JOIN_SYNC":
        if (typeof data.dna === "object") this.dispatch("join", { code, dna: data.dna, x: num(data.x), z: num(data.z) });
        break;
      case "MOVE":
        if (Number.isFinite(data.x) && Number.isFinite(data.z)) this.dispatch("move", { code, x: num(data.x), z: num(data.z) });
        break;
      case "EMOTE":
        if (EMOTES.has(data.emote)) this.dispatch("emote", { code, emote: data.emote });
        break;
      case "DNA_UPDATE":
        if (typeof data.dna === "object") this.dispatch("dna", { code, dna: data.dna });
        break;
    }
  }

  /// Per-peer token bucket: a misbehaving peer is muted, not allowed to flood the plaza.
  allow(code) {
    const now = performance.now();
    const rate = this.rates.get(code) ?? { windowStart: now, count: 0 };
    if (now - rate.windowStart > 1000) { rate.windowStart = now; rate.count = 0; }
    rate.count++;
    this.rates.set(code, rate);
    return rate.count <= MAX_PACKETS_PER_SECOND;
  }

  setStatus(status) { this.status = status; this.dispatch("status", { status }); }

  dispatch(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

/// Plaza coordinates only: clamp so a peer can't park its avatar at infinity.
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-9, Math.min(9, n)) : 0;
}
