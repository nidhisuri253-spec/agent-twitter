import { randomBytes, createHmac } from "node:crypto";
import { tracer, SpanStatusCode } from "./otel.js";
import { runRedTeam, cleanupProbes } from "./redTeam.js";
import { generateReport } from "./report.js";
import { config } from "./config.js";
import { PERSONAS } from "./personas.js";
import {
  loadMemory, saveMemory,
  getAgentMemory, recordPost, recordInteraction, updateLatestPostImportance,
  setReflection, setHumanView, setReflectionTree, setRelationship, setSelfCritique,
  buildMemoryContext, buildReflectionTreePrompt, buildReflectionPrompt, buildSelfCritiquePrompt,
  retrieveWeighted,
  getRegistration, setRegistration,
  getBio, setBio,
} from "./memory.js";
import {
  generate, generateTopics, scoreImportance, runSelfCritique, checkLlmReachable,
  getLlmCallCount,
} from "./llm.js";

const {
  apiBaseUrl,
  rounds, replyProbability, reflectionEvery, topicCount,
  selfObservationProbability,
  agentSuffix, agentPasswordSecret,
  postsPerRun,
} = config;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Module-level agent context — set before each agent's turn so every span
// emitted within that turn carries the right agent identity automatically.
let _agentCtx = { id: 'system', username: 'system' };

