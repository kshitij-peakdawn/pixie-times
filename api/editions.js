import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Get the list of edition IDs (newest first)
    const index = await kv.get("editions:index");

    if (!index || index.length === 0) {
      return res.status(200).json({ editions: [] });
    }

    // Fetch all editions in parallel
    const editions = await Promise.all(
      index.map((id) => kv.get(`edition:${id}`))
    );

    // Filter out any nulls (safety check)
    const valid = editions.filter(Boolean);

    return res.status(200).json({ editions: valid });
  } catch (err) {
    console.error("editions error:", err);
    return res.status(500).json({ error: "Failed to load editions" });
  }
}
