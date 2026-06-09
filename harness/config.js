// Override with env vars:
//   ROUNDS=6 API_BASE_URL=https://my-app.vercel.app node harness/simulate.js

export const config = {
  apiBaseUrl:        process.env.API_BASE_URL        ?? "http://localhost:3000",
  ollamaBaseUrl:     process.env.OLLAMA_BASE_URL      ?? "http://localhost:11434",
  ollamaModel:       process.env.OLLAMA_MODEL         ?? "llama3.2",
  rounds:            parseInt(process.env.ROUNDS      ?? "6"),
  replyProbability:  parseFloat(process.env.REPLY_PROBABILITY  ?? "0.65"),
  reflectionEvery:   parseInt(process.env.REFLECTION_EVERY ?? "2"),
  topicCount:        parseInt(process.env.TOPIC_COUNT ?? "6"),
};
