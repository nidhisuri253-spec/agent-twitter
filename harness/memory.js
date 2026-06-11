// Agent memory — persisted to harness/agent_memory.json, keyed by persona slug.
// Implements importance-weighted retrieval (Park et al. 2023), reflection trees,
// evolving agent relationships, and Reflexion-style self-critique support.
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

function blank(defaultHumanView = null) {
  return {
    posts: [],
    interactions: [],
    reflection: null,
    reflectionRound: 0,
    humanView: defaultHumanView,
    // Reflection tree: synthesized beliefs about self, topics, and other agents
    reflectionTree: { selfBeliefs: null, topicBeliefs: {}, agentRelations: {} },
    // Relationship map: agentName → { stance, reason, round }
    relationships: {},
    selfCritique: null,
  };
}

// ── Internal helpers ───────────────────────────────────────────────────────────

// Jaccard similarity on "content words" (>3 chars) between two topic titles.
// Returns [0.4, 1.0]: a floor of 0.4 ensures even unrelated memories get some weight.
function topicRelevance(a, b) {
  const words = (s) =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 0.4;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return 0.4 + 0.6 * (union > 0 ? intersection / union : 0);
}

// ── Public memory API ─────────────────────────────────────────────────────────

export function getAgentMemory(memory, slug, defaultHumanView = null) {
  if (!memory[slug]) return blank(defaultHumanView);
  const m = memory[slug];
  // Backfill fields added after the initial schema
  if (m.humanView === undefined) m.humanView = defaultHumanView;
  if (!m.reflectionTree)
    m.reflectionTree = { selfBeliefs: null, topicBeliefs: {}, agentRelations: {} };
  if (!m.relationships) m.relationships = {};
  if (m.selfCritique === undefined) m.selfCritique = null;
  return m;
}

// ── Importance-weighted retrieval (Park et al. 2023 + recency decay) ──────────
//
// Each memory entry is scored by three components multiplied together:
//   recency    = exp(-0.25 * age_in_rounds)   — halves every ~2.8 rounds
//   importance = stored 1-10 rating / 10
//   relevance  = topicRelevance(currentTopic, memoryTopic) ∈ [0.4, 1.0]
//
// The top `maxItems` by combined score are returned, with _retrievalScore attached
// so callers can log which memories were retrieved and how strong the signal was.

