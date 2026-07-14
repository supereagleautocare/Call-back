// ============================================================================
// REST API. Everything here reads/writes OUR database only — zero Tekmetric
// calls happen on user actions.
// ============================================================================
import { Router } from "express";
import { query } from "./db/index.js";
import { requireManager, requireOwner } from "./auth.js";
import { roDeepLink } from "./tekmetric.js";
import { runSync } from "./jobs/sync.js";

const SHOP_ID = Number(process.env.TEKMETRIC_SHOP_ID);
const centsToDollars = (c) => Math.round(Number(c || 0)) / 100;

// Shape one joined callback row for the frontend.
function toCallback(r) {
  return {
    id: Number(r.id),
    roId: Number(r.ro_tek_id),
    roNumber: r.ro_number,
    roLink: roDeepLink(SHOP_ID, r.ro_tek_id),
    postedDate: r.posted_date,
    advisor: r.advisor_name || "Unassigned",
    customer: r.customer_name || "—",
    approved: centsToDollars(r.approved_cents),
    declined: centsToDollars(r.declined_cents),
    notes: r.notes || "",
    attempt: r.attempt,
    kind: r.kind,
    dueDate: r.due_date,
    completed: r.completed,
    completedBy: r.completed_by,
    completedAt: r.completed_at,
    followUpDate: r.follow_up_date,
  };
}

const SELECT_JOIN = `
  SELECT ci.*, ro.ro_number, ro.posted_date, ro.advisor_name, ro.customer_name,
         ro.approved_cents, ro.declined_cents
  FROM callback_items ci
  JOIN repair_orders ro ON ro.tek_id = ci.ro_tek_id`;

