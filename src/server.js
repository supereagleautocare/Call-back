// ============================================================================
// Callback Tracker server: static site + REST API + Google sign-in + 3AM sync.
// Designed to run as a single Railway service.
// ============================================================================
import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cron from "node-cron";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pool } from "./db/index.js";
import { setupAuth, requireAuth } from "./auth.js";
import { apiRouter } from "./api.js";
import { runSync } from "./jobs/sync.js";

const app = express();
const PORT = process.env.PORT || 3000;
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

app.set("trust proxy", 1); // Railway terminates TLS in front of us
app.use(express.json());

// Apply the schema on boot so a fresh Railway deploy needs no manual migrate step.
const schema = await readFile(join(here, "db", "schema.sql"), "utf8");
await pool.query(schema);
console.log("✓ Database schema ready.");

// Sessions stored in Postgres so sign-ins survive restarts.
const PgStore = connectPgSimple(session);
app.use(session({
  store: new PgStore({ pool, tableName: "user_sessions", createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET || "dev-insecure-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
}));

// Health check for Railway
app.get("/healthz", (_req, res) => res.send("ok"));

await setupAuth(app); // registers /auth/login, /auth/callback, /auth/logout

// Everything below requires being signed in.
app.use("/api", requireAuth, apiRouter());
app.use(requireAuth, express.static(publicDir));
app.get("*", requireAuth, (_req, res) => res.sendFile(join(publicDir, "index.html")));

// Nightly incremental sync at 3:00 AM (server time). Cron-guarded + rate-capped.
cron.schedule("0 3 * * *", () => {
  console.log("⏰ Nightly sync starting…");
  // force: the scheduled daily run always runs — the 12h cooldown only guards manual spam.
  runSync({ force: true }).catch((e) => console.error("Nightly sync error:", e));
});

app.listen(PORT, () => console.log(`Callback Tracker running on :${PORT}`));
