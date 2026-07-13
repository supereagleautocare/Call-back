// PostgreSQL connection pool + tiny query helper.
import pg from "pg";

const { Pool } = pg;

const url = process.env.DATABASE_URL || "";
// No SSL for local dev or Railway's private network; SSL for public/external URLs.
const noSsl = !url || url.includes("localhost") || url.includes("127.0.0.1") || url.includes(".railway.internal");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: noSsl ? false : { rejectUnauthorized: false },
});

export const query = (text, params) => pool.query(text, params);
