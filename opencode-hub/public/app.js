const $ = (id) => document.getElementById(id);

function setBadge(el, state, text) {
  el.className = `badge ${state}`;
  el.textContent = text;
}

function fmtUptime(seconds) {
  if (seconds == null) return "—";
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`;
}

async function loadState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const s = await res.json();

    const oc = s.opencode;
    setBadge($("oc-badge"), oc.reachable ? "ok" : "bad", oc.reachable ? "online" : "offline");
    $("oc-url").textContent = oc.url;
    $("oc-version").textContent = oc.version ?? "—";
    $("oc-sessions").textContent = oc.reachable ? String(oc.sessionCount) : "—";
    $("oc-latency").textContent = `${oc.latencyMs} ms`;
    $("oc-auth").textContent = oc.passwordProtected ? "aktif" : "tidak diset";

    const d = s.data;
    setBadge($("data-badge"), d.reachable ? "ok" : "bad", d.reachable ? "online" : "offline");
    $("data-url").textContent = d.url;
    $("data-uptime").textContent = fmtUptime(d.uptimeSeconds);
    $("data-groups").textContent = d.groups ?? "—";
    $("data-items").textContent = d.resources ?? "—";
    $("data-latency").textContent = `${d.latencyMs} ms`;

    $("hub-port").textContent = String(s.hub.port);
    $("hub-uptime").textContent = fmtUptime(s.hub.uptimeSeconds);
    $("hub-node").textContent = s.hub.node;
    $("hub-checked").textContent = new Date(s.checkedAt).toLocaleTimeString("id-ID");

    const both = oc.reachable && d.reachable;
    const any = oc.reachable || d.reachable;
    const pill = $("overall");
    pill.className = `pill ${both ? "ok" : any ? "warn" : "bad"}`;
    $("overall-text").textContent = both
      ? "semua server online"
      : any
        ? "sebagian server offline"
        : "semua server offline";
  } catch {
    const pill = $("overall");
    pill.className = "pill bad";
    $("overall-text").textContent = "hub tidak merespons";
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function loadResources() {
  const box = $("resources");
  try {
    const res = await fetch("/api/resources", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    box.innerHTML = "";

    for (const group of data.groups) {
      const wrap = document.createElement("div");
      wrap.className = "res-group";
      const h = document.createElement("h3");
      h.textContent = group.label;
      wrap.appendChild(h);

      for (const item of group.items) {
        const row = document.createElement("div");
        row.className = "res-item";

        const meta = document.createElement("div");
        meta.className = "meta";
        const a = document.createElement("a");
        a.className = "title";
        a.href = item.url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = item.title;
        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = item.desc;
        meta.append(a, desc);

        const host = document.createElement("div");
        host.className = "host";
        host.textContent = hostOf(item.url);

        row.append(meta, host);
        wrap.appendChild(row);
      }
      box.appendChild(wrap);
    }

    $("resources-source").textContent = `sumber: server data · ${data.groups.length} grup`;
  } catch {
    box.innerHTML = '<p class="muted">server data tidak terjangkau — jalankan <code>node data-server.mjs</code>.</p>';
  }
}

async function loadSessions() {
  const box = $("sessions");
  try {
    const res = await fetch("/api/opencode/sessions", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!data.sessions.length) {
      box.innerHTML = '<p class="muted">belum ada sesi.</p>';
      return;
    }
    box.innerHTML = "";
    for (const s of data.sessions) {
      const row = document.createElement("div");
      row.className = "res-item";
      const meta = document.createElement("div");
      meta.className = "meta";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = s.title;
      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = s.id;
      meta.append(title, desc);
      const when = document.createElement("div");
      when.className = "host";
      when.textContent = s.updated ? new Date(s.updated).toLocaleString("id-ID") : "—";
      row.append(meta, when);
      box.appendChild(row);
    }
  } catch {
    box.innerHTML = '<p class="muted">server opencode tidak terjangkau.</p>';
  }
}

$("refresh").addEventListener("click", () => {
  loadState();
  loadSessions();
});

loadResources();
loadState();
loadSessions();
setInterval(loadState, 5000);
setInterval(loadSessions, 20000);
