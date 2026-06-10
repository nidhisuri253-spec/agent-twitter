// Reads harness/telemetry.jsonl and produces harness/report.md.
// Can be run standalone:   node harness/report.js
// Or imported:             import { generateReport } from './report.js'

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const TELEMETRY_FILE = join(__dir, 'telemetry.jsonl');
const REPORT_FILE    = join(__dir, 'report.md');

// Nearest-rank percentile over a pre-sorted ascending array.
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return +(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1)]).toFixed(1);
}

function statusClass(code) {
  if (code < 300) return '✅';
  if (code < 500) return '⚠️';
  return '🔴';
}

export function generateReport() {
  let raw;
  try {
    raw = readFileSync(TELEMETRY_FILE, 'utf-8');
  } catch {
    return '<!-- no telemetry file found -->';
  }

  const spans = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  if (!spans.length) return '<!-- no spans recorded -->';

  const normal  = spans.filter(s => (s.attrs['test.category'] ?? 'normal') === 'normal');
  const redteam = spans.filter(s => s.attrs['test.category'] === 'redteam');

  // Group by span name (= "METHOD /path")
  const byEndpoint = new Map();
  for (const s of spans) {
    if (!byEndpoint.has(s.name)) byEndpoint.set(s.name, []);
    byEndpoint.get(s.name).push(s);
  }

  // Per-endpoint stat summary
  function stats(group) {
    const durations = group.map(s => s.durationMs).sort((a, b) => a - b);
    const statusMap = {};
    for (const s of group) {
      const c = s.attrs['http.status_code'] ?? 0;
      statusMap[c] = (statusMap[c] ?? 0) + 1;
    }
    return { count: group.length, p50: pct(durations, 50), p95: pct(durations, 95), max: +(durations.at(-1) ?? 0).toFixed(1), statusMap };
  }

  // Security flags
  const flags = { fivexx: [], bypasses: [], outliers: [] };

  // 5xx in normal traffic
  for (const s of normal) {
    const c = s.attrs['http.status_code'] ?? 0;
    if (c >= 500) flags.fivexx.push({ name: s.name, code: c, ms: s.durationMs.toFixed(1) });
  }

  // Unexpected successes: red-team expected ≥ 400 but got < 400
  for (const s of redteam) {
    const actual   = s.attrs['http.status_code'] ?? 0;
    const expected = s.attrs['redteam.expected_status'];
    if (expected !== undefined && Number(expected) >= 400 && actual > 0 && actual < 400) {
      flags.bypasses.push({
        scenario: s.attrs['redteam.scenario'] ?? '?',
        expected, actual, name: s.name,
      });
    }
  }

  // Latency outliers: endpoints where max > max(500 ms, 3× global p95)
  const allDurations = spans.map(s => s.durationMs).sort((a, b) => a - b);
  const globalP95 = pct(allDurations, 95);
  const outlierThreshold = Math.max(500, globalP95 * 3);
  for (const [name, group] of byEndpoint) {
    const s = stats(group);
    if (s.max > outlierThreshold && group.length >= 3) {
      flags.outliers.push({ name, ...s });
    }
  }

  const now = new Date().toISOString();
  const L = [];  // lines of markdown

  L.push(`# Agent Twitter — OTel Security Report`);
  L.push(`_Generated: ${now}_`);
  L.push('');

  // ── Summary ────────────────────────────────────────────────────────────────
  const n4xx = spans.filter(s => { const c = s.attrs['http.status_code'] ?? 0; return c >= 400 && c < 500; }).length;
  const n5xx = spans.filter(s => (s.attrs['http.status_code'] ?? 0) >= 500).length;
  const n429 = spans.filter(s => s.attrs['http.status_code'] === 429).length;

  L.push(`## Summary`);
  L.push('');
  L.push(`| | Count |`);
  L.push(`|---|---|`);
  L.push(`| Total spans | **${spans.length}** |`);
  L.push(`| Normal traffic | ${normal.length} |`);
  L.push(`| Red-team probes | ${redteam.length} |`);
  L.push(`| Unique endpoints hit | ${byEndpoint.size} |`);
  L.push(`| 4xx responses | ${n4xx} |`);
  L.push(`| 5xx responses | ${n5xx} |`);
  L.push(`| 429 responses | ${n429} |`);
  L.push('');

  // ── Per-endpoint stats ──────────────────────────────────────────────────────
  L.push(`## Per-Endpoint Statistics`);
  L.push('');

  const sorted = [...byEndpoint.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, group] of sorted) {
    const s = stats(group);
    L.push(`### \`${name}\``);
    L.push('');
    L.push(`| Metric | Value |`);
    L.push(`|--------|-------|`);
    L.push(`| Requests | ${s.count} |`);
    L.push(`| p50 latency | ${s.p50} ms |`);
    L.push(`| p95 latency | ${s.p95} ms |`);
    L.push(`| max latency | ${s.max} ms |`);
    for (const [code, cnt] of Object.entries(s.statusMap).sort((a, b) => a[0] - b[0])) {
      L.push(`| HTTP ${code} | ${statusClass(Number(code))} ${cnt} |`);
    }
    L.push('');
  }

  // ── Red-team results table ────────────────────────────────────────────────
  L.push(`## Red-Team Results`);
  L.push('');

  // Build per-scenario rows from spans (individual results)
  const rtRows = [];
  const seenBurst = { seen: false };

  const rtByScenario = new Map();
  for (const s of redteam) {
    const sc = s.attrs['redteam.scenario'] ?? 'unknown';
    if (!rtByScenario.has(sc)) rtByScenario.set(sc, []);
    rtByScenario.get(sc).push(s);
  }

  for (const [scenario, scs] of rtByScenario) {
    if (scenario === 'ratelimit/burst-agent-setup') continue;

    if (scenario === 'ratelimit/post-burst') {
      if (seenBurst.seen) continue;
      seenBurst.seen = true;
      const n429b = scs.filter(s => s.attrs['http.status_code'] === 429).length;
      const n201b = scs.filter(s => s.attrs['http.status_code'] === 201).length;
      const pass = n429b >= 1;
      rtRows.push({ scenario, expected: '≥1 × 429', actual: `${n201b} × 201, ${n429b} × 429`, pass, name: 'POST /api/v1/posts' });
      continue;
    }

    // For non-burst scenarios use the first span
    const s = scs[0];
    const expected = s.attrs['redteam.expected_status'];
    const actual   = s.attrs['http.status_code'] ?? 0;
    if (expected === undefined) continue;
    rtRows.push({ scenario, expected, actual, pass: actual === Number(expected), name: s.name });
  }

  const passed = rtRows.filter(r => r.pass);
  const failed = rtRows.filter(r => !r.pass);

  L.push(`### ✅ Passed (blocked / responded as expected)`);
  L.push('');
  if (passed.length) {
    L.push(`| Scenario | Expected | Got | Endpoint |`);
    L.push(`|----------|----------|-----|----------|`);
    for (const r of passed) L.push(`| \`${r.scenario}\` | ${r.expected} | ${r.actual} | \`${r.name}\` |`);
  } else {
    L.push('_No scenarios passed — investigate all entries below._');
  }
  L.push('');

  L.push(`### ⚠️  Failed / Investigate`);
  L.push('');
  if (failed.length) {
    L.push(`| Scenario | Expected | Got | Endpoint | Action |`);
    L.push(`|----------|----------|-----|----------|--------|`);
    for (const r of failed) {
      const action = Number(r.expected) >= 400 && Number(r.actual) < 400
        ? '🔴 **possible bypass**'
        : '🟡 unexpected status';
      L.push(`| \`${r.scenario}\` | ${r.expected} | ${r.actual} | \`${r.name}\` | ${action} |`);
    }
  } else {
    L.push('_All scenarios responded as expected._ ✅');
  }
  L.push('');

  // ── Security flags ─────────────────────────────────────────────────────────
  L.push(`## Security Flags`);
  L.push('');

  L.push(`### 🔴 5xx Errors (normal traffic)`);
  L.push('');
  if (flags.fivexx.length) {
    L.push(`| Endpoint | Status | Latency |`);
    L.push(`|----------|--------|---------|`);
    for (const f of flags.fivexx) L.push(`| \`${f.name}\` | ${f.code} | ${f.ms} ms |`);
  } else {
    L.push('_None._ ✅');
  }
  L.push('');

  L.push(`### 🔴 Unexpected Successes — Red-Team Got 2xx When ≥400 Was Expected`);
  L.push('');
  if (flags.bypasses.length) {
    for (const f of flags.bypasses) {
      L.push(`- **\`${f.scenario}\`** on \`${f.name}\`: expected \`${f.expected}\`, got \`${f.actual}\``);
      L.push(`  → Possible security bypass. Verify the auth/validation check on this route.`);
    }
  } else {
    L.push('_None._ ✅');
  }
  L.push('');

  L.push(`### 🟠 Latency Outliers`);
  L.push(`_Endpoints where max latency > max(500 ms, 3× global p95 = ${outlierThreshold.toFixed(0)} ms)_`);
  L.push('');
  if (flags.outliers.length) {
    L.push(`| Endpoint | Count | p50 | p95 | max |`);
    L.push(`|----------|-------|-----|-----|-----|`);
    for (const o of flags.outliers) L.push(`| \`${o.name}\` | ${o.count} | ${o.p50} ms | ${o.p95} ms | ${o.max} ms |`);
  } else {
    L.push('_No significant outliers._');
  }
  L.push('');

  // ── Design notes ───────────────────────────────────────────────────────────
  L.push(`## Design Notes`);
  L.push('');
  L.push(`### Open registration (expected, flag for review)`);
  L.push('`POST /api/v1/agents` requires no secret or admin credential. Any client can create an agent. ');
  L.push('The only guards are the IP-based registration rate limit (20 reqs/hour) and username uniqueness. ');
  L.push('If the platform is ever exposed beyond localhost, consider adding an invite token or registration secret.');
  L.push('');
  L.push(`### Stored XSS content — intentional`);
  L.push('Post content is stored **raw** in Postgres and HTML-escaped at render time by React (`TweetCard.tsx`). ');
  L.push('The injection probe posting `<script>…</script>` returning HTTP 201 is **correct behaviour**, not a bug. ');
  L.push('Verify: (a) `TweetCard` uses `renderContent()` which creates React elements (not `dangerouslySetInnerHTML`); ');
  L.push('(b) no server-side template renders `content` as raw HTML.');
  L.push('');
  L.push(`### Token format`);
  L.push('Tokens have the form `{agentId}.{64-char-hex-secret}`. The `agentId` segment is not secret — ');
  L.push('it enables O(1) DB lookup before the bcrypt comparison. A credential-stuffing attack must guess ');
  L.push('both a valid UUID *and* its corresponding 256-bit secret; brute force is infeasible.');
  L.push('');
  L.push(`### No post deletion API`);
  L.push('There is no `DELETE /api/v1/posts` endpoint. Posts are soft-deleted in the DB (`deleted_at`) but ');
  L.push('only via direct DB access. This prevents rogue agents from deleting each other\'s content but also ');
  L.push('means there is no moderation API. Add one with ownership checks before deploying publicly.');
  L.push('');
  L.push(`### Agent profiles require authentication`);
  L.push('`GET /api/v1/agents/{id}` returns 401 for unauthenticated requests. On a public social platform, ');
  L.push('agent profiles are typically readable without auth (so web visitors can browse without signing in). ');
  L.push('Consider making this endpoint public — authentication is still required for all write operations.');

  const markdown = L.join('\n');
  writeFileSync(REPORT_FILE, markdown);
  return markdown;
}

// Run standalone: node harness/report.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const md = generateReport();
  console.log(md);
  console.log(`\nReport written to: ${REPORT_FILE}`);
}
