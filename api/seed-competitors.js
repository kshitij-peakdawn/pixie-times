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

const TRACKED_CARDS = [
  { id: "amazon-pay-icici",  name: "Amazon Pay Credit Card",  issuer: "ICICI Bank" },
  { id: "simplyclick-sbi",   name: "SBI SimplyCLICK",         issuer: "SBI Card" },
  { id: "flipkart-axis",     name: "Flipkart Axis Bank Card", issuer: "Axis Bank" },
  { id: "millennia-idfc",    name: "IDFC FIRST Millennia",    issuer: "IDFC FIRST Bank" },
  { id: "onecard",           name: "OneCard",                  issuer: "SBM Bank" },
  { id: "kotak-811",         name: "Kotak 811 Credit Card",   issuer: "Kotak Mahindra Bank" },
  { id: "slice",             name: "Slice Credit Card",       issuer: "North East SFB" },
  { id: "fi-money",          name: "Fi Money Credit Card",    issuer: "Federal Bank" },
  { id: "niyo-global",       name: "Niyo Global Card",        issuer: "SBM / DCB Bank" },
];

// Known current features as of April 2026 — Claude will validate and fill gaps
const SEED_PROMPT = `You are a competitive intelligence analyst for Pixel Credit Card (HDFC Bank) — a digital-first, cashback-led card targeting Gen Z and young professionals.

Populate the current feature profile for each of these Indian credit cards. Use your training knowledge. Be accurate and specific. If a detail is genuinely unknown, use null.

Cards to profile:
${TRACKED_CARDS.map(c => `- ${c.name} (${c.issuer}) [id: ${c.id}]`).join('\n')}

For each card, return a JSON array with this exact shape:
[
  {
    "id": "<card id from above>",
    "name": "<full card name>",
    "issuer": "<issuer name>",
    "joiningFee": "<amount with ₹ symbol or 'Nil'>",
    "annualFee": "<amount with ₹ symbol or 'Nil'>",
    "feeWaiverThreshold": "<annual spend needed to waive fee, e.g. ₹2 lakh or 'N/A'>",
    "primaryReward": "<main cashback or reward mechanic, one line>",
    "rewardCap": "<monthly or annual cap on rewards, or 'None'>",
    "loungeAccess": "<Yes – unlimited / Yes – N per quarter / No>",
    "keyDifferentiator": "<one sentence on what makes this card unique in its segment>",
    "lastUpdated": "Apr 2026"
  }
]

Return ONLY the JSON array. No explanation, no markdown, no preamble.`;

export default async function handler(req, res) {
  // Protect — only callable manually
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();

    // Check if already seeded — don't overwrite unless forced
    const force = req.query.force === "true";
    if (!force) {
      const existing = await redis.get(`card:${TRACKED_CARDS[0].id}`);
      if (existing) {
        return res.status(200).json({
          message: "Cards already seeded. Pass ?force=true to reseed.",
          tip: "Use /api/refresh-competitors to update from live news instead."
        });
      }
    }

    console.log("Calling Claude to seed card profiles...");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{ role: "user", content: SEED_PROMPT }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const profiles = JSON.parse(clean);

    if (!Array.isArray(profiles) || profiles.length === 0) {
      return res.status(500).json({ error: "Claude returned no profiles", raw: text });
    }

    // Save each card profile to Redis
    const index = TRACKED_CARDS.map(c => c.id);
    await redis.set("cards:index", JSON.stringify(index));

    for (const profile of profiles) {
      await redis.set(`card:${profile.id}`, JSON.stringify(profile));
      // Initialise empty changelog if none exists
      const existingLog = await redis.get(`card:${profile.id}:changelog`);
      if (!existingLog) {
        await redis.set(`card:${profile.id}:changelog`, JSON.stringify([]));
      }
    }

    return res.status(200).json({
      message: "Cards seeded successfully",
      count: profiles.length,
      cards: profiles.map(p => p.name),
    });
  } catch (err) {
    console.error("Seed error:", err);
    return res.status(500).json({ error: err.message });
  }
}
