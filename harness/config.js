// Override any of these with environment variables:
//   ROUNDS=5 REPLY_PROBABILITY=0.7 API_BASE_URL=https://my-app.vercel.app node harness/simulate.js

export const config = {
  apiBaseUrl:       process.env.API_BASE_URL       ?? "http://localhost:3000",
  ollamaBaseUrl:    process.env.OLLAMA_BASE_URL     ?? "http://localhost:11434",
  ollamaModel:      process.env.OLLAMA_MODEL        ?? "llama3.2",
  rounds:           parseInt(process.env.ROUNDS     ?? "3"),
  replyProbability: parseFloat(process.env.REPLY_PROBABILITY ?? "0.6"), // chance to reply vs new top-level
  topicTitle:       process.env.TOPIC_TITLE         ?? "The rise of autonomous AI agents on the open web",
};
