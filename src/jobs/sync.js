// ============================================================================
// Sync closed ROs from Tekmetric into our DB.
//
// Safeguards against over-pulling:
//   * The client throttles every request (see tekmetric.js) so we can't burst.
//   * INCREMENTAL by default — only ROs changed since the last successful sync.
//     Run once with { full: true } for the initial backfill.
//   * A run lock (in-process flag + Postgres advisory lock) prevents overlap.
//   * Customer names are cached in the DB, so repeat lookups cost no API calls.
//
// Users never call this — only the nightly cron / `npm run sync` does. The app
// UI reads exclusively from our database.
// ============================================================================
import {
  getAccessToken,
  fetchClosedRepairOrders,
  fetchEmployeeNames,
  fetchCustomerName,
  totalsForRepairOrder,
  resetRequestBudget,
} from "../tekmetric.js";
import { pool, query } from "../db/index.js";

const SHOP_ID = Number(process.env.TEKMETRIC_SHOP_ID);
const STATUSES = (process.env.TEKMETRIC_RO_STATUSES || "5,6")
  .split(",").map((s) => Number(s.trim()));
const WINDOW_DAYS = Number(process.env.SYNC_WINDOW_DAYS || 30);
// Refuse to run again within this many minutes (unless full/forced) — stops any
// accidental re-triggering from turning into repeated pulls.
const MIN_INTERVAL_MIN = Number(process.env.SYNC_MIN_INTERVAL_MINUTES || 720); // 12h
const ADVISORY_LOCK_KEY = 918273; // arbitrary constant shared by all instances

let running = false; // in-process guard

export async function runSync({ full = false, force = false, windowDays = WINDOW_DAYS } = {}) {
  if (running) {
    console.log("· Sync already running in this process — skipping.");
    return { skipped: true };
  }
  running = true;

  // Cross-instance guard: if another Railway instance holds the lock, bail out.
  const lock = await query("SELECT pg_try_advisory_lock($1) AS ok", [ADVISORY_LOCK_KEY]);
  if (!lock.rows[0].ok) {
    running = false;
    console.log("· Another instance is syncing — skipping.");
    return { skipped: true };
  }

  const started = Date.now();
  try {
    const state = await query("SELECT last_synced_at, last_run_at FROM sync_state WHERE id = 1");
    const lastSynced = state.rows[0]?.last_synced_at;
    const lastRun = state.rows[0]?.last_run_at;

    // Cooldown: don't run again too soon unless it's a full backfill or forced.
    if (!full && !force && lastRun) {
      const minsSince = (Date.now() - new Date(lastRun).getTime()) / 60000;
      if (minsSince < MIN_INTERVAL_MIN) {
        console.log(`· Last sync was ${minsSince.toFixed(0)}m ago (min ${MIN_INTERVAL_MIN}m) — skipping.`);
        return { skipped: true, reason: "cooldown" };
      }
    }

    resetRequestBudget(); // refill the per-run request ceiling
    const useIncremental = !full && lastSynced;

    // Tekmetric wants full ISO-8601 timestamps with an offset (ZonedDateTime),
    // e.g. 2026-06-13T00:00:00Z — not a bare date.
    const isoZ = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

    // Build the date filter: incremental (updated-since) or full (posted window).
    const filters = { shopId: SHOP_ID, statuses: STATUSES };
    if (useIncremental) {
      // Re-check a day before last sync to catch anything that landed late.
      const since = new Date(lastSynced);
      since.setDate(since.getDate() - 1);
      filters.updatedStart = isoZ(since);
    } else {
      const start = new Date();
      start.setDate(start.getDate() - windowDays);
      start.setHours(0, 0, 0, 0);
      filters.postedStart = isoZ(start);
      filters.postedEnd = isoZ(new Date());
    }

    await getAccessToken();
    const advisorNames = await fetchEmployeeNames(SHOP_ID);
    const ros = await fetchClosedRepairOrders(filters);

    // Seed a customer-name cache from what we already stored (0 API calls for known ones).
    const custCache = new Map();
    const seed = await query(
      "SELECT DISTINCT customer_id, customer_name FROM repair_orders WHERE customer_name IS NOT NULL"
    );
    for (const row of seed.rows) custCache.set(Number(row.customer_id), row.customer_name);

    let upserts = 0;
    for (const ro of ros) {
      const { approvedCents, declinedCents } = totalsForRepairOrder(ro);

      let customerName = custCache.get(ro.customerId);
      if (customerName === undefined && ro.customerId) {
        try {
          customerName = await fetchCustomerName(ro.customerId);
        } catch {
          customerName = null; // one bad customer shouldn't abort the sync
        }
        custCache.set(ro.customerId, customerName);
      }

      await query(
        `INSERT INTO repair_orders
           (tek_id, ro_number, shop_id, status_id, posted_date, updated_date,
            service_writer_id, advisor_name, customer_id, customer_name,
            approved_cents, declined_cents, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (tek_id) DO UPDATE SET
           ro_number=$2, status_id=$4, posted_date=$5, updated_date=$6,
           service_writer_id=$7, advisor_name=$8, customer_id=$9, customer_name=$10,
           approved_cents=$11, declined_cents=$12, synced_at=now()`,
        [
          ro.id, ro.repairOrderNumber, ro.shopId, ro.repairOrderStatus?.id,
          ro.postedDate, ro.updatedDate,
          ro.serviceWriterId, advisorNames.get(ro.serviceWriterId) || null,
          ro.customerId, customerName ?? null,
          approvedCents, declinedCents,
        ]
      );

      await query(
        `INSERT INTO callback_items (ro_tek_id, attempt, kind)
         VALUES ($1, 1, 'initial')
         ON CONFLICT (ro_tek_id) WHERE kind = 'initial' DO NOTHING`,
        [ro.id]
      );
      upserts++;
    }

    await query(
      `UPDATE sync_state
         SET last_synced_at = now(), last_run_at = now(), last_count = $1, last_error = NULL
       WHERE id = 1`,
      [upserts]
    );

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `✓ Sync complete: ${upserts} ROs in ${secs}s ` +
      `(${useIncremental ? "incremental" : `full ${windowDays}d backfill`}).`
    );
    return { count: upserts, seconds: Number(secs), mode: useIncremental ? "incremental" : "full" };
  } catch (err) {
    await query("UPDATE sync_state SET last_run_at = now(), last_error = $1 WHERE id = 1",
      [String(err).slice(0, 500)]).catch(() => {});
    throw err;
  } finally {
    await query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    running = false;
  }
}
