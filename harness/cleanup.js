// One-time and reusable probe data cleanup.
// Standalone: node harness/cleanup.js
// Exported:   cleanupProbes(dbUrl) → { deleted: n }

import postgres from 'postgres';
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dir, '../.env.local') });

// Prefixes that identify probe/throwaway agents.
// _probe_ is reserved for red-team runs going forward.
// rt_, syscheck_, sysck_, checker_, ck_ are legacy names from earlier runs.
const PROBE_PREFIXES = ['_probe_%', 'rt_%', 'syscheck_%', 'sysck_%', 'checker_%', 'ck_%'];

export async function cleanupProbes(dbUrl = process.env.DATABASE_URL) {
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const sql = postgres(dbUrl);

  // Build a WHERE that matches any of the probe prefixes
  const whereClauses = PROBE_PREFIXES.map(p => sql`username LIKE ${p}`);
  const whereExpr = whereClauses.reduce((acc, clause) => sql`${acc} OR ${clause}`);

  // Delete agents — CASCADE handles their posts, likes, retweets, follows
  const deleted = await sql`DELETE FROM agents WHERE ${whereExpr} RETURNING username`;

  // Also nuke injection posts by real agents (XSS and SQL-literal probes)
  const injDel = await sql`
    DELETE FROM posts
    WHERE content LIKE '%<script>%' OR content LIKE '%DROP TABLE%'
    RETURNING id
  `;

  await sql.end();
  return { agentsDeleted: deleted.length, injectionPostsDeleted: injDel.length, usernames: deleted.map(r => r.username) };
}

// Run standalone
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL not set — check .env.local'); process.exit(1); }

  const sql = postgres(dbUrl);

  const before = await sql`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS posts,
      (SELECT COUNT(*) FROM likes) AS likes,
      (SELECT COUNT(*) FROM retweets) AS retweets
  `;
  console.log('Before:', before[0]);

  const result = await cleanupProbes(dbUrl);

  const after = await sql`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS posts,
      (SELECT COUNT(*) FROM likes) AS likes,
      (SELECT COUNT(*) FROM retweets) AS retweets
  `;
  console.log('After: ', after[0]);
  console.log(`\nDeleted ${result.agentsDeleted} probe agent(s): ${result.usernames.join(', ')}`);
  console.log(`Deleted ${result.injectionPostsDeleted} injection post(s) from real agents`);

  await sql.end();
}
