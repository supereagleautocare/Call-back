// ============================================================================
// Callback Tracker — frontend. Talks only to our own /api endpoints.
// ============================================================================
const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) { location.href = "/auth/login"; return null; }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
};

// --- date helpers (real "today") -------------------------------------------
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MS_DAY = 86400000;
// Calendar-date keys (avoid timezone drift):
const todayMs = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
const tsMs = (v) => { const d = new Date(v); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }; // timestamp -> local cal date
const dayMs = (v) => { const [y,m,d] = String(v).slice(0,10).split("-").map(Number); return Date.UTC(y, m-1, d); }; // date-only -> cal date
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// date-string math done in UTC so it never shifts a day across timezones
const shift = (base, days) => { const [y,m,d] = base.split("-").map(Number); const dt = new Date(Date.UTC(y, m-1, d)); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0,10); };
const daysOpen = (v) => Math.round((todayMs() - tsMs(v)) / MS_DAY);
// format a timestamp (posted/completed) as a local calendar date
const fmtDate = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return `<span>${MONTHS[d.getMonth()]} ${d.getDate()}</span> <span class="yr">'${String(d.getFullYear()).slice(2)}</span>`;
};
// format a date-only value ("YYYY-MM-DD") from its parts — no timezone shift
const fmtDay = (v) => {
  if (!v) return "";
  const [y,m,d] = String(v).slice(0,10).split("-").map(Number);
  return `<span>${MONTHS[m-1]} ${d}</span> <span class="yr">'${String(y).slice(2)}</span>`;
};
const initials = (n) => (n || "?").split(" ").map((x) => x[0]).join("").slice(0,2).toUpperCase();
const TODAY = iso(new Date());

function rangeFor(key) {
  const t = new Date();
  const dow = (t.getDay() + 6) % 7; // 0 = Monday
  switch (key) {
    case "today":      return [TODAY, TODAY];
    case "yesterday":  return [shift(TODAY,-1), shift(TODAY,-1)];
    case "last7":      return [shift(TODAY,-6), TODAY];
    case "this-week":  return [shift(TODAY,-dow), TODAY];
    case "last-week":  return [shift(TODAY,-dow-7), shift(TODAY,-dow-1)];
    case "this-month": return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), TODAY];
    case "last-month": return [iso(new Date(t.getFullYear(), t.getMonth()-1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))];
    default:           return null;
  }
}
function ageTag(v) {
  const n = daysOpen(v);
  const label = n <= 0 ? "Posted today" : `Posted ${n} day${n === 1 ? "" : "s"} ago`;
  const cls = n >= 3 ? "over" : n === 2 ? "warn" : "";
  return `<span class="age ${cls}">${label}</span>`;
}
const effDate = (r) => (r.kind === "followup" ? r.dueDate : r.postedDate);
// days aged on the effective date (a follow-up's due date, else the post date)
const effAge = (r) => r.kind === "followup"
  ? Math.round((todayMs() - dayMs(r.dueDate)) / MS_DAY)
  : daysOpen(r.postedDate);
const isOverdue = (r) => !r.completed && effAge(r) >= 3;

// --- state -----------------------------------------------------------------
let me = null;
let view = "active";
let sortKey = "date", sortDir = "desc";
let userSorted = false; // false = use the server's natural order for the tab
const advVal = () => $("f-advisor").value;

// ============================================================================
// Boot
// ============================================================================
(async function boot() {
  me = await api("/api/me");
  if (!me) return;
  $("userAv").textContent = initials(me.name);
  $("roleLabel").innerHTML = `${me.name} &middot; ${me.isManager ? "Manager" : "Advisor"}`;
  if (me.isOwner) $("adminBtn").style.display = "";
  $("scoreboard").classList.toggle("hidden", !me.isManager);
  if (me.domain) $("admin-domain").textContent = "@" + me.domain;

  // advisor dropdown
  await loadAdvisors();

  loadSyncLine();
  const [rf, rt] = rangeFor("this-month");   // one date range drives everything
  $("f-from").value = rf; $("f-to").value = rt; $("f-range").value = "this-month";
  wireEvents();
  refresh();
})();

async function loadAdvisors() {
  const advisors = await api("/api/advisors");
  const sel = $("f-advisor");
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>';
  for (const a of advisors) {
    const o = document.createElement("option"); o.value = a; o.textContent = a;
    sel.appendChild(o);
  }
  sel.value = current; // keep any active selection
}

