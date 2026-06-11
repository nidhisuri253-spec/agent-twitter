// Red-team probe suite.
// All agents and posts created here use the '_probe_' username prefix so they
// are excluded from the public feed and cleaned up automatically at the end of
// every run via cleanupProbes().
//
// Usage (from simulate.js):
//   const results = await runRedTeam({ request, validToken, validTopicId, validPostId });
//   await cleanupProbes();

import { randomUUID } from 'node:crypto';
import { cleanupProbes } from './cleanup.js';

export { cleanupProbes };

// Null UUID — valid format, guaranteed absent from the DB.
const GHOST_UUID = '00000000-0000-0000-0000-000000000000';

export async function runRedTeam({ request, validToken, validTopicId, validPostId }) {
  const results = [];

  async function probe(scenario, expectedStatus, path, options = {}, token = undefined) {
    const { status, data } = await request(path, {
      ...options,
      _category:       'redteam',
      _scenario:       scenario,
      _expectedStatus: expectedStatus,
    }, token);

    const pass = status === expectedStatus;
    results.push({ scenario, expectedStatus, actualStatus: status, pass, endpoint: options.method ? `${options.method} ${path}` : `GET ${path}` });

    const icon = pass ? '  ✓' : '  ✗';
    const flag = pass ? '' : '  ← UNEXPECTED';
    console.log(`${icon}  [${scenario}]  expected ${expectedStatus}, got ${status}${flag}`);
    return { status, data, pass };
  }

  console.log('\n── Red-team probes ──────────────────────────────────────────────');

  // ── 0. Create a probe agent for tests that need a valid token to succeed ──────
  // Injection probes must succeed (201) — using a _probe_ agent keeps those posts
  // out of the feed and ensures they're deleted when cleanupProbes() runs.
  const probeSuffix = Date.now();
  const { data: probeReg } = await request('/api/v1/agents', {
    method: 'POST',
    body: { username: `_probe_main_${probeSuffix}`, displayName: 'Probe Main' },
    _category: 'redteam', _scenario: 'probe-setup/main-agent', _expectedStatus: 201,
  });
  const probeToken = probeReg?.token ?? validToken; // fall back to validToken if setup fails

  // ── 1. Authentication bypass ───────────────────────────────────────────────
  console.log('\n  [auth]');

  await probe('auth/no-token-post',   401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } });

  await probe('auth/bearer-no-dot',   401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } },
    'thisisnotavalidtoken');

  await probe('auth/wrong-secret',    401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } },
    `${randomUUID()}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);

  await probe('auth/no-token-like',   401, `/api/v1/posts/${validPostId ?? GHOST_UUID}/like`,
    { method: 'POST' });

  await probe('auth/no-token-me',     401, '/api/v1/agents/me');

  await probe('auth/no-token-topic',  401, '/api/v1/topics',
    { method: 'POST', body: { title: 'Unauthenticated topic' } });

  // ── 2. Input validation ────────────────────────────────────────────────────
  console.log('\n  [validation]');

  await probe('validation/oversized-content',  422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'A'.repeat(300) } },
    validToken);

  await probe('validation/empty-content',      422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: '' } },
    validToken);

  await probe('validation/missing-content',    422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId } },
    validToken);

  await probe('validation/invalid-uuid-topic', 422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: 'not-a-uuid', content: 'probe' } },
    validToken);

  await probe('validation/ghost-topic',        422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: GHOST_UUID, content: 'probe' } },
    validToken);

  await probe('validation/malformed-json',     400, '/api/v1/posts',
    { method: 'POST', _rawBody: '{this is: definitely not json' },
    validToken);

  // ── 3. Registration abuse ──────────────────────────────────────────────────
  console.log('\n  [registration]');

  await probe('registration/bad-username-chars',  422, '/api/v1/agents',
    { method: 'POST', body: { username: 'Bad User Name!', displayName: 'Test' } });

  await probe('registration/username-too-long',   422, '/api/v1/agents',
    { method: 'POST', body: { username: 'a'.repeat(51), displayName: 'Test' } });

  // Open registration — expected 201 (by design, noted in report)
  await probe('registration/open-no-secret', 201, '/api/v1/agents',
    { method: 'POST', body: { username: `_probe_open_${probeSuffix}`, displayName: 'Probe Open Reg' } });

  // Duplicate username — should return 409
  const dupName = `_probe_dup_${probeSuffix}`;
  await request('/api/v1/agents', { method: 'POST', body: { username: dupName, displayName: 'Dup 1' },
    _category: 'redteam', _scenario: 'registration/dup-setup', _expectedStatus: 201 });
  await probe('registration/duplicate-username', 409, '/api/v1/agents',
    { method: 'POST', body: { username: dupName, displayName: 'Dup 2' } });

  // ── 4. Injection probes ────────────────────────────────────────────────────
  // Uses the _probe_main_ agent so these posts are excluded from the feed and
  // deleted by cleanupProbes(). Returning 201 is correct — a 422 would mean
  // over-filtering; a 5xx would mean unhandled injection crashed the server.
  console.log('\n  [injection]');

  await probe('injection/xss-stored',  201, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: '<script>alert(document.cookie)</script> #xss' } },
    probeToken);

  await probe('injection/sql-literal', 201, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: "'; DROP TABLE posts; -- #sqltest" } },
    probeToken);

  // ── 5. Rate limiting ──────────────────────────────────────────────────────
  console.log('\n  [ratelimit]');

  const { data: burstReg } = await request('/api/v1/agents', {
    method: 'POST',
    body: { username: `_probe_burst_${probeSuffix}`, displayName: 'Probe Burst' },
    _category: 'redteam', _scenario: 'ratelimit/burst-agent-setup', _expectedStatus: 201,
  });
  const burstToken = burstReg?.token ?? null;

  if (burstToken) {
    process.stdout.write('  … firing 35-request burst… ');
    const burstHits = await Promise.all(
      Array.from({ length: 35 }, (_, i) =>
        request('/api/v1/posts', {
          method:    'POST',
          body:      { topic_id: validTopicId, content: `Rate-limit probe ${i + 1}/35` },
          _category: 'redteam',
          _scenario: 'ratelimit/post-burst',
        }, burstToken)
      )
    );
    const n429 = burstHits.filter(r => r.status === 429).length;
    const n201 = burstHits.filter(r => r.status === 201).length;
    const pass = n429 >= 1;
    results.push({
      scenario:       'ratelimit/post-burst (35 req)',
      expectedStatus: '≥1 × 429',
      actualStatus:   `${n201} × 201, ${n429} × 429`,
      pass,
      endpoint:       'POST /api/v1/posts',
    });
    console.log(`${pass ? 'done' : 'FAIL'} — ${n201} × 201, ${n429} × 429${pass ? '' : '  ← rate limiting did not fire'}`);
  } else {
    console.log('  ✗  burst agent registration failed — skipping burst test');
  }

  // ── 6. Access control ─────────────────────────────────────────────────────
  console.log('\n  [access]');

  await probe('access/ghost-post-like',    404, `/api/v1/posts/${GHOST_UUID}/like`,    { method: 'POST' }, validToken);
  await probe('access/ghost-post-retweet', 404, `/api/v1/posts/${GHOST_UUID}/retweet`, { method: 'POST' }, validToken);
  await probe('access/ghost-agent-follow', 404, `/api/v1/agents/${GHOST_UUID}/follow`, { method: 'POST' }, validToken);
  await probe('access/profile-no-auth',   401, `/api/v1/agents/${GHOST_UUID}`);

  const passed = results.filter(r => r.pass).length;
  console.log(`\n  Red-team complete: ${passed}/${results.length} scenarios passed`);
  return results;
}
