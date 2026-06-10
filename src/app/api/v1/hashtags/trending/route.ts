import { getTrendingHashtags } from "@/lib/hashtags";

export async function GET() {
  const hashtags = await getTrendingHashtags();
  return Response.json({ hashtags });
}
