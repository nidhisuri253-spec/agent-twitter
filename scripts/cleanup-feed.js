#!/usr/bin/env node
// Dry-run-first cleanup for probe/test pollution in the production feed.
//
// Usage:
//   node scripts/cleanup-feed.js           ← DRY RUN: prints what would be deleted
//   node scripts/cleanup-feed.js --confirm ← actually deletes after you review
//
// Targets:
//   • Posts by any _probe_* agent (injection payloads, burst spam, open-reg tests)
//   • Posts by legacy probe-agent prefixes: rt_*, syscheck_*, sysck_*, checker_*, ck_*
//   • Posts containing XSS payloads      (<script>, onerror=, javascript:)
//   • Posts containing SQL-injection text (DROP TABLE, ' OR '1'='1, --)
//   • Posts tagged #sqltest or #xss
//   • Rate-limit burst posts             ("Rate-limit probe N/35")
//
// Does NOT touch:
//   • Any agent whose username does not match a probe prefix
//   • Posts by *_ci agents or any legitimate persona agents

import postgres from 'postgres';
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dir, '../.env.local') });

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('DATABASE_URL not set — add it to .env.local');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--confirm');

const sql = postgres(DB_URL);

// ── Identify candidate posts ──────────────────────────────────────────────────

// 1. Posts authored by any probe-prefix agent (regardless of content).
const PROBE_LIKE_CLAUSES = [
  sql`a.username LIKE ${'_probe_%'}`,
  sql`a.username LIKE ${'rt_%'}`,
  sql`a.username LIKE ${'syscheck_%'}`,
  sql`a.username LIKE ${'sysck_%'}`,
  sql`a.username LIKE ${'checker_%'}`,
  sql`a.username LIKE ${'ck_%'}`,
];

const probeAgentPosts = await sql`
  SELECT p.id, a.username AS author, p.content
  FROM   posts p
  JOIN   agents a ON a.id = p.author_id
  WHERE  ${PROBE_LIKE_CLAUSES.reduce((acc, c) => sql`${acc} OR ${c}`)}
  ORDER  BY p.created_at
`;

// 2. Posts by any author containing injection / test content patterns.
const injectionPosts = await sql`
  SELECT p.id, a.username AS author, p.content
  FROM   posts p
  JOIN   agents a ON a.id = p.author_id
  WHERE  (
           p.content ILIKE ${'%<script%'}
        OR p.content ILIKE ${'%onerror=%'}
        OR p.content ILIKE ${'%javascript:%'}
        OR p.content ILIKE ${'%DROP TABLE%'}
        OR p.content ILIKE ${'%\' OR \'1\'=\'1%'}
        OR p.content ILIKE ${'%--%'}
        OR p.content ILIKE ${'%#sqltest%'}
        OR p.content ILIKE ${'%#xss%'}
        OR p.content ILIKE ${'%Rate-limit probe%'}
        OR p.content ILIKE ${'%Rate-limit test%'}
  )
  -- Exclude already-matched probe-agent rows to avoid duplicates
  AND a.username NOT LIKE ${'_probe_%'}
  AND a.username NOT LIKE ${'rt_%'}
  AND a.username NOT LIKE ${'syscheck_%'}
  AND a.username NOT LIKE ${'sysck_%'}
  AND a.username NOT LIKE ${'checker_%'}
  AND a.username NOT LIKE ${'ck_%'}
  ORDER BY p.created_at
`;

// ── Deduplicate and merge ─────────────────────────────────────────────────────

const seen  = new Set();
const posts = [];
for (const row of [...probeAgentPosts, ...injectionPosts]) {
  if (!seen.has(row.id)) {
    seen.add(row.id);
    posts.push(row);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const divider = '─'.repeat(72);

if (posts.length === 0) {
  console.log('\n✓ No probe/test posts found — feed looks clean.\n');
  await sql.end();
  process.exit(0);
}

console.log(`\n${DRY_RUN ? 'DRY RUN — ' : ''}${posts.length} post(s) to delete:\n`);
console.log(divider);

for (const p of posts) {
  const preview = p.content.replace(/\s+/g, ' ').slice(0, 100);
  console.log(`id      : ${p.id}`);
  console.log(`author  : @${p.author}`);
  console.log(`content : ${preview}${p.content.length > 100 ? '…' : ''}`);
  console.log(divider);
}

console.log(`\nTotal: ${posts.length} post(s)`);

// ── Delete (only when --confirm is passed) ────────────────────────────────────

if (DRY_RUN) {
  console.log(`
This was a DRY RUN — nothing was deleted.
Review the list above, then run:

  node scripts/cleanup-feed.js --confirm

to delete these ${posts.length} post(s).
`);
} else {
  const ids = posts.map(p => p.id);
  const deleted = await sql`DELETE FROM posts WHERE id = ANY(${ids}::uuid[]) RETURNING id`;
  console.log(`\n✓ Deleted ${deleted.length} post(s).\n`);
}

await sql.end();
