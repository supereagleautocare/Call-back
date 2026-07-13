// ============================================================================
// Tekmetric API client — read-only.
// Handles the token exchange, rate-limit backoff, pagination, and the
// approved-vs-declined dollar math for each repair order.
// Docs: https://shop.tekmetric.com  (v1)
// ============================================================================

const HOST = process.env.TEKMETRIC_HOST || "https://shop.tekmetric.com";
const CLIENT_ID = process.env.TEKMETRIC_CLIENT_ID;
const CLIENT_SECRET = process.env.TEKMETRIC_CLIENT_SECRET;

let cachedToken = null; // Tekmetric tokens live until revoked, so we reuse one.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Request-rate throttle + budget ----------------------------------------
// Two independent ceilings so we can never over-pull, even with a bug:
//   1. RATE: every request waits its turn. Default 3/sec = 180/min — well under
//      Tekmetric's 600/min (and under the 300/min sandbox limit too).
//   2. BUDGET: a hard cap on total requests per sync run. If a run ever tries to
//      exceed it, it aborts instead of hammering the API.
const MAX_RPS = Number(process.env.TEKMETRIC_MAX_RPS || 3);
const MIN_INTERVAL_MS = 1000 / MAX_RPS;
const MAX_REQUESTS_PER_RUN = Number(process.env.TEKMETRIC_MAX_REQUESTS_PER_RUN || 1200);

let nextSlot = 0;
let requestBudget = MAX_REQUESTS_PER_RUN;

// Call this at the start of each sync run to refill the budget.
export function resetRequestBudget(n = MAX_REQUESTS_PER_RUN) {
  requestBudget = n;
}

async function throttle() {
  if (requestBudget <= 0) {
    throw new Error(
      `Tekmetric request budget exhausted (${MAX_REQUESTS_PER_RUN}/run). Aborting to protect the rate limit.`
    );
  }
  requestBudget--;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  // small jitter so repeated runs don't line up into a synchronized burst
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS + Math.random() * 40;
  if (wait > 0) await sleep(wait);
}

// Exchange client credentials for a bearer token (Basic base64(id:secret)).
export async function getAccessToken(force = false) {
  if (cachedToken && !force) return cachedToken;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  await throttle();
  const res = await fetch(`${HOST}/api/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cachedToken = json.access_token;
  return cachedToken;
}

// GET a path with automatic 401-refresh and 429 exponential backoff.
async function apiGet(path, { retries = 6 } = {}) {
  let token = await getAccessToken();
  for (let n = 1; ; n++) {
    await throttle();
    const res = await fetch(`${HOST}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && n === 1) {
      token = await getAccessToken(true); // token revoked/rotated — get a fresh one once
      continue;
    }
    if (res.status === 429) {
      if (n > retries) throw new Error("Tekmetric rate limit: retries exhausted");
      const wait = Math.min(2 ** n * 1000 + Math.random() * 1000, 60000);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// Walk every page of a list endpoint and return all rows.
// Handles both shapes Tekmetric uses: paginated { content, last } and plain arrays.
async function getAllPages(basePath) {
  const out = [];
  let page = 0;
  for (;;) {
    const sep = basePath.includes("?") ? "&" : "?";
    const body = await apiGet(`${basePath}${sep}size=100&page=${page}`);
    if (Array.isArray(body)) { out.push(...body); break; } // non-paginated endpoint
    const content = body.content || [];
    out.push(...content);
    if (body.last || content.length === 0) break;
    page++;
  }
  return out;
}

// --- Repair orders --------------------------------------------------------

// Pull closed ROs (statuses 5/6), filtered by EITHER a posted-date window
// (full backfill) or an updated-since date (incremental nightly run).
// Tekmetric takes one status per call, so we fetch each and merge.
//   filters: { shopId, statuses, postedStart, postedEnd, updatedStart }
export async function fetchClosedRepairOrders({
  shopId, statuses, postedStart, postedEnd, updatedStart,
}) {
  const byId = new Map(); // dedupe by RO id; if seen twice, keep the newest postedDate
  for (const status of statuses) {
    let path = `/api/v1/repair-orders?shop=${shopId}&repairOrderStatusId=${status}`;
    if (postedStart) path += `&postedDateStart=${encodeURIComponent(postedStart)}`;
    if (postedEnd) path += `&postedDateEnd=${encodeURIComponent(postedEnd)}`;
    if (updatedStart) path += `&updatedDateStart=${encodeURIComponent(updatedStart)}`;
    for (const ro of await getAllPages(path)) {
      const prev = byId.get(ro.id);
      if (!prev || new Date(ro.postedDate) > new Date(prev.postedDate)) byId.set(ro.id, ro);
    }
  }
  return [...byId.values()];
}

// Sum authorized (approved) vs declined job subtotals for one RO. Cents.
// job.authorized: true = approved, false = declined, null = never presented (ignored).
// job.subtotal is already net of the job's parts + labor + fees - discounts.
export function totalsForRepairOrder(ro) {
  let approved = 0;
  let declined = 0;
  for (const job of ro.jobs || []) {
    const amount = Number(job.subtotal) || 0;
    if (job.authorized === true) approved += amount;
    else if (job.authorized === false) declined += amount;
  }
  return { approvedCents: approved, declinedCents: declined };
}

// --- Lookups (advisor + customer names) -----------------------------------

// One call, cached for the whole sync: employeeId -> "First Last".
export async function fetchEmployeeNames(shopId) {
  const map = new Map();
  const employees = await getAllPages(`/api/v1/employees?shop=${shopId}`);
  for (const e of employees) {
    map.set(e.id, [e.firstName, e.lastName].filter(Boolean).join(" ").trim());
  }
  return map;
}

// Customer names are fetched by id and cached across syncs by the caller.
export async function fetchCustomerName(customerId) {
  const c = await apiGet(`/api/v1/customers/${customerId}`);
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
}

export function roDeepLink(shopId, roId) {
  const tmpl =
    process.env.TEKMETRIC_RO_URL ||
    "https://shop.tekmetric.com/admin/shop/{shopId}/repair-orders/{roId}/estimate";
  return tmpl.replace("{shopId}", shopId).replace("{roId}", roId);
}
