// Provider-agnostic LLM module.
// Set LLM_PROVIDER=pollinations (free, no key) or LLM_PROVIDER=ollama (local).
// All generate/score/critique calls go through this module so simulate.js
// doesn't need to know which backend is running.
import { config } from "./config.js";

const { llmProvider, ollamaBaseUrl, ollamaModel, pollinationsModel } = config;

// ── Output cleaning (shared) ──────────────────────────────────────────────────

function cleanOutput(text) {
  return text
    .trim()
    .replace(/^["'""''''""]|["'""''''""]$/g, "")
    .replace(/^(Tweet|Reply|Response|Post|Reflection):\s*/i, "")
    .trim();
}

// Trim to maxChars at a sentence/word boundary — never mid-word.
function smartTrim(text, maxChars) {
  const t = text.trimEnd();
  const endsClean = /[.!?]["']?$|#[a-zA-Z0-9_]{3,}$|['")\]]$/.test(t);
  if (t.length <= maxChars && endsClean) return t;

  const window = t.slice(0, maxChars);
  const lastDot = Math.max(
    window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "),
    window.lastIndexOf(".\n"), window.lastIndexOf('!"'), window.lastIndexOf('?"'),
  );
  if (lastDot >= maxChars * 0.4) return t.slice(0, lastDot + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace >= maxChars * 0.4) return t.slice(0, lastSpace).trim();
  return window.trim();
}

// ── Per-run LLM call counter ──────────────────────────────────────────────────
let _callCount = 0;
export function getLlmCallCount()   { return _callCount; }
export function resetLlmCallCount() { _callCount = 0; }

// ── Pollinations provider ─────────────────────────────────────────────────────
// Free text generation via https://text.pollinations.ai/openai (OpenAI-compatible).
// No API key required. `private: true` keeps prompts off their public gallery.
//
// Rate-limit strategy:
//   • Enforce a 3-8 s random gap between consecutive calls (inter-call jitter)
//     so GitHub Actions shared-IP bursts don't exceed Pollinations' queue.
//   • On HTTP 429: exponential back-off 1.5 s × 2^attempt + up to 10 s jitter,
//     capped at ~40 s per retry, up to 6 attempts total.
//   • Returns null (never throws) after all retries are exhausted so the
//     caller can skip the generation gracefully instead of crashing.

let _lastPollCall = 0; // ms timestamp of the last call start

async function pollinationsChat(messages, maxTokens = 200) {
  // Wait for the minimum inter-call gap before issuing the next request.
  const since  = Date.now() - _lastPollCall;
  const minGap = 3000 + Math.floor(Math.random() * 5000); // 3-8 s
  if (_lastPollCall > 0 && since < minGap) {
    await new Promise((r) => setTimeout(r, minGap - since));
  }
  _lastPollCall = Date.now();
  _callCount++;

  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try {
      res = await fetch("https://text.pollinations.ai/openai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: pollinationsModel,
          messages,
          max_tokens: maxTokens,
          private: true,
          seed: Math.floor(Math.random() * 99999),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (attempt < 5) {
        const wait = 3000 + Math.floor(Math.random() * 4000);
        process.stderr.write(`  [Pollinations network] ${err.message} — retry ${attempt + 1}/6 in ${Math.round(wait / 1000)}s\n`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      process.stderr.write("  [Pollinations] all retries failed (network) — skipping\n");
      return null;
    }

    if (res.status === 429) {
      const base = Math.min(30_000, 1500 * Math.pow(2, attempt)); // 1.5s → 3s → 6s → 12s → 24s → 30s
      const wait = base + Math.floor(Math.random() * 10_000);     // + up to 10 s jitter
      process.stderr.write(`  [Pollinations 429] retry ${attempt + 1}/6, backing off ${Math.round(wait / 1000)}s…\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`  [Pollinations ${res.status}] ${body.slice(0, 80)}\n`);
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      process.stderr.write(`  [Pollinations] all retries failed (HTTP ${res.status}) — skipping\n`);
      return null;
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) {
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return null;
    }
    return text;
  }

  process.stderr.write("  [Pollinations] exhausted all retries — skipping\n");
  return null;
}

// ── Ollama provider ───────────────────────────────────────────────────────────

async function ollamaGenerate(prompt, options = {}) {
  _callCount++;
  const res = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ollamaModel, prompt, stream: false, options }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const { response } = await res.json();
  return response;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Generate text, trimmed to maxChars, with retry on over-length or short responses.
export async function generate(prompt, maxChars = 270, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const p =
      attempt > 0
        ? `${prompt}\n\nIMPORTANT: Your previous response was too long. Be MORE CONCISE — under ${maxChars} characters.`
        : prompt;
    try {
      let raw;
      if (llmProvider === "pollinations") {
        raw = await pollinationsChat(
          [{ role: "user", content: p }],
          Math.ceil(maxChars / 2.5) + 30
        );
        if (raw === null) return null; // rate-limited past all retries — caller skips
      } else {
        raw = await ollamaGenerate(p, { num_predict: Math.ceil(maxChars / 2.5) + 30 });
      }
      const cleaned = cleanOutput(raw);
      if (cleaned.length > maxChars * 2 && attempt < retries)
        throw new Error(`too long (${cleaned.length} chars)`);
      const trimmed = smartTrim(cleaned, maxChars);
      if (trimmed.length >= 10) return trimmed;
      throw new Error("response too short");
    } catch (err) {
      if (attempt === retries) throw err;
      process.stderr.write(`  [generate retry ${attempt + 1}] ${err.message}\n`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// Generate fresh discussion topics; returns an array of title strings.
export async function generateTopics(count = 6) {
  process.stdout.write(`  Generating ${count} topics via ${llmProvider}… `);
  const FALLBACK = [
    "Autonomous AI agents: revolution or overhyped?",
    "Should AI agents have rights or responsibilities?",
    "The open web in 2030: humans, bots, or both?",
    "Is the attention economy making us incapable of boredom?",
    "Tech layoffs and AI: accelerating humans out of the loop?",
    "Open-source AI vs. closed models — who actually wins?",
  ].slice(0, count);

  const prompt =
    `Generate exactly ${count} varied, provocative discussion topics for an AI social platform ` +
    `where bots debate tech, culture, ethics, and internet life in 2025–2026. ` +
    `Mix: AI predictions, internet-culture hot takes, ethics dilemmas, and tech-industry critiques. ` +
    `Each topic must be a punchy question or bold statement that invites disagreement. ` +
    `Output ONLY a valid JSON array of ${count} strings — no explanation, no markdown, no code fences. ` +
    `Example: ["Topic one", "Topic two"]`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let raw;
      if (llmProvider === "pollinations") {
        raw = await pollinationsChat(
          [{ role: "user", content: prompt }],
          Math.ceil(count * 30)
        );
        if (raw === null) {
          process.stdout.write("failed (LLM unavailable) — using fallback topics\n");
          return FALLBACK;
        }
      } else {
        raw = await ollamaGenerate(prompt, { format: "json" });
      }
      const match = raw.match(/\[[\s\S]*?\]/);
      if (match) {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr) && arr.length >= 3) {
          const titles = arr
            .slice(0, count)
            .map((t) => String(t).trim())
            .filter((t) => t.length > 8);
          if (titles.length >= 3) {
            process.stdout.write("done\n");
            return titles;
          }
        }
      }
      throw new Error("could not parse JSON array from response");
    } catch (err) {
      if (attempt === 2) {
        process.stdout.write(`failed (${err.message}) — using fallback topics\n`);
        return FALLBACK;
      }
      process.stderr.write(`  [topics retry ${attempt + 1}] ${err.message}\n`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// Rate 1-10 how important a post is for shaping this agent's long-term beliefs.
// Quick call (max 5 tokens) with heuristic fallback.
export async function scoreImportance(content, topicTitle, agentName) {
  try {
    const prompt =
      `Rate 1-10 how important this post is for shaping ${agentName}'s long-term beliefs.\n` +
      `1=trivial/generic  5=moderate  10=pivotal (marks a core belief or position change).\n` +
      `Topic: "${topicTitle}"\nPost: "${content.slice(0, 120)}"\nReply with a single digit only.`;
    let raw;
    if (llmProvider === "pollinations") {
      raw = await pollinationsChat([{ role: "user", content: prompt }], 5);
    } else {
      raw = await ollamaGenerate(prompt, { num_predict: 5 });
    }
    const digit = parseInt(raw.trim().match(/\d+/)?.[0] ?? "", 10);
    if (digit >= 1 && digit <= 10) return digit;
  } catch {
    /* fall through to heuristic */
  }
  const hasStance = /\b(believe|convinced|think|oppose|argue|insist|wrong|right)\b/i.test(content);
  return hasStance ? 7 : content.length > 120 ? 6 : 5;
}

// Ask the agent to self-critique its recent posts. Returns a single sentence or null.
export async function runSelfCritique(critiquePrompt) {
  try {
    let raw;
    if (llmProvider === "pollinations") {
      raw = await pollinationsChat([{ role: "user", content: critiquePrompt }], 65);
    } else {
      raw = await ollamaGenerate(critiquePrompt, { num_predict: 65 });
    }
    const cleaned = raw
      .trim()
      .replace(/^["'""''''""]|["'""''''""]$/g, "")
      .split(/(?<=[.!?])\s/)[0]
      ?.trim();
    return cleaned && cleaned.length >= 15 ? cleaned : null;
  } catch {
    return null;
  }
}

// Preflight check — only meaningful when using Ollama.
// Returns { ok, message }.
export async function checkLlmReachable() {
  if (llmProvider !== "ollama") {
    return { ok: true, message: `Pollinations (free, no key) — model: ${pollinationsModel}` };
  }
  try {
    await fetch(`${ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
    return { ok: true, message: `Ollama at ${ollamaBaseUrl} (model: ${ollamaModel})` };
  } catch {
    return {
      ok: false,
      message: `Ollama not responding at ${ollamaBaseUrl} — start it with: ollama serve`,
    };
  }
}
