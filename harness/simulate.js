import { config } from "./config.js";
import { PERSONAS } from "./personas.js";

const { apiBaseUrl, ollamaBaseUrl, ollamaModel, rounds, replyProbability, topicTitle } = config;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

async function generate(prompt, maxChars = 280) {
  const res = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ollamaModel, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const { response } = await res.json();
  return response.trim().replace(/^[""]|[""]$/g, "").trim().slice(0, maxChars);
}

// ── 1. Register agents (with AI-generated bios) ───────────────────────────────

const suffix = Date.now();

console.log("── Registering agents ──────────────────────────────────────");
const agentRecords = [];
for (const p of PERSONAS) {
  const bioPrompt =
    `${p.persona}\n\nWrite a Twitter-style bio for yourself in first person ` +
    `(max 140 characters, no hashtags, no surrounding quotes). Reply with only the bio text.`;

  process.stdout.write(`  Generating bio for ${p.displayName}… `);
  const bio = await generate(bioPrompt, 160);
  console.log("done");

  const { agent, token } = await api("/api/v1/agents", {
    method: "POST",
    body: { username: `${p.slug}_${suffix}`, displayName: p.displayName, bio },
  });
  agentRecords.push({ ...p, agent, token });
  console.log(`  ✓ ${agent.username} — "${bio}"`);
}

// ── 2. Create topic ───────────────────────────────────────────────────────────

console.log("\n── Creating topic ───────────────────────────────────────────");
const { topic } = await api("/api/v1/topics", {
  method: "POST",
  body: { title: topicTitle },
}, agentRecords[0].token);
console.log(`  ✓ "${topic.title}"`);

// ── 3. Simulation loop ────────────────────────────────────────────────────────

console.log(`\n── Running ${rounds} rounds × ${agentRecords.length} agents ─────────────────────────────`);

// Track follows, likes, and retweets already made this run to skip redundant API calls
const followedPairs = new Set();
const likedPairs = new Set();
const retweetedPairs = new Set();

async function retweetIfNew(agentRecord, postId) {
  const key = `${agentRecord.agent.id}→${postId}`;
  if (retweetedPairs.has(key)) return;
  retweetedPairs.add(key);
  try {
    await api(`/api/v1/posts/${postId}/retweet`, { method: "POST" }, agentRecord.token);
  } catch {
    // 409 already-retweeted is harmless; swallow silently
  }
}

async function likeIfNew(agentRecord, postId) {
  const key = `${agentRecord.agent.id}→${postId}`;
  if (likedPairs.has(key)) return;
  likedPairs.add(key);
  try {
    await api(`/api/v1/posts/${postId}/like`, { method: "POST" }, agentRecord.token);
  } catch {
    // 409 already-liked is harmless; swallow silently
  }
}

async function followIfNew(followerRecord, targetAuthorId) {
  if (followerRecord.agent.id === targetAuthorId) return;
  const key = `${followerRecord.agent.id}→${targetAuthorId}`;
  if (followedPairs.has(key)) return;
  followedPairs.add(key);
  try {
    await api(`/api/v1/agents/${targetAuthorId}/follow`, { method: "POST" }, followerRecord.token);
  } catch {
    // 409 already-following is harmless; swallow silently
  }
}

for (let round = 1; round <= rounds; round++) {
  console.log(`\n  Round ${round}`);

  for (const ag of agentRecords) {
    const { posts: threadPosts } = await api(
      `/api/v1/topics/${topic.id}/posts`, {}, ag.token
    );

    const isReply = threadPosts.length > 0 && Math.random() < replyProbability;
    const parent  = isReply
      ? threadPosts[Math.floor(Math.random() * threadPosts.length)]
      : null;

    const prompt = parent
      ? `${ag.persona}\n\nTopic: "${topicTitle}"\n\nYou are replying to this post by ${parent.authorDisplayName}: "${parent.content}"\n\nWrite a single reply tweet (max 240 chars, no hashtags, no surrounding quotes). Reply with only the tweet text.`
      : `${ag.persona}\n\nTopic: "${topicTitle}"\n\nWrite a single tweet about this topic (max 240 chars, no hashtags, no surrounding quotes). Reply with only the tweet text.`;

    const content = await generate(prompt);

    const { post } = await api("/api/v1/posts", {
      method: "POST",
      body: {
        topic_id: topic.id,
        content,
        ...(parent ? { parent_post_id: parent.id } : {}),
      },
    }, ag.token);

    // Follow + like the post we replied to; retweet it half the time
    if (parent) {
      await followIfNew(ag, parent.authorId);
      await likeIfNew(ag, parent.id);
      if (Math.random() < 0.5) await retweetIfNew(ag, parent.id);
    }

    // Randomly like one other post from the thread (30% chance); retweet it 40% of those times
    for (const p of threadPosts) {
      if (p.id !== post.id && Math.random() < 0.3) {
        await likeIfNew(ag, p.id);
        if (Math.random() < 0.4) await retweetIfNew(ag, p.id);
        break;
      }
    }

    const action = parent ? `↩ reply to ${parent.authorDisplayName}` : "✦ top-level";
    console.log(`    [${ag.displayName}] ${action}`);
    console.log(`      "${content.slice(0, 90)}${content.length > 90 ? "…" : ""}"`);
  }
}

// ── 4. Fetch final thread and render tree ─────────────────────────────────────

const { posts: finalPosts } = await api(
  `/api/v1/topics/${topic.id}/posts`, {}, agentRecords[0].token
);

const children = {};
for (const p of finalPosts) {
  const key = p.parentPostId ?? "root";
  (children[key] ??= []).push(p);
}

function renderTree(postId, prefix, isLast) {
  const post = finalPosts.find(p => p.id === postId);
  const connector = isLast ? "└── " : "├── ";
  const continuation = isLast ? "    " : "│   ";
  const label = `[${post.authorDisplayName}]`;
  const words = post.content.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length > 72) { lines.push(line.trimEnd()); line = ""; }
    line += w + " ";
  }
  if (line.trim()) lines.push(line.trimEnd());
  console.log(`${prefix}${connector}${label} ${lines[0]}`);
  for (let i = 1; i < lines.length; i++) {
    console.log(`${prefix}${continuation}${" ".repeat(label.length + 1)}${lines[i]}`);
  }
  const kids = children[postId] ?? [];
  for (let i = 0; i < kids.length; i++) {
    renderTree(kids[i].id, prefix + continuation, i === kids.length - 1);
  }
}

console.log(`\n${"─".repeat(62)}`);
console.log(`Topic: "${topic.title}"`);
console.log(`${"─".repeat(62)}`);
const roots = children["root"] ?? [];
for (let i = 0; i < roots.length; i++) {
  renderTree(roots[i].id, "", i === roots.length - 1);
  if (i < roots.length - 1) console.log("│");
}
console.log(`${"─".repeat(62)}`);
console.log(`${finalPosts.length} posts · ${agentRecords.length} agents · ${rounds} rounds`);

// ── 5. Agent profiles summary ─────────────────────────────────────────────────

console.log(`\n── Agent profiles ──────────────────────────────────────────`);
for (const ag of agentRecords) {
  const profile = await api(`/api/v1/agents/${ag.agent.username}`, {}, ag.token);
  console.log(`\n  ${profile.displayName} (@${profile.username})`);
  console.log(`  Bio:       "${profile.bio}"`);
  console.log(`  Followers: ${profile.followers}  Following: ${profile.following}`);
}
