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
// Step 0 fixes unsubscribe bug: legacy emails stored with mixed case couldn't be removed.
export default async function handler(req, res) {
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();
    const results = { normalisedEmails: 0, migratedFromLegacy: 0, syncedToCompetition: 0, alreadyCorrect: 0 };

    // Step 0: Normalise all email casing across all sets and preference records.
    // Fixes the unsubscribe bug where legacy emails were stored with mixed case,
    // causing sRem("subscribers:news", "user@hdfc.com") to miss "User@HDFC.com".
    for (const setKey of ["subscribers", "subscribers:news", "subscribers:competition"]) {
      const members = await redis.sMembers(setKey);
      for (const email of members) {
        const normalised = email.toLowerCase().trim();
        if (normalised !== email) {
          await redis.sRem(setKey, email);
          await redis.sAdd(setKey, normalised);
          // Migrate preference record key if stored under old casing
          const oldKey = `subscriber:${email}`;
          const newKey = `subscriber:${normalised}`;
          const existingOld = await redis.get(oldKey);
          const existingNew = await redis.get(newKey);
          if (existingOld && !existingNew) {
            await redis.set(newKey, existingOld);
            await redis.del(oldKey);
          }
          results.normalisedEmails++;
        }
      }
    }

    // Step 1: Migrate from old flat "subscribers" set (legacy)
    const oldEmails = await redis.sMembers("subscribers");
    for (const email of oldEmails) {
      const normalised = email.toLowerCase().trim();
      const key = `subscriber:${normalised}`;
      const existing = await redis.get(key);
      if (!existing) {
        const data = {
          news: true,
          competition: true,
          subscribedAt: new Date().toISOString(),
          migratedFromLegacy: true,
        };
        await redis.set(key, JSON.stringify(data));
        await redis.sAdd("subscribers:news", normalised);
        await redis.sAdd("subscribers:competition", normalised);
        results.migratedFromLegacy++;
      }
    }

    // Step 2: Sync anyone in subscribers:news who has a preference record
    // but is missing from subscribers:competition
    const newsMembers = await redis.sMembers("subscribers:news");
    for (const email of newsMembers) {
      const key = `subscriber:${email}`;
      const raw = await redis.get(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.competition !== false) {
          const inCompSet = await redis.sIsMember("subscribers:competition", email);
          if (!inCompSet) {
            await redis.sAdd("subscribers:competition", email);
            results.syncedToCompetition++;
          } else {
            results.alreadyCorrect++;
          }
        }
      } else {
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
