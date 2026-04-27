import { createClient } from "redis";
import { requireAuthorizedRequest } from "./_lib/auth.js";

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

const RSS_FEEDS = [
  { name: "Economic Times Banking", url: "https://economictimes.indiatimes.com/industry/banking/finance/banking/rssfeeds/13358259.cms" },
  { name: "Business Standard",      url: "https://www.business-standard.com/rss/finance/news-10301.rss" },
  { name: "Livemint",               url: "https://www.livemint.com/rss/money" },
  { name: "Financial Express",      url: "https://www.financialexpress.com/market/rss" },
  { name: "Hindu BusinessLine",     url: "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss" },
];

function getQuarterLabel(date) {
  const month = date.getMonth();
  const year = String(date.getFullYear()).slice(2);
  if (month <= 2) return `JFM'${year}`;
  if (month <= 5) return `AMJ'${year}`;
  if (month <= 8) return `JAS'${year}`;
  return `OND'${year}`;
}

function getMonthsSinceLastQCR(lastQCRDate) {
  if (!lastQCRDate) return 999;
  const now = new Date();
  const last = new Date(lastQCRDate);
  return (now.getFullYear() - last.getFullYear()) * 12 + (now.getMonth() - last.getMonth());
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

async function fetchArticles() {
  const allArticles = [];
  const cardKeywords = TRACKED_CARDS.flatMap(c => [c.name.toLowerCase(), c.issuer.toLowerCase()]);

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "PixieTimes/1.0 RSS Reader" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const articles = parseRSS(xml, feed.name);
      const relevant = articles.filter(a => {
        const text = `${a.title} ${a.description}`.toLowerCase();
        return cardKeywords.some(kw => text.includes(kw));
      });
      allArticles.push(...relevant);
    } catch (err) {
      console.error(`Failed to fetch ${feed.name}:`, err.message);
    }
  }

  const seen = new Set();
  return allArticles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

async function processWithClaude(articles, existingProfiles) {
  const cardList = TRACKED_CARDS.map(c => `- ${c.name} (${c.issuer}) [id: ${c.id}]`).join("\n");
  const articleList = articles.map((a, i) =>
    `[${i + 1}] SOURCE: ${a.source.name}\nTITLE: ${a.title}\nDESCRIPTION: ${a.description}\nURL: ${a.url}\nDATE: ${a.publishedAt}`
  ).join("\n\n");

  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  const prompt = `You are a competitive intelligence analyst for Pixel Credit Card (HDFC Bank).

Tracked competitor cards:
${cardList}

Current profiles (may be outdated — update if news contradicts them):
${JSON.stringify(existingProfiles, null, 2)}

From the articles below, for each card:
1. Extract any changes this month (features added/removed, fee changes, reward changes, lounge changes)
2. Update the card's profile fields if the change affects them (e.g. if lounge access was capped, update loungeAccess field)
3. Record each change in changelog with impact: positive (card improved), negative (card worsened), neutral

Today's date: ${today}

Return JSON:
{
  "cardUpdates": [
    {
      "cardId": "<id>",
      "profileUpdates": {
        "joiningFee": "<only include fields that changed — omit unchanged fields>",
        "annualFee": "...",
        "feeWaiverThreshold": "...",
        "primaryReward": "...",
        "rewardCap": "...",
        "loungeAccess": "...",
        "keyDifferentiator": "...",
        "lastUpdated": "${today}"
      },
      "changelog": [
        {
          "change": "<what changed, one sentence, plain English>",
          "impact": "<positive|negative|neutral>",
          "source": "<publication name>",
          "sourceUrl": "<url>",
          "date": "<Mon DD, YYYY>"
        }
      ]
    }
  ]
}

Only include cards with actual news this month. Omit cards with no relevant articles.
Return ONLY the JSON. No explanation, no markdown.

ARTICLES:
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
  try { return JSON.parse(clean); }
  catch (err) { console.error("Failed to parse Claude response:", text); return { cardUpdates: [] }; }
}

async function generateQCR(redis, quarter) {
  const summaries = [];
  for (const card of TRACKED_CARDS) {
    const rawLog = await redis.get(`card:${card.id}:changelog`);
    const changelog = rawLog ? JSON.parse(rawLog) : [];
    if (changelog.length > 0) summaries.push({ card: card.name, issuer: card.issuer, changes: changelog.slice(-13) });
  }
  if (!summaries.length) return null;

  const prompt = `You are a competitive intelligence analyst for Pixel Credit Card (HDFC Bank) — digital-first, cashback-led, Gen Z / young professional segment, no or low fee.

Generate a Quarterly Competition Report for ${quarter}.

Competitive changes this quarter:
${JSON.stringify(summaries, null, 2)}

Return JSON:
{
  "quarter": "${quarter}",
  "narrative": "<3-4 paragraph executive summary. What moved, what it means for Pixel, what to watch.>",
  "biggestMoves": [{ "card": "<name>", "move": "<what they did>", "impact": "<positive|negative|neutral>", "pixelImplication": "<one sentence specific to Pixel strategy>" }],
  "segmentTrends": ["<trend 1>", "<trend 2>", "<trend 3>"],
  "pixelOpportunities": ["<opportunity 1>", "<opportunity 2>"],
  "pixelWatchPoints": ["<risk 1>", "<risk 2>"]
}

Return ONLY the JSON. No markdown.`;

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
  try { return JSON.parse(clean); }
  catch (err) { console.error("Failed to parse QCR:", text); return null; }
}

async function saveUpdates(redis, cardUpdates, qcr) {
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  for (const update of cardUpdates) {
    const { cardId, profileUpdates = {}, changelog: newChanges = [] } = update;

    // Merge profile updates into existing profile
    const existingRaw = await redis.get(`card:${cardId}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    const cardMeta = TRACKED_CARDS.find(c => c.id === cardId);
    const merged = {
      ...existing,
      ...profileUpdates,
      id: cardId,
      name: cardMeta?.name || cardId,
      issuer: cardMeta?.issuer || "",
      lastUpdated: today,
    };
    await redis.set(`card:${cardId}`, JSON.stringify(merged));

    // Prepend new changelog entries (newest first in storage)
    if (newChanges.length > 0) {
      const existingLogRaw = await redis.get(`card:${cardId}:changelog`);
      const existingLog = existingLogRaw ? JSON.parse(existingLogRaw) : [];
      const updated = [...newChanges, ...existingLog]; // new entries at top
      await redis.set(`card:${cardId}:changelog`, JSON.stringify(updated));
    }
  }

  // Save QCR if generated
  if (qcr) {
    const qcrIndexRaw = await redis.get("qcr:index");
    const qcrIndex = qcrIndexRaw ? JSON.parse(qcrIndexRaw) : [];
    const quarterId = qcr.quarter.replace("'", "");
    if (!qcrIndex.includes(quarterId)) qcrIndex.unshift(quarterId);
    await redis.set("qcr:index", JSON.stringify(qcrIndex));
    await redis.set(`qcr:${quarterId}`, JSON.stringify({ ...qcr, generatedAt: new Date().toISOString() }));
  }
}

