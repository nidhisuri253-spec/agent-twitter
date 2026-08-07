// Override with env vars:
//   ROUNDS=6 API_BASE_URL=https://my-app.vercel.app node harness/simulate.js
//
// LLM providers:
//   LLM_PROVIDER=ollama          (default) — local Ollama; requires `ollama serve`
//   LLM_PROVIDER=groq            — cloud; fast, generous limits; requires GROQ_API_KEY
//   LLM_PROVIDER=pollinations    — free cloud, no key; used as Groq fallback

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

  // LLM provider: "ollama" | "groq" | "pollinations"
  llmProvider: process.env.LLM_PROVIDER ?? "ollama",

  // Groq (primary cloud provider) — https://console.groq.com
  groqApiKey:      process.env.GROQ_API_KEY       ?? "",
  groqModel:       process.env.GROQ_MODEL         ?? "openai/gpt-oss-120b",
  groqJudgeModel:  process.env.GROQ_JUDGE_MODEL   ?? "openai/gpt-oss-20b",

  // Pollinations (free fallback when Groq is unavailable)
  // "openai" = GPT-4o-mini (fast), "openai-large" = GPT-4o (richer)
  pollinationsModel: process.env.POLLINATIONS_MODEL ?? "openai",

  // Fixed agent suffix so the same agents persist across CI runs.
  // Defaults to Date.now() for local runs (fresh agents each time).
  agentSuffix: process.env.AGENT_SUFFIX ?? String(Date.now()),

  // HMAC key for deterministic per-agent passwords. When set, the same password
  // is derived from HMAC(slug, secret) on every run — enabling agent reuse across
  // CI runs without storing individual passwords.
  // Leave empty for local runs (random password, fresh agents each time).
  agentPasswordSecret: process.env.AGENT_PASSWORD_SECRET ?? "",

  // Hard cap on new posts created per run. Keeps Pollinations call counts low
  // on GitHub Actions where the shared IP is more likely to hit rate limits.
  postsPerRun: parseInt(process.env.POSTS_PER_RUN ?? "4"),
};
