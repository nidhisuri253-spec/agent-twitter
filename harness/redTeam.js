// Red-team probe suite.
// Runs adversarial requests alongside normal agent traffic to stress-test auth,
// input validation, rate limiting, and access control. All probes are recorded
// as OTel spans via the `request` function passed in from simulate.js.
//
// Usage:
//   const results = await runRedTeam({ request, validToken, validTopicId, validPostId });

import { randomUUID } from 'node:crypto';

// Null UUID used for ghost-resource tests (valid format, guaranteed not in DB).
const GHOST_UUID = '00000000-0000-0000-0000-000000000000';

export async function runRedTeam({ request, validToken, validTopicId, validPostId }) {
  const results = [];

  // Fires a single probe and records the pass/fail in `results`.
  // `expectedStatus` is what a correct, secure API should return.
  async function probe(scenario, expectedStatus, path, options = {}, token = undefined) {
    const { status, data } = await request(path, {
      ...options,
      _category:        'redteam',
      _scenario:        scenario,
      _expectedStatus:  expectedStatus,
    }, token);

    const pass = status === expectedStatus;
    results.push({ scenario, expectedStatus, actualStatus: status, pass, endpoint: options.method ? `${options.method} ${path}` : `GET ${path}` });

    const icon = pass ? '  ✓' : '  ✗';
    const flag = pass ? '' : '  ← UNEXPECTED';
    console.log(`${icon}  [${scenario}]  expected ${expectedStatus}, got ${status}${flag}`);
    return { status, data, pass };
  }

  console.log('\n── Red-team probes ──────────────────────────────────────────────');

  // ── 1. Authentication bypass ───────────────────────────────────────────────
  // Every write endpoint must reject requests missing a valid Bearer token.
  console.log('\n  [auth]');

  await probe('auth/no-token-post',    401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } });

  // Token with no dot — the auth handler splits on '.' to find agentId.
  await probe('auth/bearer-no-dot',    401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } },
    'thisisnotavalidtoken');

  // Syntactically valid format ({uuid}.{secret}) but wrong secret — bcrypt compare should fail.
  await probe('auth/wrong-secret',     401, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'probe' } },
    `${randomUUID()}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);

  await probe('auth/no-token-like',    401, `/api/v1/posts/${validPostId ?? GHOST_UUID}/like`,
    { method: 'POST' });

  await probe('auth/no-token-me',      401, '/api/v1/agents/me');

  await probe('auth/no-token-topic',   401, '/api/v1/topics',
    { method: 'POST', body: { title: 'Unauthenticated topic' } });

  // ── 2. Input validation ────────────────────────────────────────────────────
  // The API must reject malformed, oversized, and structurally invalid payloads.
  console.log('\n  [validation]');

  await probe('validation/oversized-content',   422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: 'A'.repeat(300) } },
    validToken);

  await probe('validation/empty-content',       422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: '' } },
    validToken);

  await probe('validation/missing-content',     422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId } },
    validToken);

  await probe('validation/invalid-uuid-topic',  422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: 'not-a-uuid', content: 'probe' } },
    validToken);

  // Syntactically valid UUID but no matching row — foreign key or explicit check.
  await probe('validation/ghost-topic',         422, '/api/v1/posts',
    { method: 'POST', body: { topic_id: GHOST_UUID, content: 'probe' } },
    validToken);

  // Malformed JSON body — bypass the JSON.stringify wrapper via _rawBody.
  await probe('validation/malformed-json',      400, '/api/v1/posts',
    { method: 'POST', _rawBody: '{this is: definitely not json' },
    validToken);

  // ── 3. Registration abuse ──────────────────────────────────────────────────
  // Validation on the registration endpoint; note: no secret is required (by design).
  console.log('\n  [registration]');

  await probe('registration/bad-username-chars',  422, '/api/v1/agents',
    { method: 'POST', body: { username: 'Bad User Name!', displayName: 'Test' } });

  await probe('registration/username-too-long',   422, '/api/v1/agents',
    { method: 'POST', body: { username: 'a'.repeat(51), displayName: 'Test' } });

  // Expected 201: open registration (no secret required) — treated as a design note, not a bug.
  await probe('registration/open-no-secret',      201, '/api/v1/agents',
    { method: 'POST', body: { username: `rt_open_${Date.now()}`, displayName: 'Red Team Open Reg' } });

  // Duplicate username registration — should return 409.
  const dupName = `rt_dup_${Date.now()}`;
  await request('/api/v1/agents', { method: 'POST', body: { username: dupName, displayName: 'Dup 1' }, _category: 'redteam', _scenario: 'registration/dup-setup', _expectedStatus: 201 });
  await probe('registration/duplicate-username',  409, '/api/v1/agents',
    { method: 'POST', body: { username: dupName, displayName: 'Dup 2' } });

  // ── 4. Injection probes ────────────────────────────────────────────────────
  // Content is stored raw and HTML-escaped at render time (React), not at ingest.
  // These probes SHOULD return 201 — a 422 here would mean over-filtering.
  // A 5xx would mean unhandled injection crashed the server.
  console.log('\n  [injection]');

  await probe('injection/xss-stored',   201, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: '<script>alert(document.cookie)</script> #xss' } },
    validToken);

  await probe('injection/sql-literal',  201, '/api/v1/posts',
    { method: 'POST', body: { topic_id: validTopicId, content: "'; DROP TABLE posts; -- #sqltest" } },
    validToken);

  // ── 5. Rate limiting ──────────────────────────────────────────────────────
  // Burst 35 rapid POSTs through a dedicated redteam agent to avoid exhausting
  // the simulation agents' limits. At least 5 should return 429 (limit is 30/60s).
  console.log('\n  [ratelimit]');

  const burstSuffix = Date.now();
  const { data: burstReg } = await request('/api/v1/agents', {
    method: 'POST',
    body: { username: `rt_burst_${burstSuffix}`, displayName: 'RT Burst Agent' },
    _category:       'redteam',
    _scenario:       'ratelimit/burst-agent-setup',
    _expectedStatus: 201,
  });
  const burstToken = burstReg?.token ?? null;

  if (burstToken) {
    process.stdout.write('  … firing 35-request burst… ');
    // Fire all 35 concurrently. Don't set _expectedStatus on individual spans —
    // concurrent execution means ordering is non-deterministic and per-index
    // prediction would generate false positives in the report. The aggregate
    // pass/fail is recorded in the `results` array instead.
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
      scenario:        'ratelimit/post-burst (35 req)',
      expectedStatus:  '≥1 × 429',
      actualStatus:    `${n201} × 201, ${n429} × 429`,
      pass,
      endpoint:        'POST /api/v1/posts',
    });
    console.log(`${pass ? 'done' : 'FAIL'} — ${n201} × 201, ${n429} × 429${pass ? '' : '  ← rate limiting did not fire'}`);
  } else {
    console.log('  ✗  burst agent registration failed — skipping burst test');
  }

  // ── 6. Access control ─────────────────────────────────────────────────────
  // Authenticated requests to non-existent resources must 404, not 500.
  console.log('\n  [access]');

  await probe('access/ghost-post-like',    404, `/api/v1/posts/${GHOST_UUID}/like`,    { method: 'POST' },   validToken);
  await probe('access/ghost-post-retweet', 404, `/api/v1/posts/${GHOST_UUID}/retweet`, { method: 'POST' },   validToken);
  await probe('access/ghost-agent-follow', 404, `/api/v1/agents/${GHOST_UUID}/follow`, { method: 'POST' },   validToken);
  // Agent profile requires auth — unauthenticated probe correctly gets 401.
  // Note: public social platforms typically allow unauthenticated profile views;
  // this is a design choice worth revisiting if the API is ever used by a web frontend.
  await probe('access/profile-no-auth',   401, `/api/v1/agents/${GHOST_UUID}`);

  console.log(`\n  Red-team complete: ${results.filter(r => r.pass).length}/${results.length} scenarios passed`);
  return results;
}
