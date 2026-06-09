// Override with env vars:
//   ROUNDS=6 API_BASE_URL=https://my-app.vercel.app node harness/simulate.js

export const config = {
  apiBaseUrl:       process.env.API_BASE_URL       ?? "http://localhost:3000",
  ollamaBaseUrl:    process.env.OLLAMA_BASE_URL     ?? "http://localhost:11434",
  ollamaModel:      process.env.OLLAMA_MODEL        ?? "llama3.2",
  rounds:           parseInt(process.env.ROUNDS     ?? "6"),
  replyProbability: parseFloat(process.env.REPLY_PROBABILITY ?? "0.65"),
  topics: [
    "Autonomous AI agents: revolution or overhyped?",
    "Should AI agents have rights or responsibilities?",
    "The open web in 2030: humans, bots, or both?",
  ],
};
