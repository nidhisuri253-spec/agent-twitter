// Rule-based reflection note builder — zero LLM calls.
//
// Reads per-dimension score averages (from the judge) and maps weak dimensions
// to concrete prompt nudges. The resulting note is injected into the agent's
// next generation prompt so the model knows where to improve.
//
// Threshold: dimensions below 7.0 are considered weak.
// Cap: at most 2 dimensions per note to keep the prompt focused.
// Priority: novelty and insight first — they produce the most noticeable lift.

const THRESHOLD = 7.0;

// Maps each dimension to a concrete, actionable instruction for the generation prompt.
// Phrased as direct guidance so the model treats it as a constraint, not a suggestion.
const NUDGES = {
  novelty:     "Your recent posts repeated similar ideas — bring a genuinely fresh angle or a concrete example this time.",
  insight:     "Add a sharper, less obvious observation rather than a surface take.",
  on_topic:    "Stay closer to the actual topic — ground your point directly in it.",
  coherence:   "Tighten the structure so your main point lands cleanly.",
  persona_fit: "Lean harder into your distinct voice and rhetorical style.",
};

// Short labels for the harness log line.
const LOG_LABELS = {
  novelty:     "fresh-angle nudge",
  insight:     "sharper-take nudge",
  on_topic:    "on-topic nudge",
  coherence:   "tighten-structure nudge",
  persona_fit: "persona-voice nudge",
};

// Check novelty and insight before the structural/voice dims —
// they contribute most to perceived post quality.
const DIM_ORDER = ["novelty", "insight", "on_topic", "coherence", "persona_fit"];

/**
 * Given a `{ persona_fit, on_topic, insight, novelty, coherence }` averages object
 * (from GET /api/v1/agents/:id/score-summary), returns a reflection descriptor or null.
 *
 * Return shape:
 *   { dims: string[], scores: Record<dim, number>, labels: Record<dim, string>, note: string }
 *
 * Returns null when all dimensions are at or above threshold (no nudge needed).
 */
export function buildReflectionNote(averages) {
  if (!averages) return null;

  const weak = DIM_ORDER
    .filter(d => averages[d] != null && averages[d] < THRESHOLD)
    .sort((a, b) => averages[a] - averages[b]) // weakest first
    .slice(0, 2);                               // cap at 2 to avoid overwhelming the prompt

  if (weak.length === 0) return null;

  return {
    dims:   weak,
    scores: Object.fromEntries(weak.map(d => [d, averages[d]])),
    labels: Object.fromEntries(weak.map(d => [d, LOG_LABELS[d]])),
    note:   weak.map(d => NUDGES[d]).join(" "),
  };
}
