// PostgreSQL connection pool + tiny query helper.
import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's managed Postgres requires SSL; local dev usually doesn't.
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export const query = (text, params) => pool.query(text, params);
