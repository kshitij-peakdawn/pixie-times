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

// Run this once via POST /api/migrate-subscribers with x-refresh-secret header.
// Safe to run multiple times — it won't overwrite preferences already set.
// Also fixes subscribers who have preference records but are missing from competition set.
export default async function handler(req, res) {
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();
    const results = { migratedFromLegacy: 0, syncedToCompetition: 0, alreadyCorrect: 0 };

    // Step 1: Migrate from old flat "subscribers" set (legacy)
    const oldEmails = await redis.sMembers("subscribers");
    for (const email of oldEmails) {
      const key = `subscriber:${email}`;
      const existing = await redis.get(key);
      if (!existing) {
        const data = {
          news: true,
          competition: true,
          subscribedAt: new Date().toISOString(),
          migratedFromLegacy: true,
        };
        await redis.set(key, JSON.stringify(data));
        await redis.sAdd("subscribers:news", email);
        await redis.sAdd("subscribers:competition", email);
        results.migratedFromLegacy++;
      }
    }

    // Step 2: Sync anyone in subscribers:news who has a preference record
    // but is missing from subscribers:competition (the bug that caused issue 2)
    const newsMembers = await redis.sMembers("subscribers:news");
    for (const email of newsMembers) {
      const key = `subscriber:${email}`;
      const raw = await redis.get(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.competition !== false) {
          // Should be in competition set — add if missing
          const inCompSet = await redis.sIsMember("subscribers:competition", email);
          if (!inCompSet) {
            await redis.sAdd("subscribers:competition", email);
            results.syncedToCompetition++;
          } else {
            results.alreadyCorrect++;
          }
        }
      } else {
        // Has no preference record — create one with both true
        const data = { news: true, competition: true, subscribedAt: new Date().toISOString() };
        await redis.set(key, JSON.stringify(data));
        await redis.sAdd("subscribers:competition", email);
        results.syncedToCompetition++;
      }
    }

    // Report final counts
    const newsCount = await redis.sCard("subscribers:news");
    const compCount = await redis.sCard("subscribers:competition");

    return res.status(200).json({
      message: "Migration and sync complete",
      ...results,
      finalCounts: { news: newsCount, competition: compCount },
    });
  } catch (err) {
    console.error("migration error:", err);
    return res.status(500).json({ error: err.message });
  }
}
