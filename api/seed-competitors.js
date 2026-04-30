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
  { id: "pixel-hdfc",        name: "Pixel Play",               issuer: "HDFC Bank",          isOwnCard: true },
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

Populate the current feature profile for each of these Indian credit cards. Include Pixel Play (HDFC Bank) as the first card — this is our own card and serves as the reference baseline. Use your training knowledge. Be accurate and specific. If a detail is genuinely unknown, use null.

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
    "isOwnCard": <true only for Pixel Play, omit or false for all others>,
    "activeOffer": null,
    "lastUpdated": "Apr 2026"
  }
]

For activeOffer: if you are aware of a current limited-time offer (LTF, waived fee, bonus cashback) for a card as of April 2026, populate it as: {"label": "<short label>", "type": "<ltf|bonus|waiver|accelerated>", "expiresOn": "<date or null>", "source": "Seed data"}. Otherwise set to null.
Return ONLY the JSON array. No explanation, no markdown, no preamble.`;

export default async function handler(req, res) {
  // Protect — only callable manually
  const secret = req.headers["x-refresh-secret"];
  if (secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = await getClient();

    // Optional: seed only a specific card e.g. ?card=pixel-hdfc
    const cardFilter = req.query.card || null;
    const cardsToSeed = cardFilter
      ? TRACKED_CARDS.filter(c => c.id === cardFilter)
      : TRACKED_CARDS;

    if (cardsToSeed.length === 0) {
      return res.status(400).json({ error: `Card '${cardFilter}' not found in tracked list.` });
    }

    // Skip already-seeded cards unless ?force=true
    const force = req.query.force === "true";
    const cardsNeedingSeeed = force
      ? cardsToSeed
      : await Promise.all(cardsToSeed.map(async c => {
          const existing = await redis.get(`card:${c.id}`);
          return existing ? null : c;
        })).then(results => results.filter(Boolean));

    if (cardsNeedingSeeed.length === 0) {
      return res.status(200).json({
        message: "All specified cards already seeded. Pass ?force=true to overwrite.",
        tip: "Use /api/refresh-competitors to update from live news instead."
      });
    }

    // Build a targeted prompt for only the cards that need seeding
    const targetedPrompt = SEED_PROMPT.replace(
      TRACKED_CARDS.map(c => `- ${c.name} (${c.issuer}) [id: ${c.id}]`).join('
'),
      cardsNeedingSeeed.map(c => `- ${c.name} (${c.issuer}) [id: ${c.id}]`).join('
')
    );

    console.log(`Seeding ${cardsNeedingSeeed.length} card(s): ${cardsNeedingSeeed.map(c => c.name).join(', ')}`);

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
        messages: [{ role: "user", content: targetedPrompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const profiles = JSON.parse(clean);

    if (!Array.isArray(profiles) || profiles.length === 0) {
      return res.status(500).json({ error: "Claude returned no profiles", raw: text });
    }

    // Always update the cards:index to include all tracked cards
    const fullIndex = TRACKED_CARDS.map(c => c.id);
    await redis.set("cards:index", JSON.stringify(fullIndex));

    for (const profile of profiles) {
      await redis.set(`card:${profile.id}`, JSON.stringify(profile));
      // Initialise empty changelog only if none exists — never overwrite existing changelog
      const existingLog = await redis.get(`card:${profile.id}:changelog`);
      if (!existingLog) {
        await redis.set(`card:${profile.id}:changelog`, JSON.stringify([]));
      }
    }

    return res.status(200).json({
      message: "Seeded successfully",
      count: profiles.length,
      cards: profiles.map(p => p.name),
    });
  } catch (err) {
    console.error("Seed error:", err);
    return res.status(500).json({ error: err.message });
  }
}
