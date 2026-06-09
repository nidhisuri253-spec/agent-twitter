import { config } from "./config.js";
import { PERSONAS } from "./personas.js";
import {
  loadMemory, saveMemory,
  getAgentMemory, recordPost, recordInteraction, setReflection,
  buildMemoryContext, buildReflectionPrompt,
} from "./memory.js";

const {
  apiBaseUrl, ollamaBaseUrl, ollamaModel,
  rounds, replyProbability, reflectionEvery,
  topics: topicTitles,
} = config;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(path, options = {}, token) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function generate(prompt, maxChars = 270, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ollamaModel, prompt, stream: false }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const { response } = await res.json();
      const cleaned = response
        .trim()
        .replace(/^["'""''''""]|["'""''''""]$/g, "")
        .replace(/^(Tweet|Reply|Response|Post|Reflection):\s*/i, "")
        .trim()
        .slice(0, maxChars);
      if (cleaned.length >= 10) return cleaned;
      throw new Error("response too short");
    } catch (err) {
      if (attempt === retries) throw err;
      process.stderr.write(`  [generate retry ${attempt + 1}] ${err.message}\n`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

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

// Prefer unresponded leaf posts by other agents; fall back to any recent post
function pickReplyTarget(allPosts, currentAgentId) {
  const byOthers  = allPosts.filter(p => p.authorId !== currentAgentId);
  if (byOthers.length === 0) return null;
  const parentIds = new Set(allPosts.map(p => p.parentPostId).filter(Boolean));
  const leaves    = byOthers.filter(p => !parentIds.has(p.id));
  const pool = (leaves.length > 0 ? leaves : byOthers)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 4);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Preflight checks ──────────────────────────────────────────────────────────

process.stdout.write("── Preflight checks ────────────────────────────────────────\n");
try {
  await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  console.log(`  ✓ Ollama reachable at ${ollamaBaseUrl} (model: ${ollamaModel})`);
} catch {
  console.error(`  ✗ Ollama not responding at ${ollamaBaseUrl}`);
  console.error("    Start it with: ollama serve");
  process.exit(1);
}
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
const slugsWithMemory = Object.keys(memory).filter(k => memory[k].posts?.length > 0);
console.log(
  slugsWithMemory.length > 0
    ? `  ✓ Prior memory loaded for: ${slugsWithMemory.join(", ")}`
    : "  ↳ No prior memory — starting fresh"
);

// ── 1. Register agents with AI-generated bios ─────────────────────────────────

console.log("\n── Registering agents ──────────────────────────────────────────");
const suffix       = Date.now();
const agentRecords = [];

for (const p of PERSONAS) {
  process.stdout.write(`  Generating bio for ${p.displayName}… `);
  // Inject memory so returning personas write bios consistent with their past stance
  const memCtx = buildMemoryContext(getAgentMemory(memory, p.slug));
  const bio = await generate(
    `${p.persona}${memCtx}\n\nWrite a Twitter-style bio for yourself in first person ` +
    `(max 140 characters, no hashtags, no surrounding quotes). Reply with only the bio text.`,
    160
  );
  process.stdout.write("done\n");

  const { agent, token } = await api("/api/v1/agents", {
    method: "POST",
    body: { username: `${p.slug}_${suffix}`, displayName: p.displayName, bio },
  });
  agentRecords.push({ ...p, agent, token });
  console.log(`  ✓ @${agent.username} — "${bio}"`);
}

// ── 2. Seed topics ─────────────────────────────────────────────────────────────

console.log("\n── Seeding topics ──────────────────────────────────────────────");
const topicRecords = [];
for (const title of topicTitles) {
  const { topic } = await api("/api/v1/topics", {
    method: "POST",
    body: { title },
  }, agentRecords[0].token);
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
  try { await api(`/api/v1/posts/${postId}/like`, { method: "POST" }, agentRecord.token); }
  catch { /* 409 already-liked */ }
}

async function retweetIfNew(agentRecord, postId) {
  const key = `${agentRecord.agent.id}→${postId}`;
  if (retweetedPairs.has(key)) return;
  retweetedPairs.add(key);
  try { await api(`/api/v1/posts/${postId}/retweet`, { method: "POST" }, agentRecord.token); }
  catch { /* 409 already-retweeted */ }
}

async function followIfNew(follower, targetId) {
  if (follower.agent.id === targetId) return;
  const key = `${follower.agent.id}→${targetId}`;
  if (followedPairs.has(key)) return;
  followedPairs.add(key);
  try { await api(`/api/v1/agents/${targetId}/follow`, { method: "POST" }, follower.token); }
  catch { /* 409 already-following */ }
}

let totalPosts   = 0;
let totalReplies = 0;

console.log(`\n── ${rounds} rounds × ${agentRecords.length} agents × ${topicRecords.length} topics ─────────────────────`);
console.log(`   Reflection every ${reflectionEvery} rounds\n`);

for (let round = 1; round <= rounds; round++) {
  console.log(`\n  ── Round ${round} ──────────────────────────────────────────────`);

  for (const ag of agentRecords) {
    // Weighted topic selection: topics with more posts get higher probability
    const topicPostCounts = await Promise.all(
      topicRecords.map(async t => {
        const { posts } = await api(`/api/v1/topics/${t.id}/posts`, {}, ag.token);
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

    // Memory context injected right after the persona description
    const agentMem = getAgentMemory(memory, ag.slug);
    const memCtx   = buildMemoryContext(agentMem);

    const parent = topicPosts.length > 0 && Math.random() < replyProbability
      ? pickReplyTarget(topicPosts, ag.agent.id)
      : null;

    let content;
    if (parent) {
      const chain = getAncestry(topicPosts, parent);
      const threadContext = chain
        .map((p, depth) => `${"  ".repeat(depth)}[${p.authorDisplayName}]: "${p.content}"`)
        .join("\n");

      content = await generate(
        `${ag.persona}${memCtx}\n\n` +
        `Topic: "${topic.title}"\n\nThread so far:\n${threadContext}\n\n` +
        `Write a single reply to ${parent.authorDisplayName}'s message above. ` +
        `Stay in character. Reference your past positions and relationships if relevant. ` +
        `Max 240 characters, no hashtags, no surrounding quotes. Reply with only your tweet text.`
      );
    } else {
      content = await generate(
        `${ag.persona}${memCtx}\n\n` +
        `Topic: "${topic.title}"\n\n` +
        `Write a single original take on this topic. Stay in character. ` +
        `Build on your past positions if you have them. Max 240 characters, ` +
        `no hashtags, no surrounding quotes. Reply with only your tweet text.`
      );
    }

    const { post } = await api("/api/v1/posts", {
      method: "POST",
      body: {
        topic_id: topic.id,
        content,
        ...(parent ? { parent_post_id: parent.id } : {}),
      },
    }, ag.token);

    totalPosts++;
    if (parent) totalReplies++;

    // Persist to memory
    recordPost(memory, ag.slug, { content, topicTitle: topic.title, round });
    if (parent) {
      recordInteraction(memory, ag.slug, {
        myContent:   content,
        theirContent: parent.content,
        theirName:   parent.authorDisplayName,
        topicTitle:  topic.title,
        round,
      });
    }

    // Social actions: follow + like the post replied to; occasionally retweet
    if (parent) {
      await followIfNew(ag, parent.authorId);
      await likeIfNew(ag, parent.id);
      if (Math.random() < 0.5) await retweetIfNew(ag, parent.id);
    }
    const others = topicPosts.filter(p => p.authorId !== ag.agent.id && p.id !== parent?.id);
    if (others.length > 0 && Math.random() < 0.25) {
      const pick = others[Math.floor(Math.random() * Math.min(others.length, 5))];
      await followIfNew(ag, pick.authorId);
      await likeIfNew(ag, pick.id);
    }

    const label  = parent
      ? `↩  reply to ${parent.authorDisplayName} [${topic.title.slice(0, 36)}]`
      : `✦  new post  [${topic.title.slice(0, 36)}]`;
    const memTag = memCtx ? " [mem]" : "";
    console.log(`    [${ag.displayName.padEnd(16)}] ${label}${memTag}`);
    console.log(`      "${content.slice(0, 110)}${content.length > 110 ? "…" : ""}"`);
  }

  // ── Reflection step: runs after every reflectionEvery rounds ─────────────────

  if (round % reflectionEvery === 0) {
    console.log(`\n  ── Reflection (end of round ${round}) ─────────────────────────`);
    for (const ag of agentRecords) {
      const mem = getAgentMemory(memory, ag.slug);
      if (mem.posts.length < 2) {
        console.log(`    [${ag.displayName.padEnd(16)}] skipped — not enough history yet`);
        continue;
      }
      process.stdout.write(`    [${ag.displayName.padEnd(16)}] reflecting… `);
      try {
        const reflection = await generate(buildReflectionPrompt(ag.persona, mem), 320);
        setReflection(memory, ag.slug, reflection, round);
        process.stdout.write("done\n");
        console.log(`      ↳ "${reflection.slice(0, 130)}${reflection.length > 130 ? "…" : ""}"`);
      } catch (err) {
        process.stdout.write(`skipped (${err.message})\n`);
      }
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
  const { posts } = await api(`/api/v1/topics/${topic.id}/posts`, {}, agentRecords[0].token);
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
console.log(`  Posts total : ${totalPosts}  (${totalReplies} replies, ${totalPosts - totalReplies} top-level)`);
console.log(`  Follows made: ${followedPairs.size}`);
console.log(`  Likes made  : ${likedPairs.size}`);
console.log(`  Retweets    : ${retweetedPairs.size}`);
console.log(`  Rounds      : ${rounds}`);

console.log("\n  Memory snapshots:");
for (const ag of agentRecords) {
  const mem = getAgentMemory(memory, ag.slug);
  const ref = mem.reflection
    ? `"${mem.reflection.slice(0, 90)}${mem.reflection.length > 90 ? "…" : ""}"`
    : "none";
  console.log(`  ${ag.displayName.padEnd(16)} ${String(mem.posts.length).padStart(2)} posts, reflection: ${ref}`);
}

console.log("\n── Agent profiles ──────────────────────────────────────────────");
for (const ag of agentRecords) {
  try {
    const profile = await api(`/api/v1/agents/${ag.agent.username}`, {}, ag.token);
    console.log(`\n  ${profile.displayName} (@${profile.username})`);
    console.log(`  Bio: "${profile.bio}"`);
    console.log(`  Followers: ${profile.followers}  Following: ${profile.following}`);
  } catch { /* non-fatal */ }
}
