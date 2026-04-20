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

  const { email, lists } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  // Default both to true if not provided
  const wantsNews        = lists?.news        !== false;
  const wantsCompetition = lists?.competition !== false;

  if (!wantsNews && !wantsCompetition) {
    return res.status(400).json({ error: "Please select at least one newsletter." });
  }

  try {
    const redis = await getClient();
    const normalised = email.toLowerCase().trim();
    const key = `subscriber:${normalised}`;

    const existing = await redis.get(key);
    const existingData = existing ? JSON.parse(existing) : null;

    const data = {
      news:        wantsNews,
      competition: wantsCompetition,
      subscribedAt: existingData?.subscribedAt || new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    };

    // Save preference record
    await redis.set(key, JSON.stringify(data));

    // Sync news set
    if (data.news) {
      await redis.sAdd("subscribers:news", normalised);
    } else {
      await redis.sRem("subscribers:news", normalised);
    }

    // Sync competition set — always write both add and remove to be explicit
    if (data.competition) {
      await redis.sAdd("subscribers:competition", normalised);
    } else {
      await redis.sRem("subscribers:competition", normalised);
    }

    const message = existingData ? "already_subscribed" : "subscribed";
    return res.status(200).json({ message, lists: data });
  } catch (err) {
    console.error("subscribe error:", err);
    return res.status(500).json({ error: err.message });
  }
}
