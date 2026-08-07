// Provider-agnostic LLM module.
// LLM_PROVIDER=groq   — Groq cloud; requires GROQ_API_KEY
// LLM_PROVIDER=ollama — local Ollama (default for local runs)
//
// Groq failures throw rather than falling back to another provider, so
// callers fail loudly and this stays a $0 setup.
import { config } from "./config.js";

const { llmProvider, ollamaBaseUrl, ollamaModel } = config;

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

// ── Groq provider ─────────────────────────────────────────────────────────────
// OpenAI-compatible chat completions via api.groq.com.
// Model: config.groqModel (see config.js / GROQ_MODEL env var).
// Throws on any failure — no fallback provider, so callers see the real error.

async function groqChat(messages, maxTokens = 200) {
  if (!config.groqApiKey) throw new Error("GROQ_API_KEY is not set");

  _callCount++;
  const isFirstCall = _callCount === 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.groqApiKey}`,
        },
        body: JSON.stringify({
          model: config.groqModel,
          messages,
          max_tokens: maxTokens,
          // Qwen3 models think by default on Groq — "none" disables it so
          // `content` holds the plain answer instead of a reasoning trace.
          // Not a valid value for other families (e.g. gpt-oss takes
          // low/medium/high), so only set it for Qwen.
          ...(config.groqModel.startsWith("qwen/") ? { reasoning_effort: "none" } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Groq network error: ${err.message}`);
    }

    if (res.status === 429) {
      const wait = 5000 * (attempt + 1); // 5s, 10s, 15s
      process.stderr.write(`  [Groq 429] retry ${attempt + 1}/3, waiting ${Math.round(wait / 1000)}s…\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`  [Groq ${res.status}] ${body.slice(0, 200)}\n`);
      throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    if (isFirstCall) {
      process.stderr.write(`  [Groq raw response]\n${JSON.stringify(json, null, 2)}\n`);
    }

    // Reasoning models (e.g. openai/gpt-oss-*) may put the answer in a
    // separate `reasoning` field, or wrap it in <think>...</think> inside
    // `content` — strip the think-trace and fall back to `reasoning` if
    // `content` has nothing left after stripping.
    const msg = json.choices?.[0]?.message;
    const content = (msg?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const text = content || (msg?.reasoning ?? "").trim();

    if (!text) {
      if (!isFirstCall) {
        process.stderr.write(`  [Groq] empty response — full payload:\n${JSON.stringify(json, null, 2)}\n`);
      }
      throw new Error("Groq returned an empty response");
    }
    return text;
  }

  throw new Error("Groq: exhausted retries (429)");
}

// ── Provider dispatch ──────────────────────────────────────────────────────────
// Single entry-point for cloud generation. Ollama is handled separately.

async function chatCompletion(messages, maxTokens = 200) {
  return groqChat(messages, maxTokens);
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
      if (llmProvider === "ollama") {
        raw = await ollamaGenerate(p, { num_predict: Math.ceil(maxChars / 2.5) + 30 });
      } else {
        raw = await chatCompletion(
          [{ role: "user", content: p }],
          Math.ceil(maxChars / 2.5) + 30
        );
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
      if (llmProvider === "ollama") {
        raw = await ollamaGenerate(prompt, { format: "json" });
      } else {
        raw = await chatCompletion(
          [{ role: "user", content: prompt }],
          Math.ceil(count * 30)
        );
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
        process.stdout.write(`failed: ${err.message}\n`);
        throw new Error(`Topic generation failed after 3 attempts: ${err.message}`);
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
    if (llmProvider === "ollama") {
      raw = await ollamaGenerate(prompt, { num_predict: 5 });
    } else {
      raw = await chatCompletion([{ role: "user", content: prompt }], 5);
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
    if (llmProvider === "ollama") {
      raw = await ollamaGenerate(critiquePrompt, { num_predict: 65 });
    } else {
      raw = await chatCompletion([{ role: "user", content: critiquePrompt }], 65);
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

// Preflight check — verifies the active provider is usable.
// Returns { ok, message }.
export async function checkLlmReachable() {
  if (llmProvider === "groq") {
    if (!config.groqApiKey) {
      return { ok: false, message: "GROQ_API_KEY is not set — set it or switch LLM_PROVIDER=ollama" };
    }
    return {
      ok: true,
      message: `Groq (model: ${config.groqModel})`,
    };
  }
  // Ollama
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
