import { getTrendingTopics } from "@/lib/trending";

export async function GET() {
  const topics = await getTrendingTopics();
  return Response.json({ topics });
}
