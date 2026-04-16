import { createClient } from "redis";

let client;
async function getClient() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (err) => console.error("Redis error:", err));
    await client.connect();
  }
  return client;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { email, lists = { news: true, competition: true } } = req.body;
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const redis = await getClient();
    const normalised = email.toLowerCase().trim();
    const key = `subscriber:${normalised}`;

    // Check if already exists
    const existing = await redis.get(key);
    const existingData = existing ? JSON.parse(existing) : null;

    if (existingData) {
      // Merge preferences — union of existing and new selections
      const merged = {
        news: existingData.news || lists.news,
        competition: existingData.competition || lists.competition,
        subscribedAt: existingData.subscribedAt,
        updatedAt: new Date().toISOString(),
      };
      await redis.set(key, JSON.stringify(merged));

      // Update list sets
      if (merged.news) await redis.sAdd("subscribers:news", normalised);
      if (merged.competition) await redis.sAdd("subscribers:competition", normalised);

      return res.status(200).json({ message: "already_subscribed", lists: merged });
    }

    // New subscriber
    const data = {
      news: lists.news === true,
      competition: lists.competition === true,
      subscribedAt: new Date().toISOString(),
    };
    await redis.set(key, JSON.stringify(data));
    if (data.news) await redis.sAdd("subscribers:news", normalised);
    if (data.competition) await redis.sAdd("subscribers:competition", normalised);

    return res.status(200).json({ message: "subscribed", lists: data });
  } catch (err) {
    console.error("subscribe error:", err);
    return res.status(500).json({ error: err.message });
  }
}
