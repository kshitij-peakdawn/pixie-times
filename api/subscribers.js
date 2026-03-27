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

export default async function handler(req, res) {
  // Protect this endpoint — only Apps Script should call it
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();
    const emails = await redis.sMembers("subscribers");
    return res.status(200).json({ subscribers: emails, count: emails.length });
  } catch (err) {
    console.error("subscribers error:", err);
    return res.status(500).json({ error: err.message });
  }
}
