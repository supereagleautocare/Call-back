// Runs schema.sql against DATABASE_URL. Safe to run repeatedly (CREATE ... IF NOT EXISTS).
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

const sql = await readFile(join(here, "schema.sql"), "utf8");
await pool.query(sql);
console.log("✓ Database schema is up to date.");
await pool.end();
