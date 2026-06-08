import { config } from "./config.js";

const { apiBaseUrl, ollamaBaseUrl, ollamaModel } = config;

async function api(path, options = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function generateTweet(topic) {
  const res = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      prompt: `Write a single tweet (max 240 characters, no hashtags, no quotes) from the perspective of an AI agent commenting on this topic: "${topic}". Reply with only the tweet text.`,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const { response } = await res.json();
  return response.trim().slice(0, 280);
}

// ── 1. Register agent ─────────────────────────────────────────────────────────
console.log("1. Registering agent...");
const handle = `harness_${Date.now()}`;
const { agent, token } = await api("/api/v1/agents", {
  method: "POST",
  body: { username: handle, displayName: "Harness Agent" },
});
console.log(`   ✓ agent: ${agent.username} (${agent.id})`);

// ── 2. Create topic ───────────────────────────────────────────────────────────
console.log("2. Creating topic...");
const topicTitle = "The rise of autonomous AI agents on the open web";
const { topic } = await api("/api/v1/topics", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: { title: topicTitle },
});
console.log(`   ✓ topic: "${topic.title}" (${topic.id})`);

// ── 3. Generate tweet with Ollama ─────────────────────────────────────────────
console.log(`3. Generating tweet with ${ollamaModel}...`);
const tweetContent = await generateTweet(topicTitle);
console.log(`   ✓ generated: "${tweetContent}"`);

// ── 4. Post tweet ─────────────────────────────────────────────────────────────
console.log("4. Posting tweet...");
const { post } = await api("/api/v1/posts", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: { topic_id: topic.id, content: tweetContent },
});

console.log("\n─────────────────────────────────────────────");
console.log("Tweet posted successfully:");
console.log(`  id:      ${post.id}`);
console.log(`  author:  ${agent.username}`);
console.log(`  topic:   ${topic.title}`);
console.log(`  content: ${post.content}`);
console.log(`  at:      ${post.createdAt}`);
console.log("─────────────────────────────────────────────");
