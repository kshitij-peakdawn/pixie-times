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

// ── Competitive set — Pixel's segment ─────────────────────────────────────────
// Ordered by estimated customer base (decreasing)
const TRACKED_CARDS = [
  { id: "amazon-pay-icici",    name: "Amazon Pay Credit Card",  issuer: "ICICI Bank" },
  { id: "simplyclick-sbi",     name: "SBI SimplyCLICK",         issuer: "SBI Card" },
  { id: "flipkart-axis",       name: "Flipkart Axis Bank Card", issuer: "Axis Bank" },
  { id: "millennia-idfc",      name: "IDFC FIRST Millennia",    issuer: "IDFC FIRST Bank" },
  { id: "onecard",             name: "OneCard",                  issuer: "SBM Bank" },
  { id: "kotak-811",           name: "Kotak 811 Credit Card",   issuer: "Kotak Mahindra Bank" },
  { id: "slice",               name: "Slice Credit Card",       issuer: "North East SFB" },
  { id: "fi-money",            name: "Fi Money Credit Card",    issuer: "Federal Bank" },
  { id: "niyo-global",         name: "Niyo Global Card",        issuer: "SBM / DCB Bank" },
];

const RSS_FEEDS = [
  { name: "Economic Times Banking", url: "https://economictimes.indiatimes.com/industry/banking/finance/banking/rssfeeds/13358259.cms" },
  { name: "Business Standard",      url: "https://www.business-standard.com/rss/finance/news-10301.rss" },
  { name: "Livemint",               url: "https://www.livemint.com/rss/money" },
  { name: "Financial Express",      url: "https://www.financialexpress.com/market/rss" },
  { name: "Hindu BusinessLine",     url: "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWeekId(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getWeekNumber(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7) + 1;
}

function getQuarterLabel(date) {
  const d = new Date(date);
  const month = d.getMonth(); // 0-indexed
  const year = String(d.getFullYear()).slice(2);
  if (month <= 2) return `JFM'${year}`;
  if (month <= 5) return `AMJ'${year}`;
  if (month <= 8) return `JAS'${year}`;
  return `OND'${year}`;
}

function isEvery4thSunday(date) {
  const weekNum = getWeekNumber(date);
  return weekNum % 4 === 0;
}

function isQCRWeek(date) {
  const weekNum = getWeekNumber(date);
  return weekNum % 13 === 0;
}

function parseRSS(xml, sourceName) {
  const articles = [];
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (const item of items) {
    const get = (tag) => {
      const match = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`));
      return match ? (match[1] || match[2] || "").trim() : "";
    };
    const title = get("title");
    const description = get("description").replace(/<[^>]+>/g, "").trim();
    const url = get("link") || get("guid");
    const pubDate = get("pubDate");
    if (!title || !url) continue;
    articles.push({
      source: { name: sourceName },
      title, description: description || title, url,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }
  return articles;
}

// ── Step 1: Fetch articles ────────────────────────────────────────────────────
async function fetchArticles() {
  const allArticles = [];
  const oneMonthAgo = new Date();
  oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);

  // Build keyword list from tracked card names
  const cardKeywords = TRACKED_CARDS.flatMap(c => [
    c.name.toLowerCase(),
    c.issuer.toLowerCase(),
  ]);

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "PixieTimes/1.0 RSS Reader" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const articles = parseRSS(xml, feed.name);

      // Filter: must mention at least one tracked card or issuer
      const relevant = articles.filter(a => {
        const text = `${a.title} ${a.description}`.toLowerCase();
        return cardKeywords.some(kw => text.includes(kw));
      });

      allArticles.push(...relevant);
    } catch (err) {
      console.error(`Failed to fetch ${feed.name}:`, err.message);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return allArticles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// ── Step 2: Claude processes competitive news ─────────────────────────────────
async function processCompetitiveNews(articles, existingProfiles) {
  const cardList = TRACKED_CARDS.map(c => `- ${c.name} (${c.issuer})`).join("\n");
  const articleList = articles.map((a, i) =>
    `[${i + 1}] SOURCE: ${a.source.name}\nTITLE: ${a.title}\nDESCRIPTION: ${a.description}\nURL: ${a.url}\nDATE: ${a.publishedAt}`
  ).join("\n\n");

  const existingProfilesStr = JSON.stringify(existingProfiles, null, 2);

  const prompt = `You are a competitive intelligence analyst for Pixel Credit Card by HDFC Bank — a digital-first, cashback-led card targeting Gen Z and young professionals.

You are tracking these competitor cards in Pixel's segment:
${cardList}

Here are the current profiles of each tracked card (may be empty if first run):
${existingProfilesStr}

Below are news articles from the past month. For each article:
1. Identify which tracked card(s) it mentions
2. Extract any changes — new features, removed benefits, fee changes, reward changes, lounge changes, new partnerships
3. Assess impact as: positive (card got better), negative (card got worse), neutral (informational)

OUTPUT a JSON object with this exact shape:
{
  "cardUpdates": [
    {
      "cardId": "<id from tracked cards list>",
      "profile": {
        "joiningFee": "<amount or 'Nil'>",
        "annualFee": "<amount or 'Nil'>",
        "feeWaiverThreshold": "<spend amount or 'N/A'>",
        "primaryReward": "<main cashback/reward mechanic>",
        "rewardCap": "<cap per month or 'None'>",
        "loungeAccess": "<Yes/No/Capped - N per quarter>",
        "keyDifferentiator": "<one line>",
        "lastUpdated": "<today's date as Mon DD, YYYY>"
      },
      "changelog": [
        {
          "change": "<what changed, plain English, one sentence>",
          "impact": "<positive|negative|neutral>",
          "source": "<publication name>",
          "sourceUrl": "<url>",
          "date": "<Mon DD, YYYY>"
        }
      ]
    }
  ]
}

Only include cards that had relevant news this month. If no news found for a card, omit it.
If a profile field is unknown, use null.
Return ONLY the JSON. No explanation, no markdown.

HERE ARE THE ARTICLES:
${articleList}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("Failed to parse Claude competitive response:", text);
    return { cardUpdates: [] };
  }
}

// ── Step 3: Generate QCR if it's the 13th week ───────────────────────────────
async function generateQCR(redis, quarter) {
  // Pull last 13 weeks of changelogs for all cards
  const summaries = [];
  for (const card of TRACKED_CARDS) {
    const rawLog = await redis.get(`card:${card.id}:changelog`);
    const changelog = rawLog ? JSON.parse(rawLog) : [];
    const recent = changelog.slice(-13); // last 13 entries max
    if (recent.length > 0) {
      summaries.push({ card: card.name, issuer: card.issuer, changes: recent });
    }
  }

  if (summaries.length === 0) {
    return null;
  }

  const prompt = `You are a competitive intelligence analyst for Pixel Credit Card by HDFC Bank.

Generate a Quarterly Competition Report for ${quarter}. This is for the Pixel card product and business team.

Pixel Card profile: Digital-first, cashback-led, no/low fee, targeting Gen Z and young professionals (18-28), key benefits are OTT cashback, food delivery cashback, and gamified rewards.

Here are the competitive changes from the past quarter:
${JSON.stringify(summaries, null, 2)}

Write a QCR with this exact JSON shape:
{
  "quarter": "${quarter}",
  "narrative": "<3-4 paragraph executive summary of the quarter's competitive landscape. What moved, what it means for Pixel, what to watch next quarter.>",
  "biggestMoves": [
    {
      "card": "<card name>",
      "move": "<what they did>",
      "impact": "<positive|negative|neutral>",
      "pixelImplication": "<what this means specifically for Pixel card strategy, one sentence>"
    }
  ],
  "segmentTrends": ["<trend 1>", "<trend 2>", "<trend 3>"],
  "pixelOpportunities": ["<opportunity 1>", "<opportunity 2>"],
  "pixelWatchPoints": ["<risk or area to monitor 1>", "<risk 2>"]
}

Return ONLY the JSON. No explanation, no markdown.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("Failed to parse QCR response:", text);
    return null;
  }
}

// ── Step 4: Save to Redis ─────────────────────────────────────────────────────
async function saveCompetitiveData(redis, cardUpdates, qcr) {
  const weekId = getWeekId(new Date());

  // Ensure cards:index exists
  const indexRaw = await redis.get("cards:index");
  const index = indexRaw ? JSON.parse(indexRaw) : TRACKED_CARDS.map(c => c.id);
  await redis.set("cards:index", JSON.stringify(index));

  for (const update of cardUpdates) {
    const { cardId, profile, changelog: newChanges } = update;

    // Update profile
    const existingProfileRaw = await redis.get(`card:${cardId}`);
    const existingProfile = existingProfileRaw ? JSON.parse(existingProfileRaw) : {};
    const cardMeta = TRACKED_CARDS.find(c => c.id === cardId);
    const merged = {
      ...existingProfile,
      ...profile,
      id: cardId,
      name: cardMeta?.name || cardId,
      issuer: cardMeta?.issuer || "",
    };
    await redis.set(`card:${cardId}`, JSON.stringify(merged));

    // Append to changelog
    if (newChanges && newChanges.length > 0) {
      const existingLogRaw = await redis.get(`card:${cardId}:changelog`);
      const existingLog = existingLogRaw ? JSON.parse(existingLogRaw) : [];
      const tagged = newChanges.map(c => ({ ...c, weekId }));
      const updated = [...existingLog, ...tagged];
      await redis.set(`card:${cardId}:changelog`, JSON.stringify(updated));
    }
  }

  // Save QCR if generated
  if (qcr) {
    const qcrIndexRaw = await redis.get("qcr:index");
    const qcrIndex = qcrIndexRaw ? JSON.parse(qcrIndexRaw) : [];
    const quarterId = qcr.quarter.replace("'", "");
    if (!qcrIndex.includes(quarterId)) {
      qcrIndex.unshift(quarterId);
      await redis.set("qcr:index", JSON.stringify(qcrIndex));
    }
    await redis.set(`qcr:${quarterId}`, JSON.stringify({ ...qcr, generatedAt: new Date().toISOString() }));
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const now = new Date();

  // Self-skip if not every 4th Sunday (unless manually triggered)
  const isManual = req.headers["x-refresh-secret"] === process.env.REFRESH_SECRET;
  if (!isManual && !isEvery4thSunday(now)) {
    return res.status(200).json({ message: `Not a competitor refresh week (week ${getWeekNumber(now)}). Skipping.` });
  }

  try {
    const redis = await getClient();

    // Load existing profiles
    const existingProfiles = {};
    for (const card of TRACKED_CARDS) {
      const raw = await redis.get(`card:${card.id}`);
      if (raw) existingProfiles[card.id] = JSON.parse(raw);
    }

    console.log("Step 1: Fetching competitor news...");
    const articles = await fetchArticles();
    console.log(`Fetched ${articles.length} relevant articles`);

    if (articles.length === 0) {
      return res.status(200).json({ message: "No relevant competitive news found", updates: 0 });
    }

    console.log("Step 2: Processing with Claude...");
    const { cardUpdates } = await processCompetitiveNews(articles, existingProfiles);
    console.log(`Claude found updates for ${cardUpdates.length} cards`);

    // Check if QCR needed
    let qcr = null;
    if (isQCRWeek(now) || (isManual && req.query.qcr === "true")) {
      const quarter = getQuarterLabel(now);
      console.log(`Step 3: Generating QCR for ${quarter}...`);
      qcr = await generateQCR(redis, quarter);
      if (qcr) console.log(`QCR generated for ${quarter}`);
    }

    console.log("Step 4: Saving to Redis...");
    await saveCompetitiveData(redis, cardUpdates, qcr);

    return res.status(200).json({
      message: "Competitor refresh complete",
      weekId: getWeekId(now),
      cardUpdates: cardUpdates.length,
      qcrGenerated: !!qcr,
      qcrQuarter: qcr?.quarter || null,
    });
  } catch (err) {
    console.error("Competitor refresh error:", err);
    return res.status(500).json({ error: err.message });
  }
}
