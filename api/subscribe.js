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

  const { email } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  try {
    const redis = await getClient();
    const normalised = email.toLowerCase().trim();

    // Check if already subscribed
    const exists = await redis.sIsMember("subscribers", normalised);
    if (exists) {
      return res.status(200).json({ message: "already_subscribed" });
    }

    // Add to subscribers set
    await redis.sAdd("subscribers", normalised);

    return res.status(200).json({ message: "subscribed" });
  } catch (err) {
    console.error("subscribe error:", err);
    return res.status(500).json({ error: err.message });
  }
}