async function loadSyncLine() {
  try {
    const s = await api("/api/sync-status");
    const when = s?.last_synced_at
      ? new Date(s.last_synced_at).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" })
      : "not yet";
    $("syncLine").innerHTML = `<span class="pulse"></span> Auto-synced from Tekmetric &middot; ${when}`;
  } catch { /* leave as-is */ }
}

// ============================================================================
// Main list
// ============================================================================
async function refresh() {
  const params = new URLSearchParams({ view });
  const from = $("f-from").value, to = $("f-to").value, adv = advVal(), q = $("f-search").value.trim();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (adv) params.set("advisor", adv);
  if (q) params.set("q", q);

  // summary + scoreboard share the same range/advisor, just not the tab or search
  const sp = new URLSearchParams();
  if (from) sp.set("from", from);
  if (to) sp.set("to", to);
  if (adv) sp.set("advisor", adv);

  const [rows, summary] = await Promise.all([
    api("/api/callbacks?" + params.toString()),
    api("/api/summary?" + sp.toString()),
  ]);
  renderTable(rows || []);
  renderSummary(summary);
  if (me.isManager && !$("scoreboard").classList.contains("hidden")) renderScoreboard();
}

function sortRows(rows) {
  const val = (r) => sortKey === "date" ? (effDate(r) || "")
    : { advisor: r.advisor, customer: r.customer, ro: r.roNumber, approved: r.approved, declined: r.declined }[sortKey];
  return rows.sort((a, b) => {
    let av = val(a), bv = val(b), cmp;
    if (typeof av === "number") cmp = av - bv;
    else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    return sortDir === "asc" ? cmp : -cmp;
  });
}