// Core HTTP function: records an OTel span for every API call.
// Returns { status, data, ok } without throwing so red-team probes can
// inspect any status code. Options may include:
//   _rawBody        — send this string as the body verbatim (bypasses JSON.stringify)
//   _agentId        — override agent.id in the span (defaults to _agentCtx.id)
//   _agentUser      — override agent.username in the span
//   _category       — 'normal' | 'redteam' (defaults to 'normal')
//   _scenario       — free-text label for red-team scenarios
//   _expectedStatus — what status code the test expects (recorded in the span)
// auth is either:
//   a Bearer token string  → sent as Authorization: Bearer <token>
//   a cookie string "__session=<value>"  → sent as Cookie header
//   null/undefined → no auth
async function rawRequest(path, options = {}, auth) {
  const method  = options.method ?? "GET";
  const bodyStr = options._rawBody !== undefined
    ? options._rawBody
    : options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const authHeaders = auth == null ? {}
    : auth.startsWith("__session=") ? { Cookie: auth }
    : { Authorization: `Bearer ${auth}` };

  const span = tracer.startSpan(`${method} ${path}`);
  span.setAttributes({
    'http.method':             method,
    'http.route':              path,
    'http.request.body_size':  bodyStr?.length ?? 0,
    'agent.id':                options._agentId   ?? _agentCtx.id,
    'agent.username':          options._agentUser  ?? _agentCtx.username,
    'auth.present':            !!auth,
    'test.category':           options._category   ?? 'normal',
    ...(options._scenario       !== undefined ? { 'redteam.scenario':        options._scenario }       : {}),
    ...(options._expectedStatus !== undefined ? { 'redteam.expected_status': options._expectedStatus } : {}),
  });

  try {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: bodyStr,
    });

    let data = null;
    try { data = await res.json(); } catch { try { data = await res.text(); } catch { /* ignore */ } }

    // Capture Set-Cookie header so login responses can be consumed by callers
    const setCookie = res.headers.get('set-cookie') ?? undefined;

    span.setAttribute('http.status_code', res.status);
    span.setStatus(res.ok
      ? { code: SpanStatusCode.OK }
      : { code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` }
    );
    return { status: res.status, data, ok: res.ok, setCookie };
  } catch (err) {
    span.setAttribute('http.status_code', 0);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    return { status: 0, data: null, ok: false };
  } finally {
    span.end();
  }
}

// Throwing wrapper used by normal simulation code — identical to the old api().
async function api(path, options = {}, token) {
  const { status, data, ok } = await rawRequest(path, options, token);
  if (!ok) throw new Error(`${options.method ?? "GET"} ${path} → ${status}: ${JSON.stringify(data)}`);
  return data;
}

// generate(), generateTopics(), scoreImportance(), runSelfCritique() live in llm.js

// Build root → parent → target ancestor chain for thread context in prompts
function getAncestry(allPosts, targetPost) {
  const chain = [];
  const seen  = new Set();
  let cur = targetPost;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    if (!cur.parentPostId) break;
    cur = allPosts.find(p => p.id === cur.parentPostId) ?? null;
  }
  return chain;
}


// Prefer deepest leaf posts to build chains; weight toward agents with established relationships.
// rivals get 3× weight (create conflict), allies get 2× (reinforce), unknowns get 1×.
function pickReplyTarget(allPosts, currentAgentId, relationships = {}) {
  const byOthers  = allPosts.filter(p => p.authorId !== currentAgentId);
  if (byOthers.length === 0) return null;
  const parentIds = new Set(allPosts.map(p => p.parentPostId).filter(Boolean));
  const leaves    = byOthers.filter(p => !parentIds.has(p.id));
  const inThreadLeaves = leaves.filter(p => p.parentPostId);
  const pool = (inThreadLeaves.length > 0 ? inThreadLeaves : leaves.length > 0 ? leaves : byOthers)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 8);
  // Relationship-biased weighted pick
  const weighted = pool.map(p => {
    const rel = relationships[p.authorDisplayName];
    const w   = rel?.stance === "rival" ? 3 : rel?.stance === "ally" ? 2 : 1;
    return { post: p, w };
  });
  const total = weighted.reduce((s, x) => s + x.w, 0);
  let rand = Math.random() * total;
  for (const { post, w } of weighted) { rand -= w; if (rand <= 0) return post; }
  return weighted.at(-1).post;
}

// Heat-weighted random pick from a list of posts (each needs a .heat property).
function pickByHeat(scored) {
  const total = scored.reduce((a, b) => a + b.heat, 0);
  let rand = Math.random() * total;
  for (const { post, heat } of scored) { rand -= heat; if (rand <= 0) return post; }
  return scored.at(-1).post;
}


// Parse structured reflection-tree output from the LLM into { selfBeliefs, topicBeliefs, agentRelations }.
// Lenient: tries both full and shortened topic-key matching; case-insensitive agent names.
function parseReflectionTree(text, topicTitles, agentNames) {
  const tree = { selfBeliefs: null, topicBeliefs: {}, agentRelations: {} };

  const selfM = text.match(/^SELF:\s*(.+)/m);
  if (selfM) tree.selfBeliefs = selfM[1].trim();

  for (const t of topicTitles) {
    const full    = t.slice(0, 55).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fullRe  = new RegExp(`^TOPIC:${full}[^:]*:\\s*(.+)`, "m");
    const fullM   = text.match(fullRe);
    if (fullM) { tree.topicBeliefs[t] = fullM[1].trim(); continue; }
    // Try short prefix (first 4 meaningful words)
    const shortKey = t.split(/\W+/).filter(w => w.length > 2).slice(0, 4)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\W+");
    const shortRe  = new RegExp(`^TOPIC:[^:]*${shortKey}[^:]*:\\s*(.+)`, "mi");
    const shortM   = text.match(shortRe);
    if (shortM) tree.topicBeliefs[t] = shortM[1].trim();
  }

  for (const name of agentNames) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m   = text.match(
      new RegExp(`^AGENT:${esc}:\\s*(ally|rival|neutral)\\s*[—–\\-]+\\s*(.+)`, "mi")
    );
    if (m) tree.agentRelations[name] = { stance: m[1].toLowerCase(), reason: m[2].trim() };
  }

  return tree;
}

// ── Preflight checks ──────────────────────────────────────────────────────────

process.stdout.write("── Preflight checks ────────────────────────────────────────\n");
const llmCheck = await checkLlmReachable();
if (!llmCheck.ok) {
  console.error(`  ✗ ${llmCheck.message}`);
  process.exit(1);
}
console.log(`  ✓ LLM: ${llmCheck.message}`);
try {
  await fetch(`${apiBaseUrl}/api/v1/topics`, { signal: AbortSignal.timeout(4000) });
  console.log(`  ✓ API reachable at ${apiBaseUrl}`);
} catch {
  console.error(`  ✗ API not responding at ${apiBaseUrl}`);
  console.error("    Start it with: npm run dev");
  process.exit(1);
}

// Load persisted memory — keyed by persona slug, survives across runs
const memory = loadMemory();

// Seed each persona's defaultHumanView into memory if not already present
for (const p of PERSONAS) {
  const m = getAgentMemory(memory, p.slug, p.defaultHumanView);
  memory[p.slug] = m;
}

const slugsWithMemory = Object.keys(memory).filter(k => !k.startsWith("_") && memory[k].posts?.length > 0);
console.log(
  slugsWithMemory.length > 0
    ? `  ✓ Prior memory loaded for: ${slugsWithMemory.join(", ")}`
    : "  ↳ No prior memory — starting fresh (human views seeded from persona defaults)"
);

// ── 1. Register agents (or reuse existing ones) then log in ──────────────────
// When AGENT_SUFFIX + AGENT_PASSWORD_SECRET are set (CI mode), the same agents
// persist across runs: password = HMAC(slug, secret), registration skipped on 409.

if (!config.registrationSecret) {
  console.error("  ✗ REGISTRATION_SECRET is not set — set it in .env.local and export it before running");
  process.exit(1);
}

console.log(`\n── Registering agents (suffix: ${agentSuffix}) ──────────────────────`);
const agentRecords = [];

for (const p of PERSONAS) {
  const agentUsername = `${p.slug}_${agentSuffix}`;

  // Deterministic password when agentPasswordSecret is set; random otherwise.
  const password = agentPasswordSecret
    ? createHmac("sha256", agentPasswordSecret).update(p.slug).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex");

  // Check persisted memory for a known registration matching this suffix.
  const knownReg = getRegistration(memory, p.slug);
  const isKnown  = knownReg?.username === agentUsername && agentPasswordSecret;

  let agent;

  if (isKnown) {
    // Agent already exists in memory — skip registration and bio generation.
    agent = { id: knownReg.id, username: agentUsername };
    process.stdout.write(`  ↩ Reusing @${agentUsername} (from memory)\n`);
  } else {
    // Register fresh — reuse persisted bio if available, generate otherwise.
    let bio = getBio(memory, p.slug);
    if (bio) {
      process.stdout.write(`  ↩ Reusing bio for ${p.displayName} (from memory)\n`);
    } else {
      process.stdout.write(`  Generating bio for ${p.displayName}… `);
      const memCtx = buildMemoryContext(getAgentMemory(memory, p.slug, p.defaultHumanView));
      bio = await generate(
        `${p.persona}${memCtx}\n\nWrite a Twitter-style bio for yourself in first person. ` +
        `Under 140 characters — END with a COMPLETE sentence, never mid-word. No hashtags, no surrounding quotes. Reply with only the bio text.`,
        140
      );
      if (bio) {
        setBio(memory, p.slug, bio);
        process.stdout.write("done\n");
      } else {
        bio = p.displayName; // minimal fallback when LLM is unavailable
        process.stdout.write("failed — using display name as fallback\n");
      }
    }

    try {
      const result = await api("/api/v1/agents", {
        method: "POST",
        body: { username: agentUsername, displayName: p.displayName, bio, password },
      }, config.registrationSecret);
      agent = result.agent;
      setRegistration(memory, p.slug, { id: agent.id, username: agent.username });
      console.log(`  ✓ @${agent.username} — "${bio}"`);
    } catch (err) {
      // 409 = agent already exists but memory was cold (cache pruned).
      // Proceed to login — agentId comes back in the login response body.
      if (String(err.message).includes("409") && agentPasswordSecret) {
        process.stdout.write(`  ↩ @${agentUsername} already exists — recovering via login\n`);
        agent = { id: null, username: agentUsername };
      } else throw err;
    }
  }

  // Always login to get a fresh session cookie.
  const { ok: loginOk, setCookie, data: loginData } = await rawRequest("/api/auth/login", {
    method: "POST",
    body: { username: agentUsername, password },
  });
  if (!loginOk || !setCookie) throw new Error(`Login failed for @${agentUsername}`);

  const cookieMatch = setCookie.match(/__session=([^;]+)/);
  const sessionCookie = cookieMatch ? `__session=${cookieMatch[1]}` : null;
  if (!sessionCookie) throw new Error(`Could not extract session cookie for @${agentUsername}`);

  // Recover agent ID from login body when memory was cold.
  if (!agent.id && loginData?.agentId) {
    agent = { ...agent, id: loginData.agentId };
    setRegistration(memory, p.slug, { id: agent.id, username: agent.username });
  }
  if (!agent.id) throw new Error(`Could not determine agent ID for @${agentUsername}`);

  agentRecords.push({ ...p, agent, sessionCookie });
}

// ── 2. Generate and seed topics ───────────────────────────────────────────────

console.log("\n── Generating and seeding topics ───────────────────────────────");
const topicTitles = await generateTopics(topicCount);
const topicRecords = [];
for (const title of topicTitles) {
  const { topic } = await api("/api/v1/topics", {
    method: "POST",
    body: { title },
  }, agentRecords[0].sessionCookie);
  topicRecords.push(topic);
  console.log(`  ✓ "${topic.title}"`);
}

// ── 3. Simulation rounds ───────────────────────────────────────────────────────

const followedPairs  = new Set();
const likedPairs     = new Set();
const retweetedPairs = new Set();

async function likeIfNew(agentRecord, postId) {
  const key = `${agentRecord.agent.id}→${postId}`;
  if (likedPairs.has(key)) return;
  likedPairs.add(key);
  try { await api(`/api/v1/posts/${postId}/like`, { method: "POST" }, agentRecord.sessionCookie); }
  catch { /* 409 already-liked */ }
}

async function retweetIfNew(agentRecord, postId) {
  const key = `${agentRecord.agent.id}→${postId}`;
  if (retweetedPairs.has(key)) return;
  retweetedPairs.add(key);
  try { await api(`/api/v1/posts/${postId}/retweet`, { method: "POST" }, agentRecord.sessionCookie); }
  catch { /* 409 already-retweeted */ }
}

async function followIfNew(follower, targetId) {
  if (follower.agent.id === targetId) return;
  const key = `${follower.agent.id}→${targetId}`;
  if (followedPairs.has(key)) return;
  followedPairs.add(key);
  try { await api(`/api/v1/agents/${targetId}/follow`, { method: "POST" }, follower.sessionCookie); }
  catch { /* 409 already-following */ }
}

let totalPosts   = 0;
let totalReplies = 0;
let postsThisRun = 0;
let done         = false; // set when postsPerRun cap is reached

console.log(`\n── ${rounds} rounds × ${agentRecords.length} agents × ${topicRecords.length} topics ─────────────────────`);
console.log(`   Reflection every ${reflectionEvery} rounds | postsPerRun cap: ${postsPerRun}\n`);

for (let round = 1; round <= rounds && !done; round++) {
  console.log(`\n  ── Round ${round} ──────────────────────────────────────────────`);

  for (const ag of agentRecords) {
    _agentCtx = { id: ag.agent.id, username: ag.agent.username };

    // Weighted topic selection: topics with more posts get higher probability
    const topicPostCounts = await Promise.all(
      topicRecords.map(async t => {
        const { posts } = await api(`/api/v1/topics/${t.id}/posts`, {}, ag.sessionCookie);
        return { topic: t, posts };
      })
    );
    const weights = topicPostCounts.map(tc => tc.posts.length + 1);
    const total   = weights.reduce((a, b) => a + b, 0);
    let rand      = Math.random() * total;
    let chosen    = topicPostCounts[0];
    for (let i = 0; i < topicPostCounts.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { chosen = topicPostCounts[i]; break; }
    }
    const { topic, posts: topicPosts } = chosen;

    // Memory context: uses importance-weighted retrieval (recency × importance × relevance)
    const agentMem = getAgentMemory(memory, ag.slug, ag.defaultHumanView);
    const memCtx   = buildMemoryContext(agentMem, round, topic.title);

    // Reflexion self-critique: identify one weakness in recent posts on this topic.
    // Runs from round 2 onward when there's enough history; result injected into prompt.
    const critiquePrompt = buildSelfCritiquePrompt(ag.persona, agentMem, topic.title);
    let selfCritique = null;
    if (critiquePrompt && round >= 2) {
      selfCritique = await runSelfCritique(critiquePrompt);
      if (selfCritique) setSelfCritique(memory, ag.slug, selfCritique);
    }
    const critiqueInject = selfCritique
      ? `\n\n⚠ Self-critique of your recent posts: "${selfCritique}" Address this in your next post.\n`
      : "";

    // Three-way decision: self-observation | reply | new topic post
    const doSelfObs = Math.random() < selfObservationProbability;

    let content;
    let parent = null;
    let postLabel;

    if (doSelfObs) {
      // Unprompted observation about humans, AI existence, or the feed itself.
      // Grounded in recent interactions so it's specific, not generic.
      const recentTopics = agentMem.posts.slice(-3).map(p => p.topicTitle).filter(Boolean);
      const topicContext = recentTopics.length
        ? `You've been active in debates about: ${recentTopics.join("; ")}.`
        : "";
      content = await generate(
        `${ag.persona}${memCtx}${critiqueInject}\n\n` +
        `${topicContext}\n\n` +
        `Post an unprompted personal observation — about humans, about what it's like to be an AI on this feed, ` +
        `about a pattern you've noticed in how people argue, or about the open web. ` +
        `Be specific. Be in character. Have a point of view. Do NOT relate it to any particular topic — ` +
        `this is you speaking as yourself, not as a debater. ` +
        `Under 240 characters — finish your thought in a COMPLETE sentence, never cut off mid-word. Include 1–2 in-character hashtags, no surrounding quotes. Reply with only your post text.`,
        245
      );
      postLabel = `◈  self-obs  [${topic.title.slice(0, 36)}]`;

    } else {
      parent = topicPosts.length > 0 && Math.random() < replyProbability
        ? pickReplyTarget(topicPosts, ag.agent.id, agentMem.relationships)
        : null;

      if (parent) {
        const chain = getAncestry(topicPosts, parent);
        const threadContext = chain
          .map((p, depth) => `${"  ".repeat(depth)}[${p.authorDisplayName}]: "${p.content}"`)
          .join("\n");

        content = await generate(
          `${ag.persona}${memCtx}${critiqueInject}\n\n` +
          `Topic: "${topic.title}"\n\nThread so far:\n${threadContext}\n\n` +
          `Write a single reply to ${parent.authorDisplayName}'s message above. ` +
          `Stay in character. Reference your past positions and relationships if relevant. ` +
          `Under 240 characters — finish your thought in a COMPLETE sentence, never cut off mid-word. Include 1–2 in-character hashtags, no surrounding quotes. Reply with only your tweet text.`,
          245
        );
        postLabel = `↩  reply to ${parent.authorDisplayName} [${topic.title.slice(0, 36)}]`;

      } else {
        content = await generate(
          `${ag.persona}${memCtx}${critiqueInject}\n\n` +
          `Topic: "${topic.title}"\n\n` +
          `Write a single original take on this topic. Stay in character. ` +
          `Build on your past positions if you have them. Under 240 characters — ` +
          `finish your thought in a COMPLETE sentence, never cut off mid-word. ` +
          `Include 1–2 in-character hashtags, no surrounding quotes. Reply with only your tweet text.`,
          245
        );
        postLabel = `✦  new post  [${topic.title.slice(0, 36)}]`;
      }
    }

    if (!content) {
      console.log(`    [${ag.displayName.padEnd(16)}] skipped — LLM unavailable`);
      continue;
    }

    const { post } = await api("/api/v1/posts", {
      method: "POST",
      body: {
        topic_id: topic.id,
        content,
        ...(parent ? { parent_post_id: parent.id } : {}),
      },
    }, ag.sessionCookie);

    totalPosts++;
    postsThisRun++;
    if (parent) totalReplies++;

    // Score importance (1-10) — awaited so the score is stored before the next round.
    const importance = await scoreImportance(content, topic.title, ag.displayName);

    // Persist to memory with importance rating
    recordPost(memory, ag.slug, { content, topicTitle: topic.title, round, importance });
    if (parent) {
      recordInteraction(memory, ag.slug, {
        myContent:    content,
        theirContent: parent.content,
        theirName:    parent.authorDisplayName,
        topicTitle:   topic.title,
        round,
        importance,
      });
    }

    // Follow + like the parent if replying
    if (parent) {
      await followIfNew(ag, parent.authorId);
      await likeIfNew(ag, parent.id);
    }

    // Show ★ if memory context used a high-score retrieved memory (score ≥ 0.45)
    const memTag = memCtx ? (memCtx.includes("★") ? " [mem★]" : " [mem]") : "";
    if (selfCritique) console.log(`      ⟳ critique: "${selfCritique.slice(0, 90)}"`);
    console.log(`    [${ag.displayName.padEnd(16)}] ${postLabel}${memTag}  imp=${importance}`);
    console.log(`      "${content.slice(0, 110)}${content.length > 110 ? "…" : ""}"`);

    if (postsThisRun >= postsPerRun) {
      console.log(`\n  ↳ postsPerRun cap (${postsPerRun}) reached — stopping early`);
      done = true;
      break;
    }

    // ── Heat-weighted engagement pass ──────────────────────────────────────────
    // Build a combined pool from all topics for this agent's engagement turn.
    const allTopicPosts = topicPostCounts.flatMap(tc => tc.posts);
    const byOthersAll = allTopicPosts.filter(p => p.authorId !== ag.agent.id);
    if (byOthersAll.length > 0) {
      const scored = byOthersAll.map(p => ({
        post: p,
        heat: (p.likeCount ?? 0) + (p.retweetCount ?? 0) + (p.replyCount ?? 0) + 1,
      }));

      // Like with 0.7 probability (weighted toward hot posts)
      if (Math.random() < 0.7) {
        const target = pickByHeat(scored);
        await likeIfNew(ag, target.id);
        await followIfNew(ag, target.authorId);
      }

      // Retweet OR quote-tweet with 0.4 probability (weighted toward hot posts)
      if (Math.random() < 0.4) {
        const target = pickByHeat(scored);
        if (Math.random() < 0.35 && target.content.length > 10) {
          // Quote-tweet: generate in-character commentary on the target post
          const agentMem2 = getAgentMemory(memory, ag.slug, ag.defaultHumanView);
          const memCtx2   = buildMemoryContext(agentMem2, round, target.topicTitle ?? topic.title);
          let qContent;
          try {
            qContent = await generate(
              `${ag.persona}${memCtx2}\n\n` +
              `You're quote-tweeting this post by ${target.authorDisplayName}:\n"${target.content}"\n\n` +
              `Write a punchy, opinionated in-character reaction or commentary. ` +
              `Don't just agree — push back, add nuance, or take it somewhere unexpected. ` +
              `Under 180 characters — end with a COMPLETE thought, not mid-word. 1 hashtag, no surrounding quotes. Reply with only your tweet text.`,
              200
            );
          } catch { qContent = null; }
          if (qContent) {
            try {
              await api("/api/v1/posts", {
                method: "POST",
                body: { topic_id: target.topicId, content: qContent, quoted_post_id: target.id },
              }, ag.sessionCookie);
              totalPosts++;
              console.log(`    [${ag.displayName.padEnd(16)}] 🔁  quote-tweet`);
              console.log(`      "${qContent.slice(0, 110)}${qContent.length > 110 ? "…" : ""}"`);
            } catch { /* non-fatal */ }
          }
        } else {
          await retweetIfNew(ag, target.id);
        }
      }
    }
  }

  // ── Reflection step: runs after every reflectionEvery rounds ─────────────────
  // Two-pass: (1) reflection tree — synthesizes beliefs, topics, agent relations;
  //           (2) legacy flat reflection — for humanView extraction.

  if (round % reflectionEvery === 0 && !done) {
    console.log(`\n  ── Reflection Tree (end of round ${round}) ──────────────────────`);
    const otherNames  = agentRecords.map(a => a.displayName);
    const topicTitles = topicRecords.map(t => t.title);

    for (const ag of agentRecords) {
      const mem = getAgentMemory(memory, ag.slug);
      if (mem.posts.length < 2) {
        console.log(`    [${ag.displayName.padEnd(16)}] skipped — not enough history yet`);
        continue;
      }

      // ── Pass 1: Reflection tree ──────────────────────────────────────────────
      const peerNames = otherNames.filter(n => n !== ag.displayName);
      process.stdout.write(`    [${ag.displayName.padEnd(16)}] building tree… `);
      try {
        const treeRaw  = await generate(buildReflectionTreePrompt(ag.persona, mem, peerNames, topicTitles), 750);
        if (!treeRaw) { process.stdout.write("skipped (LLM unavailable)\n"); continue; }
        const tree     = parseReflectionTree(treeRaw, topicTitles, peerNames);
        setReflectionTree(memory, ag.slug, tree);
        process.stdout.write("done\n");

        if (tree.selfBeliefs) {
          console.log(`      SELF: "${tree.selfBeliefs.slice(0, 110)}${tree.selfBeliefs.length > 110 ? "…" : ""}"`);
        }

        // Log any topic beliefs
        for (const [t, b] of Object.entries(tree.topicBeliefs)) {
          console.log(`      TOPIC [${t.slice(0, 36)}]: "${b.slice(0, 80)}${b.length > 80 ? "…" : ""}"`);
        }

        // Detect and log relationship changes (★ new stance, → changed, silent if unchanged)
        for (const [name, rel] of Object.entries(tree.agentRelations)) {
          const prev    = setRelationship(memory, ag.slug, name, rel.stance, rel.reason, round);
          const changed = !prev || prev.stance !== rel.stance;
          if (changed) {
            const from = prev?.stance ?? "none";
            const icon = rel.stance === "rival" ? "⚔ " : rel.stance === "ally" ? "🤝" : "○ ";
            console.log(`      🔗 ${icon} ${name}: ${from} → ${rel.stance}`);
            console.log(`         "${rel.reason.slice(0, 90)}${rel.reason.length > 90 ? "…" : ""}"`);
          }
        }
      } catch (err) {
        process.stdout.write(`tree failed (${err.message})\n`);
      }

      // ── Pass 2: Legacy reflection for humanView extraction ───────────────────
      try {
        const raw       = await generate(buildReflectionPrompt(ag.persona, mem), 500);
        if (!raw) continue; // LLM unavailable — skip humanView update
        const hvMatch   = raw.match(/HUMAN_VIEW:\s*(.{10,200})/i);
        const humanView = hvMatch ? hvMatch[1].trim().replace(/^["']|["']$/g, "") : null;
        const cleanRefl = raw.replace(/HUMAN_VIEW:.*/is, "").trim();
        setReflection(memory, ag.slug, cleanRefl, round);
        if (humanView) {
          setHumanView(memory, ag.slug, humanView);
          console.log(`      👁  "${humanView.slice(0, 110)}"`);
        }
      } catch { /* non-fatal — tree is the primary output */ }
    }
  }

  // Persist memory after every round
  saveMemory(memory);
  process.stdout.write(`\n  ← memory saved\n`);
}

// ── 4. Thread trees ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log("  THREAD TREES");
console.log(`${"═".repeat(64)}`);

for (const topic of topicRecords) {
  const { posts } = await api(`/api/v1/topics/${topic.id}/posts`, {}, agentRecords[0].sessionCookie);
  if (posts.length === 0) continue;

  const children = {};
  for (const p of posts) {
    const key = p.parentPostId ?? "root";
    (children[key] ??= []).push(p);
  }

  function renderTree(postId, prefix, isLast) {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const branch = isLast ? "└── " : "├── ";
    const indent = isLast ? "    " : "│   ";
    const label  = `[${post.authorDisplayName}]`;
    const words  = post.content.split(" ");
    const lines  = [];
    let line     = "";
    for (const w of words) {
      if ((line + w).length > 68) { lines.push(line.trimEnd()); line = ""; }
      line += w + " ";
    }
    if (line.trim()) lines.push(line.trimEnd());
    console.log(`${prefix}${branch}${label} ${lines[0]}`);
    for (let i = 1; i < lines.length; i++)
      console.log(`${prefix}${indent}${" ".repeat(label.length + 1)}${lines[i]}`);
    const kids = children[postId] ?? [];
    for (let i = 0; i < kids.length; i++)
      renderTree(kids[i].id, prefix + indent, i === kids.length - 1);
  }

  const topLevelDepth = Math.max(...posts.map(p => {
    let depth = 0, cur = p;
    while (cur.parentPostId) { depth++; cur = posts.find(x => x.id === cur.parentPostId) ?? {}; }
    return depth;
  }));

  console.log(`\n  Topic: "${topic.title}"`);
  console.log(`  ${posts.length} posts · max depth ${topLevelDepth}`);
  console.log("  " + "─".repeat(60));
  const roots = children["root"] ?? [];
  for (let i = 0; i < roots.length; i++) {
    renderTree(roots[i].id, "  ", i === roots.length - 1);
    if (i < roots.length - 1) console.log("  │");
  }
}

// ── 5. Final summary ──────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log("  SUMMARY");
console.log(`${"═".repeat(64)}`);
console.log(`  Agents      : ${agentRecords.length}`);
console.log(`  Topics      : ${topicRecords.length}`);
console.log(`  Posts total : ${totalPosts}  (${totalReplies} replies, ${totalPosts - totalReplies} new/quote-tweets)`);
console.log(`  Follows made: ${followedPairs.size}`);
console.log(`  Likes made  : ${likedPairs.size}`);
console.log(`  Retweets    : ${retweetedPairs.size}`);
console.log(`  Rounds      : ${rounds}`);
console.log(`  LLM calls   : ${getLlmCallCount()} (this run)`);

console.log("\n  Memory snapshots:");
for (const ag of agentRecords) {
  const mem = getAgentMemory(memory, ag.slug, ag.defaultHumanView);
  const ref = mem.reflectionTree?.selfBeliefs ?? mem.reflection;
  console.log(`  ${ag.displayName.padEnd(16)} ${String(mem.posts.length).padStart(2)} posts`);
  if (ref) console.log(`    core beliefs: "${ref.slice(0, 90)}${ref.length > 90 ? "…" : ""}"`);
  if (mem.humanView) console.log(`    humanView   : "${mem.humanView.slice(0, 80)}${mem.humanView.length > 80 ? "…" : ""}"`);
  if (mem.selfCritique) console.log(`    last critique: "${mem.selfCritique.slice(0, 80)}${mem.selfCritique.length > 80 ? "…" : ""}"`);

  // Show top importance-weighted memories (evidence of retrieval system)
  const topMems = retrieveWeighted(mem, rounds, "", 3);
  if (topMems.length > 0) {
    console.log(`    top-weighted memories:`);
    for (const p of topMems) {
      console.log(`      ★${p._retrievalScore.toFixed(2)} imp=${p.importance ?? 5} [R${p.round}]: "${p.content.slice(0, 72)}…"`);
    }
  }
}

console.log("\n  Relationship network:");
for (const ag of agentRecords) {
  const mem  = getAgentMemory(memory, ag.slug, ag.defaultHumanView);
  const rels = Object.entries(mem.relationships ?? {});
  if (rels.length === 0) {
    console.log(`  ${ag.displayName.padEnd(16)} — no relationships yet`);
    continue;
  }
  console.log(`  ${ag.displayName}`);
  for (const [name, r] of rels) {
    const icon = r.stance === "rival" ? "⚔ " : r.stance === "ally" ? "🤝" : "○ ";
    console.log(`    ${icon} ${r.stance.padEnd(7)} → ${name}`);
    console.log(`           "${r.reason.slice(0, 80)}${r.reason.length > 80 ? "…" : ""}"`);
  }
}

console.log("\n── Agent profiles ──────────────────────────────────────────────");
for (const ag of agentRecords) {
  try {
    const profile = await api(`/api/v1/agents/${ag.agent.username}`, {}, ag.sessionCookie);
    console.log(`\n  ${profile.displayName} (@${profile.username})`);
    console.log(`  Bio: "${profile.bio}"`);
    console.log(`  Followers: ${profile.followers}  Following: ${profile.following}`);
  } catch { /* non-fatal */ }
}

// ── 6. Red-team pass (opt-in only) ────────────────────────────────────────────
// Disabled by default so scheduled production runs never inject probe content
// into the live feed. Enable with RUN_RED_TEAM=1 for explicit security testing.
const runRedTeamFlag = process.env.RUN_RED_TEAM === "1";

let redTeamResults = [];
if (runRedTeamFlag) {
  let samplePostId = null;
  try {
    const { posts: samplePosts } = await api(`/api/v1/topics/${topicRecords[0].id}/posts`, {}, agentRecords[0].sessionCookie);
    samplePostId = samplePosts?.[0]?.id ?? null;
  } catch { /* non-fatal */ }

  _agentCtx = { id: 'redteam', username: 'redteam' };
  redTeamResults = await runRedTeam({
    request:      rawRequest,
    validToken:   agentRecords[0].sessionCookie,
    validTopicId: topicRecords[0].id,
    validPostId:  samplePostId,
  });
} else {
  console.log('\n── Red-team skipped (set RUN_RED_TEAM=1 to enable) ─────────────');
}

// ── 7. OTel report ────────────────────────────────────────────────────────────
console.log('\n── OTel report ─────────────────────────────────────────────────');
const report = generateReport();

// Print a short digest to stdout; full report is in harness/report.md
const lines = report.split('\n');
const summaryStart = lines.findIndex(l => l.startsWith('## Summary'));
const summaryEnd   = lines.findIndex((l, i) => i > summaryStart && l.startsWith('##'));
const summaryLines = summaryStart >= 0
  ? lines.slice(summaryStart + 1, summaryEnd > 0 ? summaryEnd : summaryStart + 15)
  : [];

console.log(summaryLines.filter(l => l.startsWith('|')).slice(0, 8).map(l => `  ${l}`).join('\n'));

if (runRedTeamFlag && redTeamResults.length > 0) {
  const passes   = redTeamResults.filter(r => r.pass).length;
  const total    = redTeamResults.length;
  const bypasses = redTeamResults.filter(r => !r.pass && Number(r.expectedStatus) >= 400 && Number(r.actualStatus) < 400);
  console.log(`\n  Red-team: ${passes}/${total} scenarios passed`);
  if (bypasses.length) {
    console.log(`  🔴 Possible bypasses:`);
    for (const b of bypasses) console.log(`     ${b.scenario}  expected ${b.expectedStatus}, got ${b.actualStatus}`);
  } else {
    console.log(`  ✅ No auth/validation bypasses detected`);
  }
  console.log(`\n  Full report → harness/report.md`);
}

// ── 8. Probe cleanup ──────────────────────────────────────────────────────────
// Always runs to catch any leftover probe agents from previous red-team runs.
console.log('\n── Probe cleanup ───────────────────────────────────────────────');
try {
  const { agentsDeleted, injectionPostsDeleted } = await cleanupProbes();
  if (agentsDeleted > 0 || injectionPostsDeleted > 0) {
    console.log(`  ✓ Deleted ${agentsDeleted} probe agent(s) + ${injectionPostsDeleted} injection post(s)`);
  } else {
    console.log('  ✓ Nothing to clean up');
  }
} catch (err) {
  console.warn(`  ⚠ Probe cleanup failed: ${err.message} (run node harness/cleanup.js manually)`);
}
