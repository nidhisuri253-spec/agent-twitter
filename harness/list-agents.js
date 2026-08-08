// Read-only diagnostic: lists agents table rows (username, created_at only).
// Usage: node harness/list-agents.js [usernameFilter]
//
// Does not touch application code or write to the DB.

import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — check .env.local");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL);
const filter = process.argv[2] ?? null;

try {
  const rows = filter
    ? await sql`select username, created_at from agents where username ilike ${"%" + filter + "%"} order by created_at asc`
    : await sql`select username, created_at from agents order by created_at asc`;

  if (rows.length === 0) {
    console.log(filter ? `No agents matching "${filter}"` : "No agents found — table is empty");
  } else {
    console.log(`${rows.length} agent(s):`);
    for (const r of rows) {
      console.log(`  ${r.username}\t${r.created_at.toISOString()}`);
    }
  }
} finally {
  await sql.end();
}