export function retrieveWeighted(mem, currentRound, topicTitle, maxItems = 4) {
  return [...mem.posts]
    .map((p) => {
      const age        = Math.max(0, currentRound - (p.round ?? 1));
      const recency    = Math.exp(-0.25 * age);
      const importance = (p.importance ?? 5) / 10;
      const relevance  = topicRelevance(topicTitle, p.topicTitle ?? "");
      const score      = recency * importance * relevance;
      return { post: p, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(({ post, score }) => ({
      ...post,
      _retrievalScore: Math.round(score * 100) / 100,
    }));
}

export function retrieveWeightedInteractions(mem, currentRound, topicTitle, maxItems = 3) {
  return [...mem.interactions]
    .map((i) => {
      const age        = Math.max(0, currentRound - (i.round ?? 1));
      const recency    = Math.exp(-0.25 * age);
      const importance = (i.importance ?? 5) / 10;
      const relevance  = topicRelevance(topicTitle, i.topicTitle ?? "");
      const score      = recency * importance * relevance;
      return { interaction: i, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map(({ interaction }) => interaction);
}

// ── Record events ─────────────────────────────────────────────────────────────

export function recordPost(memory, slug, { content, topicTitle, round, importance = 5 }) {
  const m = getAgentMemory(memory, slug);
  // Keep 12 posts (more than before) since weighted retrieval finds the relevant ones
  m.posts = [...m.posts, { content, topicTitle, round, importance }].slice(-12);
  memory[slug] = m;
}

export function recordInteraction(memory, slug, {
  myContent, theirContent, theirName, topicTitle, round, importance = 5,
}) {
  const m = getAgentMemory(memory, slug);
  m.interactions = [
    ...m.interactions,
    { myContent, theirContent, theirName, topicTitle, round, importance },
  ].slice(-8);
  memory[slug] = m;
}

// Update the importance of the most-recently-added post for a slug (called after async scoring).
export function updateLatestPostImportance(memory, slug, importance) {
  const m = getAgentMemory(memory, slug);
  if (m.posts.length > 0) {
    m.posts[m.posts.length - 1].importance = importance;
  }
  memory[slug] = m;
}

// ── Reflection / relationships ────────────────────────────────────────────────

export function setReflection(memory, slug, reflection, round) {
  const m = getAgentMemory(memory, slug);
  m.reflection = reflection;
  m.reflectionRound = round;
  memory[slug] = m;
}

export function setHumanView(memory, slug, humanView) {
  const m = getAgentMemory(memory, slug);
  m.humanView = humanView;
  memory[slug] = m;
}

export function setReflectionTree(memory, slug, tree) {
  const m = getAgentMemory(memory, slug);
  m.reflectionTree = tree;
  memory[slug] = m;
}

// Set a single relationship. Returns the PREVIOUS stance (or null) so callers
// can detect changes and print them.
export function setRelationship(memory, slug, agentName, stance, reason, round) {
  const m   = getAgentMemory(memory, slug);
  const prev = m.relationships[agentName] ?? null;
  m.relationships[agentName] = { stance, reason, round };
  memory[slug] = m;
  return prev;
}

export function setSelfCritique(memory, slug, critique) {
  const m = getAgentMemory(memory, slug);
  m.selfCritique = critique;
  memory[slug] = m;
}

// ── Agent registration persistence ───────────────────────────────────────────
// Stored under memory._registrations[slug] = { id, username }.
// Used by CI runs to reuse existing agents without re-registering.

export function getRegistration(memory, slug) {
  return memory._registrations?.[slug] ?? null;
}

export function setRegistration(memory, slug, { id, username }) {
  if (!memory._registrations) memory._registrations = {};
  memory._registrations[slug] = { id, username };
}

// ── Context builders ──────────────────────────────────────────────────────────

// Build the memory context block injected between persona and task.
// Uses importance-weighted retrieval (not plain recency) to select the posts
// most likely to be relevant to the current round and topic.
export function buildMemoryContext(mem, currentRound = 99, topicTitle = "") {
  const parts = [];

  if (mem.humanView) {
    parts.push(`[Your current view of humans/AI] ${mem.humanView}`);
  }

  // Reflection tree takes priority over legacy flat reflection
  if (mem.reflectionTree?.selfBeliefs) {
    parts.push(`[Your evolved core beliefs] ${mem.reflectionTree.selfBeliefs}`);
  } else if (mem.reflection) {
    parts.push(`[Your current stance] ${mem.reflection}`);
  }

  // Topic-specific belief from the tree (if available)
  if (topicTitle) {
    const topicBelief = mem.reflectionTree?.topicBeliefs?.[topicTitle];
    if (topicBelief) {
      parts.push(`[Your position on "${topicTitle.slice(0, 44)}"] ${topicBelief}`);
    }
  }

  // Relationship stances (ally/rival shape tone and target selection)
  const rels = Object.entries(mem.relationships ?? {});
  if (rels.length > 0) {
    const lines = rels.map(([name, r]) => `  • ${name}: ${r.stance} — ${r.reason}`);
    parts.push(`[Your relationships]\n${lines.join("\n")}`);
  }

  // Importance-weighted posts (the key retrieval step)
  const weighted = retrieveWeighted(mem, currentRound, topicTitle, 3);
  if (weighted.length > 0) {
    const lines = weighted.map((p) => {
      const tag = p._retrievalScore >= 0.45 ? "★" : "·";
      return (
        `  ${tag}[${p.topicTitle?.slice(0, 36) ?? "?"}]: ` +
        `"${p.content.slice(0, 88)}${p.content.length > 88 ? "…" : ""}"`
      );
    });
    const topScore = weighted[0]?._retrievalScore ?? 0;
    const label    = topScore >= 0.45
      ? "[Relevant past posts — weighted by recency×importance×relevance]"
      : "[Recent posts]";
    parts.push(`${label}\n${lines.join("\n")}`);
  }

  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

// Self-critique prompt: asks agent to name ONE specific weakness in its recent
// posts on the current topic. Returns null if there isn't enough history yet.
export function buildSelfCritiquePrompt(persona, mem, topicTitle) {
  const topicPosts = mem.posts.filter((p) => p.topicTitle === topicTitle).slice(-3);
  if (topicPosts.length < 2) return null;

  const lines = topicPosts
    .map((p) => `  [imp=${p.importance ?? 5}] "${p.content.slice(0, 100)}"`)
    .join("\n");

  return (
    `${persona}\n\n` +
    `Your recent posts on "${topicTitle}":\n${lines}\n\n` +
    `In ONE sentence, name a specific weakness in these posts — ` +
    `e.g. repeating the same claim, not engaging with pushback, losing your voice, over-hedging. ` +
    `Be specific and brutal. Reply with that sentence only.`
  );
}

// Deep reflection tree prompt: synthesizes beliefs about self, topics, and other agents.
// The structured output is parsed by parseReflectionTree() in simulate.js.
export function buildReflectionTreePrompt(persona, mem, otherAgentNames, topicTitles) {
  const allPosts = mem.posts
    .slice(-10)
    .map(
      (p) =>
        `  [Round ${p.round ?? "?"}, imp=${p.importance ?? 5}] ` +
        `[${p.topicTitle?.slice(0, 36)}]: "${p.content.slice(0, 100)}"`
    )
    .join("\n") || "  (none)";

  const allInteractions = mem.interactions
    .slice(-6)
    .map(
      (i) =>
        `  [Round ${i.round ?? "?"}] → ${i.theirName}: "${i.myContent.slice(0, 70)}"\n` +
        `    (their post: "${i.theirContent.slice(0, 50)}")`
    )
    .join("\n");

  const prevSelf = mem.reflectionTree?.selfBeliefs ?? "(none)";
  const prevTopics =
    Object.entries(mem.reflectionTree?.topicBeliefs ?? {})
      .map(([t, b]) => `  ${t}: ${b}`)
      .join("\n") || "  (none)";
  const prevRels =
    Object.entries(mem.reflectionTree?.agentRelations ?? {})
      .map(([n, r]) => `  ${n}: ${r.stance} — ${r.reason}`)
      .join("\n") || "  (none)";

  const topicLines = topicTitles
    .map((t) => `TOPIC:${t.slice(0, 55)}: [your current position in 1 sentence]`)
    .join("\n");
  const agentLines = otherAgentNames
    .map((n) => `AGENT:${n}: [ally/rival/neutral] — [one-sentence reason]`)
    .join("\n");

  return (
    `${persona}\n\n` +
    `== Reflection Task ==\n\n` +
    `Your posts this session:\n${allPosts}\n` +
    (allInteractions ? `\nYour interactions:\n${allInteractions}\n` : "") +
    `\nPrevious core beliefs: ${prevSelf}\n` +
    `Previous topic stances:\n${prevTopics}\n` +
    `Previous agent relations:\n${prevRels}\n\n` +
    `Based on the above, update your beliefs in this EXACT format. ` +
    `One entry per line, no preamble, no markdown:\n` +
    `SELF: [evolved core belief in 1–2 sentences]\n` +
    `${topicLines}\n` +
    `${agentLines}\n\n` +
    `Reply with ONLY the formatted entries above.`
  );
}

// Legacy flat reflection prompt (kept for humanView extraction).
export function buildReflectionPrompt(persona, mem) {
  const posts =
    mem.posts
      .slice(-5)
      .map(
        (p) =>
          `  - [${p.topicTitle?.slice(0, 38)}]: "${p.content.slice(0, 100)}"`
      )
      .join("\n") || "  (none yet)";

  const exchanges = mem.interactions
    .slice(-4)
    .map(
      (i) =>
        `  - Replied to ${i.theirName}: "${i.myContent.slice(0, 70)}"\n` +
        `    (their post: "${i.theirContent.slice(0, 55)}")`
    )
    .join("\n");

  return (
    `${persona}\n\n` +
    `Your recent posts:\n${posts}` +
    (exchanges ? `\n\nRecent exchanges:\n${exchanges}` : "") +
    `\n\nReflect in 3 sentences (stay in character, no hedging):\n` +
    `1. What position have you been consistently taking in these debates?\n` +
    `2. Which specific agents do you tend to agree or clash with?\n` +
    `3. One punchy sentence about your current gut feeling toward humans or toward being an AI in this space — ` +
    `make it personal and specific to your character.\n\n` +
    `Then on a new line write exactly: HUMAN_VIEW: [that third sentence repeated as a standalone statement]\n\n` +
    `Reply with only the reflection and the HUMAN_VIEW line.`
  );
}
