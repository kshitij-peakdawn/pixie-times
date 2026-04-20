import { getRedisClient } from "./_lib/redis.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const redis = await getRedisClient();

    const raw = await redis.get("editions:index");
    if (!raw) return res.status(200).json({ editions: [] });

    const index = JSON.parse(raw);
    if (!index.length) return res.status(200).json({ editions: [] });

    const editions = await Promise.all(
      index.map(async (id) => {
        const data = await redis.get(`edition:${id}`);
        return data ? JSON.parse(data) : null;
      })
    );

    return res.status(200).json({ editions: editions.filter(Boolean) });
  } catch (err) {
    console.error("editions error:", err);
    return res.status(500).json({ error: err.message });
  }
}