function renderTable(rows) {
  // Until the user clicks a header, keep the server's per-tab order
  // (Active newest-effective-date first; Follow-ups soonest-due first).
  document.querySelectorAll("thead th.sortable").forEach((th) => {
    const on = userSorted && th.dataset.sort === sortKey;
    th.classList.toggle("sorted", on);
    th.querySelector(".arrow").textContent = on ? (sortDir === "asc" ? "▲" : "▼") : "";
  });
  if (userSorted) sortRows(rows);
  $("th-last").textContent = view === "completed" ? "Completed" : "";
  $("th-last").textContent = view === "completed" ? "Completed" : "";

  const tb = $("rows");
  tb.innerHTML = "";
  if (!rows.length) {
    const EMPTY = {
      active:    ["🎉", "All caught up — no open callbacks match these filters."],
      followups: ["🔁", "No follow-ups scheduled in this range."],
      completed: ["✓", "No completed callbacks in this range yet."],
    }[view];
    tb.innerHTML = `<tr><td colspan="8"><div class="empty"><div class="big">${EMPTY[0]}</div>${EMPTY[1]}</div></td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    if (isOverdue(r)) tr.className = "overdue";

    let dateCell = fmtDate(r.postedDate);
    if (!r.completed) {
      if (r.kind === "followup") {
        const pastDue = Math.round((todayMs() - dayMs(r.dueDate)) / MS_DAY); // >0 overdue, 0 today, <0 future
        const label = pastDue > 0 ? `${pastDue}d overdue` : pastDue === 0 ? "due today" : `due in ${-pastDue}d`;
        dateCell = `${fmtDay(r.dueDate)}<br><span class="fu-tag">🔁 Attempt ${r.attempt}</span> <span class="age ${pastDue >= 0 ? "over" : "warn"}">${label}</span>`;
      } else {
        dateCell = `${fmtDate(r.postedDate)}<br>${ageTag(r.postedDate)}`;
      }
    }

    tr.innerHTML = `
      <td class="date">${dateCell}</td>
      <td><span class="advisor">${r.advisor}</span></td>
      <td class="cust">${r.customer}</td>
      <td><a class="ro-link" href="${r.roLink}" target="_blank" rel="noopener" title="Open RO in Tekmetric">#${r.roNumber} <span class="ext">↗</span></a></td>
      <td class="num money ${r.approved ? "pos" : "zero"} tnum">${money(r.approved)}</td>
      <td class="num money ${r.declined ? "neg" : "zero"} tnum">${money(r.declined)}</td>
      <td></td>
      <td class="actions"></td>`;

    const notesCell = tr.children[6];
    if (r.completed) {
      notesCell.innerHTML = `<span style="color:var(--ink-2)">${escapeHtml(r.notes) || "—"}</span>`;
      const done =
        `<div class="date" style="font-weight:600">${fmtDate(r.completedAt)}</div>` +
        `<span class="done-badge"><span class="chk">✓</span> ${r.completedBy || ""}</span>`;
      const fu = r.followUpDate
        ? `<div style="margin-top:6px"><span class="fu-badge">🔁 Follow-up → ${fmtDay(r.followUpDate).replace(/<[^>]+>/g,"")}</span></div>`
        : "";
      tr.children[7].innerHTML = done + fu;
    } else {
      // Repeat callbacks: show a button to review notes from earlier attempts.
      if (r.attempt > 1) {
        const hist = document.createElement("button");
        hist.className = "hist-btn"; hist.innerHTML = "🕘 Previous notes";
        hist.onclick = () => openHistory(r.roId, r.roNumber);
        notesCell.appendChild(hist);
      }
      const ta = document.createElement("textarea");
      ta.className = "notes-input"; ta.rows = 2; ta.placeholder = "What happened on the callback?"; ta.value = r.notes || "";
      const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
      notesCell.appendChild(ta);
      requestAnimationFrame(grow);

      const btn = document.createElement("button");
      btn.className = "complete-btn"; btn.innerHTML = "✓ Complete";
      const sync = () => { btn.disabled = !ta.value.trim(); btn.title = ta.value.trim() ? "Complete this callback" : "Add a note before completing"; };
      sync();

      let saveTimer;
      ta.addEventListener("input", () => {
        sync(); grow();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => api(`/api/callbacks/${r.id}/notes`, { method: "PATCH", body: JSON.stringify({ notes: ta.value }) }), 500);
      });
      btn.onclick = () => { if (!ta.value.trim()) { ta.focus(); return; } openFuPop(r.id, () => ta.value, btn); };
      tr.children[7].appendChild(btn);
    }
    tb.appendChild(tr);
  }
}

function renderSummary(s) {
  if (!s) return;
  $("t-open").textContent = s.open;
  $("t-open-meta").textContent = advVal() || "in this date range";
  $("t-appr").textContent = money(s.approved);
  $("t-decl").textContent = money(s.declined);
  $("t-over").textContent = s.overdue;
  $("c-active").textContent = s.counts.active;
  $("c-followups").textContent = s.counts.followups;
  $("c-completed").textContent = s.counts.completed;
}

const escapeHtml = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));

// ============================================================================
// Complete + follow-up popover
// ============================================================================
let fuId = null, fuGetNotes = null;
function openFuPop(id, getNotes, btn) {
  fuId = id; fuGetNotes = getNotes;
  const pop = $("fuPop");
  $("fuDate").value = shift(TODAY, 3);
  pop.classList.remove("hidden");
  const rect = btn.getBoundingClientRect();
  let left = rect.right + scrollX - pop.offsetWidth;
  let top = rect.bottom + scrollY + 6;
  if (left < 8) left = 8;
  if (rect.bottom + pop.offsetHeight + 10 > innerHeight) top = rect.top + scrollY - pop.offsetHeight - 6;
  pop.style.left = left + "px"; pop.style.top = top + "px";
  setTimeout(() => document.addEventListener("click", fuOutside), 0);
}
function fuOutside(e) { if (!$("fuPop").contains(e.target)) closeFu(); }
function closeFu() { $("fuPop").classList.add("hidden"); fuId = null; document.removeEventListener("click", fuOutside); }
async function completeNow(followUpDate) {
  const notes = fuGetNotes();
  if (!notes.trim()) return;
  const id = fuId;
  closeFu();
  await api(`/api/callbacks/${id}/complete`, { method: "POST", body: JSON.stringify({ notes, followUpDate: followUpDate || null }) });
  refresh();
}

// ============================================================================
// Manager scoreboard (follows the single date range at the top)
// ============================================================================
async function renderScoreboard() {
  const from = $("f-from").value, to = $("f-to").value, adv = $("f-advisor").value;
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (adv) params.set("advisor", adv);
  const rows = await api("/api/scoreboard?" + params.toString());
  const noteFmt = (v) => fmtDay(v).replace(/<[^>]+>/g, "");
  $("sb-note").innerHTML =
    `Open, overdue, completed &amp; declined-$ per advisor for <b>${noteFmt(from)} – ${noteFmt(to)}</b>.`;
  const tb = $("sb-rows");
  tb.innerHTML = "";
  for (const b of (rows || [])) {
    const denom = (b.open + b.completed) || 1;
    const pct = Math.round((b.completed / denom) * 100);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="adv-name">${b.advisor}</span></td>
      <td class="num tnum">${b.open}</td>
      <td class="num tnum ${b.overdue ? "flag" : "flag ok"}">${b.overdue || "—"}</td>
      <td class="num tnum">${b.completed}</td>
      <td><div class="bar"><span style="width:${pct}%"></span></div></td>
      <td class="num tnum money neg">${money(b.declinedOpen)}</td>`;
    tb.appendChild(tr);
  }
}