export default async function handler(req, res) {
  if (!requireAuthorizedRequest(req, res)) return;

  try {
    const redis = await getClient();

    // Load existing profiles to give Claude context
    const existingProfiles = {};
    for (const card of TRACKED_CARDS) {
      const raw = await redis.get(`card:${card.id}`);
      if (raw) existingProfiles[card.id] = JSON.parse(raw);
    }

    console.log("Step 1: Fetching competitor news...");
    const articles = await fetchArticles();
    console.log(`Fetched ${articles.length} relevant articles`);

    let cardUpdates = [];
    if (articles.length > 0) {
      console.log("Step 2: Processing with Claude...");
      const result = await processWithClaude(articles, existingProfiles);
      cardUpdates = result.cardUpdates || [];
      console.log(`Claude found updates for ${cardUpdates.length} cards`);
    }

    // Check if QCR needed (every 3 months)
    let qcr = null;
    const qcrIndexRaw = await redis.get("qcr:index");
    const qcrIndex = qcrIndexRaw ? JSON.parse(qcrIndexRaw) : [];
    let lastQCRDate = null;
    if (qcrIndex.length > 0) {
      const lastQCR = await redis.get(`qcr:${qcrIndex[0]}`);
      if (lastQCR) lastQCRDate = JSON.parse(lastQCR).generatedAt;
    }

    const monthsSinceLast = getMonthsSinceLastQCR(lastQCRDate);
    const forceQCR = req.query.qcr === "true";
    if (forceQCR || monthsSinceLast >= 3) {
      const quarter = getQuarterLabel(new Date());
      console.log(`Step 3: Generating QCR for ${quarter}...`);
      qcr = await generateQCR(redis, quarter);
      if (qcr) console.log(`QCR generated for ${quarter}`);
    }

    console.log("Step 4: Saving to Redis...");
    await saveUpdates(redis, cardUpdates, qcr);

    return res.status(200).json({
      message: "Competitor refresh complete",
      articlesFound: articles.length,
      cardUpdates: cardUpdates.length,
      qcrGenerated: !!qcr,
      qcrQuarter: qcr?.quarter || null,
    });
  } catch (err) {
    console.error("Competitor refresh error:", err);
    return res.status(500).json({ error: err.message });
  }
}