export function apiRouter() {
  const r = Router();

  // Who am I (drives the UI: manager scoreboard, owner gear, etc.)
  r.get("/me", (req, res) =>
    res.json({ ...req.session.user, domain: process.env.ALLOWED_DOMAIN || "" }));

  // Tiles + tab counts for the selected date range (+ optional advisor).
  // Open work is scoped by posted date; the Completed count by completion date.
  r.get("/summary", async (req, res) => {
    const { advisor, from, to } = req.query;
    const params = [];
    let adv = "";
    if (advisor) { params.push(advisor); adv = ` AND ro.advisor_name = $${params.length}`; }
    // date clause for open work (posted date)
    let postedRange = "";
    if (from) { params.push(from); postedRange += ` AND ro.posted_date >= $${params.length}`; }
    if (to) { params.push(to); postedRange += ` AND ro.posted_date <= ($${params.length}::date + 1)`; }

    const open = await query(
      `${SELECT_JOIN} WHERE ci.completed = false${adv}${postedRange}`, params);

    const today = new Date();
    const age = (d) => Math.floor((today - new Date(d)) / 86400000);
    let approved = 0, declined = 0, overdue = 0;
    for (const x of open.rows) {
      approved += Number(x.approved_cents || 0);
      declined += Number(x.declined_cents || 0);
      const eff = x.kind === "followup" ? x.due_date : x.posted_date;
      if (eff && age(eff) >= 3) overdue++;
    }

    // Tab counts: active/followups by posted date, completed by completion date.
    const cp = [];
    let cadv = "", cActiveRange = "", cDoneRange = "";
    if (advisor) { cp.push(advisor); cadv = ` AND ro.advisor_name = $${cp.length}`; }
    if (from) { cp.push(from); cActiveRange += ` AND ro.posted_date >= $${cp.length}`; cDoneRange += ` AND ci.completed_at >= $${cp.length}`; }
    if (to) { cp.push(to); cActiveRange += ` AND ro.posted_date <= ($${cp.length}::date + 1)`; cDoneRange += ` AND ci.completed_at <= ($${cp.length}::date + 1)`; }
    const counts = await query(
      `SELECT
         COUNT(*) FILTER (WHERE completed = false AND (kind = 'initial' OR due_date <= CURRENT_DATE)${cActiveRange})  AS active,
         COUNT(*) FILTER (WHERE completed = false AND kind = 'followup' AND due_date > CURRENT_DATE${cActiveRange})   AS followups,
         COUNT(*) FILTER (WHERE completed = true${cDoneRange})                                                       AS completed
       FROM callback_items ci JOIN repair_orders ro ON ro.tek_id = ci.ro_tek_id
       WHERE true${cadv}`, cp);

    res.json({
      open: open.rows.length,
      approved: centsToDollars(approved),
      declined: centsToDollars(declined),
      overdue,
      counts: counts.rows[0],
    });
  });

  // Last sync info for the header line
  r.get("/sync-status", async (_req, res) => {
    const s = await query(
      "SELECT last_synced_at, last_count, last_run_at, last_error FROM sync_state WHERE id = 1");
    res.json(s.rows[0] || {});
  });

  // Distinct advisor names for the filter dropdown
  r.get("/advisors", async (_req, res) => {
    const rows = await query(
      "SELECT DISTINCT advisor_name FROM repair_orders WHERE advisor_name IS NOT NULL ORDER BY advisor_name");
    res.json(rows.rows.map((x) => x.advisor_name));
  });

  // The main list. ?view=active|followups|completed &from&to&advisor&q
  r.get("/callbacks", async (req, res) => {
    const { view = "active", from, to, advisor, q } = req.query;
    const where = [];
    const params = [];
    const add = (clause, val) => { params.push(val); where.push(clause.replace("?", `$${params.length}`)); };

    // Active = work to do now: initial callbacks + follow-ups that have come due.
    //   Ordered by "effective date" (a follow-up's due date, else the RO posted
    //   date), newest first — so a follow-up appears at the top on its due date
    //   and gets pushed down as newer days arrive.
    // Follow-ups tab = only those still scheduled ahead, soonest due first.
    let dateCol, orderDir = "DESC", applyRange = true;
    if (view === "active") {
      where.push("ci.completed = false AND (ci.kind = 'initial' OR ci.due_date <= CURRENT_DATE)");
      dateCol = "COALESCE(ci.due_date, ro.posted_date)";
    } else if (view === "followups") {
      where.push("ci.completed = false AND ci.kind = 'followup' AND ci.due_date > CURRENT_DATE");
      dateCol = "ci.due_date";
      orderDir = "ASC";      // next-to-come-due at the top
      applyRange = false;    // future items live outside the "up to today" range
    } else {
      where.push("ci.completed = true");
      dateCol = "ci.completed_at";
    }

    if (applyRange) {
      if (from) add(`${dateCol} >= ?`, from);
      if (to) add(`${dateCol} <= (?::date + 1)`, to); // inclusive of the "to" day
    }
    if (advisor) add("ro.advisor_name = ?", advisor);
    if (q) {
      params.push(q);
      const p = `$${params.length}`; // one param, referenced twice
      where.push(`(ro.customer_name ILIKE '%'||${p}||'%' OR ro.ro_number::text ILIKE '%'||${p}||'%')`);
    }

    const sql = `${SELECT_JOIN} WHERE ${where.join(" AND ")} ORDER BY ${dateCol} ${orderDir}`;
    const rows = await query(sql, params);
    res.json(rows.rows.map(toCallback));
  });

  // Save a note (autosave from the textarea)
  r.patch("/callbacks/:id/notes", async (req, res) => {
    const { notes = "" } = req.body;
    await query("UPDATE callback_items SET notes = $1 WHERE id = $2", [notes, req.params.id]);
    res.json({ ok: true });
  });

  // Complete a callback, optionally scheduling a follow-up.
  // body: { notes, followUpDate?: "YYYY-MM-DD" }
  r.post("/callbacks/:id/complete", async (req, res) => {
    const { notes, followUpDate } = req.body;
    if (!notes || !notes.trim()) return res.status(400).json({ error: "A note is required to complete." });

    const found = await query("SELECT * FROM callback_items WHERE id = $1", [req.params.id]);
    const item = found.rows[0];
    if (!item) return res.status(404).json({ error: "not found" });

    const user = req.session.user;
    await query(
      `UPDATE callback_items
         SET notes = $1, completed = true, completed_by = $2, completed_by_email = $3,
             completed_at = now(), follow_up_date = $4
       WHERE id = $5`,
      [notes, user.name, user.email, followUpDate || null, item.id]
    );

    // Scheduling a follow-up spawns a fresh item in the Follow-ups tab.
    if (followUpDate) {
      await query(
        `INSERT INTO callback_items (ro_tek_id, attempt, kind, due_date)
         VALUES ($1, $2, 'followup', $3)`,
        [item.ro_tek_id, (item.attempt || 1) + 1, followUpDate]
      );
    }
    res.json({ ok: true });
  });

  // --- Manager: scoreboard (per-advisor, own date range) ------------------
  r.get("/scoreboard", requireManager, async (req, res) => {
    const { from, to, advisor } = req.query;
    // Open/overdue for ROs posted in range
    const op = [];
    let openWhere = "ci.completed = false";
    if (advisor) { op.push(advisor); openWhere += ` AND ro.advisor_name = $${op.length}`; }
    if (from) { op.push(from); openWhere += ` AND ro.posted_date >= $${op.length}`; }
    if (to) { op.push(to); openWhere += ` AND ro.posted_date <= ($${op.length}::date + 1)`; }
    const open = await query(`${SELECT_JOIN} WHERE ${openWhere}`, op);

    // Completions within the chosen range (by completion date)
    const doneParams = [];
    let doneWhere = "ci.completed = true";
    if (advisor) { doneParams.push(advisor); doneWhere += ` AND ro.advisor_name = $${doneParams.length}`; }
    if (from) { doneParams.push(from); doneWhere += ` AND ci.completed_at >= $${doneParams.length}`; }
    if (to) { doneParams.push(to); doneWhere += ` AND ci.completed_at <= ($${doneParams.length}::date + 1)`; }
    const done = await query(`${SELECT_JOIN} WHERE ${doneWhere}`, doneParams);

    const board = new Map();
    const row = (name) => {
      if (!board.has(name)) board.set(name, { advisor: name, open: 0, overdue: 0, completed: 0, declinedOpen: 0 });
      return board.get(name);
    };
    const today = new Date();
    const daysBetween = (d) => Math.floor((today - new Date(d)) / 86400000);
    for (const x of open.rows) {
      const b = row(x.advisor_name || "Unassigned");
      b.open++;
      b.declinedOpen += Number(x.declined_cents || 0);
      const effective = x.kind === "followup" ? x.due_date : x.posted_date;
      if (effective && daysBetween(effective) >= 3) b.overdue++;
    }
    for (const x of done.rows) row(x.advisor_name || "Unassigned").completed++;

    res.json([...board.values()].map((b) => ({ ...b, declinedOpen: centsToDollars(b.declinedOpen) })));
  });

  // --- Owner: trigger a Tekmetric pull ------------------------------------
  let syncing = false;
  r.get("/admin/sync", requireOwner, (_req, res) => res.json({ running: syncing }));
  r.post("/admin/sync", requireOwner, (req, res) => {
    if (syncing) return res.json({ started: false, running: true });
    syncing = true;
    runSync({ full: !!req.body.full, force: true })
      .catch((e) => console.error("Manual sync error:", e))
      .finally(() => { syncing = false; });
    res.json({ started: true });
  });

  // --- Owner: Team & Access admin -----------------------------------------
  r.get("/admin/users", requireOwner, async (_req, res) => {
    const rows = await query(
      "SELECT email, display_name, is_manager, is_guest FROM app_users ORDER BY is_guest, email");
    res.json(rows.rows);
  });
  r.patch("/admin/users/:email", requireOwner, async (req, res) => {
    if (req.params.email.toLowerCase() === (process.env.OWNER_EMAIL || "").toLowerCase())
      return res.status(400).json({ error: "The owner is always a manager." });
    await query("UPDATE app_users SET is_manager = $1 WHERE email = $2",
      [!!req.body.isManager, req.params.email.toLowerCase()]);
    res.json({ ok: true });
  });
  r.post("/admin/guests", requireOwner, async (req, res) => {
    const email = (req.body.email || "").toLowerCase().trim();
    if (!email.includes("@")) return res.status(400).json({ error: "Enter a valid email." });
    if (email.endsWith(`@${(process.env.ALLOWED_DOMAIN || "").toLowerCase()}`))
      return res.status(400).json({ error: "That's a company email — they already have access." });
    await query(
      `INSERT INTO app_users (email, is_guest) VALUES ($1, true)
       ON CONFLICT (email) DO UPDATE SET is_guest = true`, [email]);
    res.json({ ok: true });
  });
  r.delete("/admin/guests/:email", requireOwner, async (req, res) => {
    await query("DELETE FROM app_users WHERE email = $1 AND is_guest = true",
      [req.params.email.toLowerCase()]);
    res.json({ ok: true });
  });

  return r;
}
