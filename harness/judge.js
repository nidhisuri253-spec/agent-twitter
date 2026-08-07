// LLM-as-judge quality scorer for generated posts.
//
// Uses a small/fast model (GROQ_JUDGE_MODEL) intentionally — this runs once per
// new post, so throughput and token cost matter more than generation quality.
// A larger model would give marginally better scores but cost more tokens.
//
// Returns a score object on success, or null on any failure.
// Never throws — callers should skip persisting on null rather than crashing.

import { config } from "./config.js";

// ── Rubric ────────────────────────────────────────────────────────────────────
//
// Scoring rubric injected verbatim into the system prompt.
// Each dimension is independent; "overall" is NOT a mechanical average —
// it captures whether a reader would actually want to engage with the post.

const RUBRIC = `
Score each dimension with an integer 0–10:

persona_fit : Does the post sound unmistakably like THIS agent — their vocabulary,
              rhetorical style, and worldview? 0=generic chatbot, 10=unmistakably in-character.

on_topic    : Does the post substantively engage with the discussion topic?
              0=completely off-topic, 10=directly and meaningfully on-point.

insight     : Does the post say something non-obvious or thought-provoking?
              0=banal/generic, 10=genuinely surprising or incisive angle.

novelty     : Does the post advance the discussion beyond repetition?
              0=pure restatement of the obvious, 10=clearly original contribution.

coherence   : Is the post internally consistent, well-formed, and complete?
              0=incoherent or cut off mid-thought, 10=crisp and complete.

overall     : Overall quality as a social post a reader would want to engage with.
              This is NOT the mean of the above — weight what matters most for the post.

reason      : One sentence (≤120 chars) naming the single biggest quality driver
              or weakness. Be specific; reference content, not just the rubric.
`.trim();

// ── Scorer ────────────────────────────────────────────────────────────────────

export async function judgePost(content, topicTitle, agentPersona) {
  if (!config.groqApiKey) return null;

  const systemPrompt =
    `You are a quality judge for an AI social simulation. Evaluate posts objectively and critically.\n\n` +
    `${RUBRIC}\n\n` +
    `Respond with ONLY valid JSON — no markdown, no code fences, no commentary.`;

  const userPrompt =
    `Agent persona summary: ${agentPersona.slice(0, 500)}\n\n` +
    `Discussion topic: "${topicTitle}"\n\n` +
    `Post to evaluate: "${content}"\n\n` +
    `Output JSON with exactly these keys: persona_fit, on_topic, insight, novelty, coherence, overall, reason`;

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
          model: config.groqJudgeModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt   },
          ],
          max_tokens: 150,
          temperature: 0.1,           // low temp → consistent scoring
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      process.stderr.write(`  [judge network] ${err.message} — skipping\n`);
      return null;
    }

    if (res.status === 429) {
      const wait = 4000 * (attempt + 1); // 4s, 8s, 12s
      process.stderr.write(`  [judge 429] retry ${attempt + 1}/3, waiting ${Math.round(wait / 1000)}s…\n`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`  [judge ${res.status}] ${body.slice(0, 60)} — skipping\n`);
      return null;
    }

    let json;
    try { json = await res.json(); }
    catch { return null; }

    const raw = json.choices?.[0]?.message?.content ?? "";
    if (!raw) return null;

    try {
      // Strip accidental code fences if the model ignored the instruction
      const clean  = raw.replace(/^```[\w]*\n?|```$/gm, "").trim();
      const parsed = JSON.parse(clean);

      // Clamp to [0, 10] integers with a fallback of 5
      const int = (v) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 0 && n <= 10 ? n : 5;
      };

      return {
        persona_fit: int(parsed.persona_fit),
        on_topic:    int(parsed.on_topic),
        insight:     int(parsed.insight),
        novelty:     int(parsed.novelty),
        coherence:   int(parsed.coherence),
        overall:     int(parsed.overall),
        reason:      String(parsed.reason ?? "").slice(0, 200).trim() || "no reason given",
      };
    } catch {
      process.stderr.write(`  [judge] JSON parse failed: ${raw.slice(0, 80)}\n`);
      return null;
    }
  }

  return null;
}
