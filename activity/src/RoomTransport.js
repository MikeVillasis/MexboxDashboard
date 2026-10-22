// Server-relayed transport for the Discord Activity: one WebSocket to the Worker's PlazaRoom (server/src/room.ts),
// implementing the same contract as js/net/PeerTransport.js so NetworkManager and main.js stay unchanged.
//
// The room is authoritative: it tells us who is present (WELCOME/JOIN/LEAVE) and relays MOVE/EMOTE/DNA from each
// seat. Here those become the transport sink calls NetworkManager expects (open/data/close with P2P packet shapes).

const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];
// Close codes from the room that mean "don't retry": bad auth, replaced by another window, room full, protocol error.
const FINAL = { 4001: "sign-in rejected", 4002: "opened in another window", 4003: "this plaza is full", 4004: "connection error" };

export class RoomTransport {
  /** getDna: current recipe, sent with AUTH (also on reconnect). onStatus(code, status|null): thought bubbles. */
  constructor({ url, token, getDna, onStatus = () => {} }) {
    this.url = url;
    this.token = token;
    this.getDna = getDna;
    this.onStatus = onStatus;
    this.peers = new Set();
    this.position = { x: 0, z: 0 };
    this.attempt = 0;
    this.ws = null;
    this.sink = null;
  }

  start(sink) {
    this.sink = sink;
    this.open();
  }

  open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "AUTH", token: this.token, dna: this.getDna(), ...this.position }));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this.receive(message);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.dropPeers();
      const final = FINAL[event.code];
      if (final) {
        this.sink.log("room-closed", "", final);
        this.sink.status("offline");
        return;
      }
      const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
      this.sink.status("reconnecting");
      setTimeout(() => this.open(), delay);
    });
  }

  receive(m) {
    switch (m.type) {
      case "WELCOME":
        this.attempt = 0;
        this.sink.status("online");
        this.sink.log("online", m.you);
        for (const peer of m.peers ?? []) this.join(peer);
        for (const [code, status] of Object.entries(m.statuses ?? {})) this.onStatus(code, status);
        break;
      case "JOIN": this.join(m); break;
      case "MOVE": this.sink.data(m.code, { type: "MOVE", x: m.x, z: m.z }); break;
      case "EMOTE": this.sink.data(m.code, { type: "EMOTE", emote: m.emote }); break;
      case "DNA": this.sink.data(m.code, { type: "DNA_UPDATE", dna: m.dna }); break;
      case "LEAVE":
        if (this.peers.delete(m.code)) this.sink.close(m.code);
        break;
      case "STATUS": if (typeof m.code === "string") this.onStatus(m.code, m.status ?? null); break;
      case "ERROR": this.sink.log("room-error", "", String(m.error)); break;
    }
  }

  join({ code, dna, x, z }) {
    if (typeof code !== "string") return;
    if (!this.peers.has(code)) {
      this.peers.add(code);
      this.sink.open(code);
    }
    this.sink.data(code, { type: "JOIN_SYNC", dna, x, z });
  }

  dropPeers() {
    for (const code of this.peers) this.sink.close(code);
    this.peers.clear();
  }

  // Everyone in the instance is already in the room: there is nobody to dial or hang up on.
  connect() {}
  disconnect() {}
  // The room relays our state to newcomers itself (WELCOME/JOIN), so per-peer sends aren't needed.
  send() {}

  broadcast(packet) {
    let out = null;
    if (packet.type === "MOVE") { this.position = { x: packet.x, z: packet.z }; out = { type: "MOVE", x: packet.x, z: packet.z }; }
    else if (packet.type === "EMOTE") out = { type: "EMOTE", emote: packet.emote };
    else if (packet.type === "DNA_UPDATE") out = { type: "DNA", dna: packet.dna };
    if (out && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(out));
  }
}
