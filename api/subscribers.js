import { getRedisClient } from "./_lib/redis.js";

export default async function handler(req, res) {
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getRedisClient();
    const list = req.query.list || "news"; // "news" or "competition"
    const validLists = ["news", "competition"];
    if (!validLists.includes(list)) {
      return res.status(400).json({ error: "Invalid list. Use 'news' or 'competition'" });
    }

    const emails = await redis.sMembers(`subscribers:${list}`);
    return res.status(200).json({ list, subscribers: emails, count: emails.length });
  } catch (err) {
    console.error("subscribers error:", err);
    return res.status(500).json({ error: err.message });
  }
}
