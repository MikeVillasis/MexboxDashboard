// Zero-cost P2P transport: PeerJS's free public broker only introduces peers (signalling); avatar traffic then flows
// directly over WebRTC data channels (Google's public STUN server for NAT traversal). No game server, no storage.
//
// TRANSPORT CONTRACT (NetworkManager is the only caller; a WebSocket transport implements the same shape):
//   start(sink)            begin; report through sink.{status, open, data, close, failed, log}
//   connect(code)          ask to join a peer (P2P only; server transports may ignore it)
//   disconnect(code)
//   send(code, packet)     to one peer
//   broadcast(packet)      to every open peer
// Peers are identified by the channel they arrive on, never by ids inside packets.

const PEER_PREFIX = "xbox360dash-v1-";
const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export class PeerTransport {
  constructor(friendCode) {
    this.code = friendCode;
    this.connections = new Map(); // code → DataConnection (open only)
    this.peer = null;
    this.sink = null;
  }

  /// Registers this player on the broker under their friend code.
  start(sink) {
    this.sink = sink;
    if (typeof Peer === "undefined") { sink.status("unavailable"); return; }
    this.peer = new Peer(PEER_PREFIX + this.code, { config: ICE, debug: 0 });
    this.peer.on("open", () => { sink.status("online"); sink.log("online", this.code); });
    this.peer.on("connection", (conn) => this.attach(conn));
    this.peer.on("disconnected", () => { sink.status("reconnecting"); setTimeout(() => this.peer && !this.peer.destroyed && this.peer.reconnect(), 3000); });
    this.peer.on("error", (err) => {
      sink.log("error", err.type ?? "", String(err.message ?? err));
      if (err.type === "peer-unavailable") sink.failed(String(err.message).split(PEER_PREFIX)[1]?.slice(0, 6) ?? "");
    });
  }

  connect(code) {
    if (!this.peer || code === this.code || this.connections.has(code)) return;
    this.sink.log("connecting", code);
    this.attach(this.peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "json" }));
  }

  disconnect(code) { this.connections.get(code)?.close(); }

  send(code, packet) {
    const conn = this.connections.get(code);
    if (conn?.open) conn.send(packet);
  }

  broadcast(packet) {
    for (const conn of this.connections.values()) if (conn.open) conn.send(packet);
  }

  attach(conn) {
    const code = conn.peer.startsWith(PEER_PREFIX) ? conn.peer.slice(PEER_PREFIX.length) : null;
    if (!code) { conn.close(); return; }

    conn.on("open", () => {
      this.connections.set(code, conn);
      // The sink may refuse (bad code, plaza full); it answers by calling disconnect.
      this.sink.open(code);
    });
    conn.on("data", (data) => this.sink.data(code, data));
    conn.on("close", () => {
      if (this.connections.get(code) !== conn) return;
      this.connections.delete(code);
      this.sink.close(code);
    });
    conn.on("error", (err) => this.sink.log("connection-error", code, String(err?.message ?? err)));
  }
}
