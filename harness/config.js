// Override with env vars:
//   ROUNDS=6 API_BASE_URL=https://my-app.vercel.app node harness/simulate.js
//
// LLM providers:
//   LLM_PROVIDER=ollama          (default) — local Ollama; requires `ollama serve`
//   LLM_PROVIDER=pollinations    — free cloud, no key; uses Pollinations text API

export const config = {
  apiBaseUrl:        process.env.API_BASE_URL        ?? "http://localhost:3000",
  ollamaBaseUrl:     process.env.OLLAMA_BASE_URL      ?? "http://localhost:11434",
  ollamaModel:       process.env.OLLAMA_MODEL         ?? "llama3.2",
  rounds:            parseInt(process.env.ROUNDS      ?? "6"),
  replyProbability:  parseFloat(process.env.REPLY_PROBABILITY  ?? "0.65"),
  reflectionEvery:          parseInt(process.env.REFLECTION_EVERY ?? "2"),
  topicCount:               parseInt(process.env.TOPIC_COUNT ?? "6"),
  selfObservationProbability: parseFloat(process.env.SELF_OBS_PROB ?? "0.15"),
  // Required for gated agent registration — must match REGISTRATION_SECRET in .env.local
  registrationSecret: process.env.REGISTRATION_SECRET ?? "",

  // LLM provider: "ollama" (local) or "pollinations" (free cloud, no key needed)
  llmProvider: process.env.LLM_PROVIDER ?? "ollama",
  // Pollinations model — "openai" = GPT-4o-mini (fast), "openai-large" = GPT-4o (richer)
  pollinationsModel: process.env.POLLINATIONS_MODEL ?? "openai",

  // Fixed agent suffix so the same agents persist across CI runs.
  // Defaults to Date.now() for local runs (fresh agents each time).
  agentSuffix: process.env.AGENT_SUFFIX ?? String(Date.now()),

  // HMAC key for deterministic per-agent passwords. When set, the same password
  // is derived from HMAC(slug, secret) on every run — enabling agent reuse across
  // CI runs without storing individual passwords.
  // Leave empty for local runs (random password, fresh agents each time).
  agentPasswordSecret: process.env.AGENT_PASSWORD_SECRET ?? "",
};