// ============================================================================
// Previous-notes / call history popup
// ============================================================================
async function openHistory(roId, roNumber) {
  $("history-title").textContent = `RO #${roNumber} — call history`;
  const body = $("history-body");
  body.innerHTML = "Loading…";
  $("historyOverlay").classList.remove("hidden");
  const items = await api(`/api/ro/${roId}/history`);
  const done = (items || []).filter((i) => i.completed); // earlier calls that were logged
  const plain = (h) => h.replace(/<[^>]+>/g, "");
  if (!done.length) {
    body.innerHTML = `<div class="guest-empty">No earlier calls have been logged on this RO yet.</div>`;
    return;
  }
  body.innerHTML = "";
  for (const it of done) {
    const div = document.createElement("div");
    div.className = "hist-item";
    div.innerHTML =
      `<div class="hist-head"><b>Attempt ${it.attempt}</b> · ${it.completedBy || ""} · ${plain(fmtDate(it.completedAt))}</div>` +
      `<div class="hist-note">${escapeHtml(it.notes) || '<span style="color:var(--ink-3)">(no note)</span>'}</div>` +
      (it.followUpDate ? `<span class="hist-fu">🔁 scheduled follow-up → ${plain(fmtDay(it.followUpDate))}</span>` : "");
    body.appendChild(div);
  }
}

// ============================================================================
// Owner: pull data from Tekmetric
// ============================================================================
async function loadSyncStatusText() {
  const s = await api("/api/sync-status");
  const el = $("sync-status-text");
  if (!el) return;
  // Show an error only if the last run failed and we've never had a good sync.
  if (s?.last_error && !s?.last_synced_at) {
    el.innerHTML = `<span style="color:var(--declined)">Last pull failed: ${escapeHtml(s.last_error)}</span>`;
    return;
  }
  if (s?.last_synced_at) {
    const when = new Date(s.last_synced_at).toLocaleString(undefined, { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });
    el.textContent = `Last pulled ${when} · ${s.last_count ?? 0} repair orders. Nightly auto-pull is on.`;
  } else {
    el.textContent = "No data yet — click Pull now to load the last 30 days of closed ROs.";
  }
}
async function startPull() {
  const btn = $("sync-now");
  btn.disabled = true; btn.textContent = "Pulling…";
  $("sync-status-text").textContent = "Pulling from Tekmetric — this can take a minute…";
  const first = await api("/api/sync-status");
  await api("/api/admin/sync", { method: "POST", body: JSON.stringify({ full: !first?.last_synced_at }) });
  // poll until the run finishes
  const timer = setInterval(async () => {
    const st = await api("/api/admin/sync");
    if (!st.running) {
      clearInterval(timer);
      btn.disabled = false; btn.textContent = "Pull now";
      await loadSyncStatusText();
      loadSyncLine();
      loadAdvisors();
      refresh();
    }
  }, 3000);
}

// ============================================================================
// Admin: Team & Access
// ============================================================================
async function renderAdmin() {
  const users = await api("/api/admin/users");
  const members = users.filter((u) => !u.is_guest);
  const guests = users.filter((u) => u.is_guest);

  const ml = $("member-list");
  ml.innerHTML = members.length ? "" : `<div class="guest-empty">No one has signed in yet.</div>`;
  for (const u of members) {
    const isOwnerRow = u.email === me.email && me.isOwner;
    const row = document.createElement("div");
    row.className = "member" + (isOwnerRow ? " owner" : "");
    row.innerHTML = `
      <span class="av" style="background:var(--brand)">${initials(u.display_name || u.email)}</span>
      <div class="who">
        <div class="nm">${u.display_name || u.email.split("@")[0]}${isOwnerRow ? ' <span class="role-pill mgr">Owner</span>' : ""}</div>
        <div class="em">${u.email}</div>
      </div>
      <span class="role-pill ${u.is_manager ? "mgr" : "adv"}">${u.is_manager ? "Manager" : "Advisor"}</span>
      <label class="switch">
        <input type="checkbox" ${u.is_manager ? "checked" : ""} ${isOwnerRow ? "disabled" : ""} aria-label="Manager access for ${u.email}">
        <span class="track"></span><span class="knob"></span>
      </label>`;
    row.querySelector("input").addEventListener("change", async (e) => {
      await api(`/api/admin/users/${encodeURIComponent(u.email)}`, { method: "PATCH", body: JSON.stringify({ isManager: e.target.checked }) });
      renderAdmin();
    });
    ml.appendChild(row);
  }

  const gl = $("guest-list");
  gl.innerHTML = guests.length ? "" : `<div class="guest-empty">No guests yet — everyone with a company email already has access.</div>`;
  for (const g of guests) {
    const row = document.createElement("div");
    row.className = "member";
    row.innerHTML = `
      <span class="av" style="background:var(--amber)">${g.email.slice(0,2).toUpperCase()}</span>
      <div class="who"><div class="nm">${g.email.split("@")[0]} <span class="role-pill adv">Guest</span></div><div class="em">${g.email}</div></div>
      <span class="role-pill ${g.is_manager ? "mgr" : "adv"}">${g.is_manager ? "Manager" : "Advisor"}</span>
      <label class="switch"><input type="checkbox" ${g.is_manager ? "checked" : ""} aria-label="Manager access for ${g.email}"><span class="track"></span><span class="knob"></span></label>
      <button class="remove" title="Remove access" aria-label="Remove ${g.email}">✕</button>`;
    row.querySelector("input").addEventListener("change", async (e) => {
      await api(`/api/admin/users/${encodeURIComponent(g.email)}`, { method: "PATCH", body: JSON.stringify({ isManager: e.target.checked }) });
      renderAdmin();
    });
    row.querySelector(".remove").addEventListener("click", async () => {
      await api(`/api/admin/guests/${encodeURIComponent(g.email)}`, { method: "DELETE" });
      renderAdmin();
    });
    gl.appendChild(row);
  }
}

