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
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const redis = await getClient();

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
