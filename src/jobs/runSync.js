// CLI entry point. Runs one sync then exits.
//   npm run sync          -> incremental (only ROs changed since last sync)
//   npm run sync -- full   -> full backfill of the whole window (first-time setup)
import "dotenv/config";
import { runSync } from "./sync.js";
import { pool } from "../db/index.js";

const full = process.argv.includes("full") || process.argv.includes("--full");

try {
  // A manual CLI run is deliberate, so bypass the cooldown.
  await runSync({ full, force: true });
} catch (err) {
  console.error("Sync failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