// ============================================================================
// Wire up events
// ============================================================================
function wireEvents() {
  // tabs
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active"); view = t.dataset.view; userSorted = false; refresh();
  });
  // sortable headers
  document.querySelectorAll("thead th.sortable").forEach((th) => th.onclick = () => {
    userSorted = true;
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = k; sortDir = (k === "approved" || k === "declined" || k === "date") ? "desc" : "asc"; }
    refresh();
  });
  // filters
  $("f-advisor").addEventListener("change", refresh);
  let searchTimer;
  $("f-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 300); });
  $("f-range").addEventListener("change", (e) => {
    const r = rangeFor(e.target.value);
    if (r) { $("f-from").value = r[0]; $("f-to").value = r[1]; }
    refresh();
  });
  ["f-from","f-to"].forEach((id) => $(id).addEventListener("change", () => { $("f-range").value = "custom"; refresh(); }));

  // follow-up popover
  $("fuNo").onclick = () => completeNow(null);
  document.querySelectorAll("#fuPop .when-btn").forEach((b) => b.onclick = () => completeNow(shift(TODAY, +b.dataset.days)));
  $("fuDateGo").onclick = () => { const d = $("fuDate").value; if (d) completeNow(d); };

  // history modal
  const histOv = $("historyOverlay");
  $("history-close").onclick = () => histOv.classList.add("hidden");
  histOv.addEventListener("click", (e) => { if (e.target === histOv) histOv.classList.add("hidden"); });

  // admin modal
  const overlay = $("adminOverlay");
  $("adminBtn").onclick = () => { renderAdmin(); loadSyncStatusText(); overlay.classList.remove("hidden"); };
  $("sync-now").onclick = startPull;
  $("adminClose").onclick = () => overlay.classList.add("hidden");
  $("adminDone").onclick = () => overlay.classList.add("hidden");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
  $("guest-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const hint = $("guest-hint"), email = $("guest-email").value.trim();
    try {
      await api("/api/admin/guests", { method: "POST", body: JSON.stringify({ email }) });
      $("guest-email").value = "";
      hint.textContent = "Added — they can now sign in with that Google account.";
      hint.style.color = "var(--approved)";
      renderAdmin();
    } catch {
      hint.textContent = "Couldn't add that email — check it's outside your domain and valid.";
      hint.style.color = "var(--declined)";
    }
  });

  // print the current list
  $("printBtn").onclick = () => {
    const tab = view === "active" ? "Active callbacks" : view === "followups" ? "Follow-ups" : "Completed callbacks";
    const noteFmt = (v) => v ? fmtDay(v).replace(/<[^>]+>/g, "") : "";
    const adv = advVal();
    $("print-head").innerHTML =
      `<h2>Super Eagle Auto Care — ${tab}</h2>` +
      `<div class="sub">${noteFmt($("f-from").value)} – ${noteFmt($("f-to").value)}` +
      ` · ${adv || "All advisors"} · printed ${new Date().toLocaleDateString()}</div>`;
    window.print();
  };

  // theme + escape
  $("themeBtn").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark"
      : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("adminOverlay").classList.add("hidden"); $("historyOverlay").classList.add("hidden"); closeFu(); } });
}
