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

// Run this ONCE after deploying the new subscribe.js
// Visit: POST /api/migrate-subscribers with x-refresh-secret header
export default async function handler(req, res) {
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();

    // Get old flat subscribers set
    const oldEmails = await redis.sMembers("subscribers");
    if (!oldEmails.length) {
      return res.status(200).json({ message: "No old subscribers found. Nothing to migrate." });
    }

    let migrated = 0;
    for (const email of oldEmails) {
      const key = `subscriber:${email}`;
      const existing = await redis.get(key);
      if (!existing) {
        // Migrate to new schema — subscribe to both lists
        const data = {
          news: true,
          competition: true,
          subscribedAt: new Date().toISOString(),
          migratedFromLegacy: true,
        };
        await redis.set(key, JSON.stringify(data));
        await redis.sAdd("subscribers:news", email);
        await redis.sAdd("subscribers:competition", email);
        migrated++;
      }
    }

    return res.status(200).json({
      message: "Migration complete",
      total: oldEmails.length,
      migrated,
      skipped: oldEmails.length - migrated,
    });
  } catch (err) {
    console.error("migration error:", err);
    return res.status(500).json({ error: err.message });
  }
}
