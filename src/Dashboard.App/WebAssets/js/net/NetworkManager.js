// Zero-cost P2P: PeerJS's free public broker only introduces peers (signalling); avatar traffic then flows directly
// over WebRTC data channels (Google's public STUN server for NAT traversal). No game server, no storage service.
//
// Event-driven, low bandwidth: packets are sent only when something changes, never per-frame transforms.
//   JOIN_SYNC   { type, dna, x, z }   on connect: who I am and where I stand
//   MOVE        { type, x, z }        my avatar started walking to (x, z); peers walk their copy there locally
//   EMOTE       { type, emote }       wave | laugh | nod
//   DNA_UPDATE  { type, dna }         I changed my look
//
// Peers are identified by the connection they arrive on (their friend code), never by ids inside packets, so one
// peer cannot speak for another. Every packet is size/shape checked and rate limited before it reaches the plaza;
// recipes are additionally validated by C# (RememberFriend) before they are rendered or cached.

const PEER_PREFIX = "xbox360dash-v1-";
const MAX_PACKET_BYTES = 2048;
const MAX_PACKETS_PER_SECOND = 20;
const PLAZA_LIMIT = 9;
const EMOTES = new Set(["wave", "laugh", "nod"]);
const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export class NetworkManager extends EventTarget {
  constructor(friendCode, log) {
    super();
    this.code = friendCode;
    this.log = log;                 // (event, peer, detail) → C# dashboard.log
    this.connections = new Map();   // code → DataConnection
    this.rates = new Map();         // code → { windowStart, count }
    this.peer = null;
    this.status = "offline";
  }

  /// Registers this player on the broker under their friend code.
  start() {
    if (typeof Peer === "undefined") { this.setStatus("unavailable"); return; }
    this.peer = new Peer(PEER_PREFIX + this.code, { config: ICE, debug: 0 });
    this.peer.on("open", () => { this.setStatus("online"); this.log("online", this.code); });
    this.peer.on("connection", (conn) => this.attach(conn));
    this.peer.on("disconnected", () => { this.setStatus("reconnecting"); setTimeout(() => this.peer && !this.peer.destroyed && this.peer.reconnect(), 3000); });
    this.peer.on("error", (err) => {
      this.log("error", err.type ?? "", String(err.message ?? err));
      if (err.type === "peer-unavailable") this.dispatch("connectfailed", { code: String(err.message).split(PEER_PREFIX)[1]?.slice(0, 6) ?? "" });
    });
  }

  connect(code) {
    code = String(code).toUpperCase();
    if (!this.peer || code === this.code || this.connections.has(code)) return;
    this.log("connecting", code);
    this.attach(this.peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "json" }));
  }

  disconnect(code) { this.connections.get(code)?.close(); }

  /// Sends to every connected friend.
  broadcast(packet) {
    for (const conn of this.connections.values()) if (conn.open) conn.send(packet);
  }

  attach(conn) {
    const code = conn.peer.startsWith(PEER_PREFIX) ? conn.peer.slice(PEER_PREFIX.length) : null;
    if (!code || !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) { conn.close(); return; }

    conn.on("open", () => {
      if (this.connections.size >= PLAZA_LIMIT) { conn.close(); return; }
      this.connections.set(code, conn);
      this.log("connected", code);
      this.dispatch("peeropen", { code, conn });
    });
    conn.on("data", (data) => this.receive(code, data));
    conn.on("close", () => {
      if (this.connections.get(code) !== conn) return;
      this.connections.delete(code);
      this.log("disconnected", code);
      this.dispatch("peerleave", { code });
    });
    conn.on("error", (err) => this.log("connection-error", code, String(err?.message ?? err)));
  }

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
