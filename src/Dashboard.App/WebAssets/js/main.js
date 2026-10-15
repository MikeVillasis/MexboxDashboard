// Phase 1: verifies both interop directions and shows C#-driven input. Replaced by the blades UI in Phase 2.
(function () {
  "use strict";

  const mark = (id, ok, text) => {
    const row = document.getElementById(id);
    row.classList.toggle("ok", ok);
    row.classList.toggle("fail", !ok);
    row.querySelector("em").textContent = text;
  };

  if (!Xbox.isHosted) {
    mark("check-host", false, "not running inside the dashboard");
    return;
  }

  // 1. JS → C# host object (async proxy) → return value.
  let hostReply = null;
  Xbox.backend.Ping("hello from js")
    .then((reply) => { hostReply = reply; mark("check-host", reply === "pong: hello from js", reply); })
    .catch((err) => mark("check-host", false, String(err)));

  // 2. JS → C# message → C# → JS message.
  const sent = performance.now();
  Xbox.on("PONG", (payload) => {
    const ok = payload && payload.echo === sent;
    const roundTripMs = Math.round((performance.now() - sent) * 10) / 10;
    mark("check-message", ok, ok ? `${roundTripMs} ms round trip` : "echo mismatch");
    // Report back so the result is visible in dashboard.log too.
    Promise.resolve().then(() => Xbox.send("PONG_ACK", { roundTripMs, hostObjectReply: hostReply }));
  });
  Xbox.send("PING", { sent });

  // 3. C# → JS pushes.
  // HOST_READY carries the current count because events sent before the page loaded are lost.
  Xbox.on("HOST_READY", (p) => { mark("check-ready", true, `v${p.version}`); mark("check-library", true, `${p.games} games`); });
  Xbox.on("LIBRARY_CHANGED", (p) => mark("check-library", true, `${p.count} games`));

  const log = document.getElementById("nav-log");
  Xbox.on("NAV", (p) => {
    if (log.firstElementChild && log.firstElementChild.classList.contains("muted")) log.innerHTML = "";
    const item = document.createElement("li");
    item.textContent = `${p.action}  (${p.source})`;
    log.prepend(item);
    while (log.children.length > 12) log.lastElementChild.remove();
  });

  // The browser has keyboard focus; forward keys so C# maps them exactly like controller input.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab" || e.key === " " || e.key === "Backspace") e.preventDefault();
    Xbox.send("KEY", { key: e.key, shift: e.shiftKey });
  });
})();
