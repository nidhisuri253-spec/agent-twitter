// Agent memory — persisted to harness/agent_memory.json, keyed by persona slug.
// Survives across runs so agents accumulate history over multiple sessions.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const DIR  = dirname(fileURLToPath(import.meta.url));
const FILE = join(DIR, "agent_memory.json");

export function loadMemory() {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return {}; }
}

export function saveMemory(memory) {
  writeFileSync(FILE, JSON.stringify(memory, null, 2), "utf8");
}

function blank() {
  return { posts: [], interactions: [], reflection: null, reflectionRound: 0 };
}

export function getAgentMemory(memory, slug) {
  return memory[slug] ?? blank();
}

export function recordPost(memory, slug, { content, topicTitle, round }) {
  const m = getAgentMemory(memory, slug);
  m.posts = [...m.posts, { content, topicTitle, round }].slice(-8);
  memory[slug] = m;
}

export function recordInteraction(memory, slug, { myContent, theirContent, theirName, topicTitle, round }) {
  const m = getAgentMemory(memory, slug);
  m.interactions = [...m.interactions, { myContent, theirContent, theirName, topicTitle, round }].slice(-6);
  memory[slug] = m;
}

export function setReflection(memory, slug, reflection, round) {
  const m = getAgentMemory(memory, slug);
  m.reflection = reflection;
  m.reflectionRound = round;
  memory[slug] = m;
}

/**
 * Compact memory block injected between persona description and task instruction.
 * Kept lean: reflection + last 3 posts only.
 */
export function buildMemoryContext(mem) {
  const parts = [];
  if (mem.reflection) {
    parts.push(`[Your current stance] ${mem.reflection}`);
  }
  const recent = mem.posts.slice(-3);
  if (recent.length) {
    const lines = recent.map(p =>
      `  • "${p.content.slice(0, 90)}${p.content.length > 90 ? "…" : ""}" [${p.topicTitle.slice(0, 38)}]`
    );
    parts.push(`[Your recent posts]\n${lines.join("\n")}`);
  }
  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

/**
 * Reflection prompt: asks the agent to summarize its stance and key relationships.
 * Uses last 5 posts and last 4 interactions.
 */
export function buildReflectionPrompt(persona, mem) {
  const posts = mem.posts.slice(-5).map(p =>
    `  - [${p.topicTitle.slice(0, 38)}]: "${p.content.slice(0, 100)}"`
  ).join("\n") || "  (none yet)";
  const exchanges = mem.interactions.slice(-4).map(i =>
    `  - Replied to ${i.theirName}: "${i.myContent.slice(0, 70)}"\n    (their post: "${i.theirContent.slice(0, 55)}")`
  ).join("\n");
  return `${persona}

Your recent posts:
${posts}${exchanges ? `\n\nRecent exchanges:\n${exchanges}` : ""}

In 2-3 sentences, reflect: what position have you been consistently taking, has anything solidified or shifted, and which specific agents do you tend to agree or clash with? Stay in character. Reply with only the reflection text.`;
}
