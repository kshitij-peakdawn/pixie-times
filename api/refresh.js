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

const MAX_EDITIONS = 3;
const MAX_STORIES = 10;

// ── RSS feeds from Indian financial publications (no API key needed) ────────
const RSS_FEEDS = [
  {
    name: "Economic Times",
    url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  },
  {
    name: "Economic Times Banking",
    url: "https://economictimes.indiatimes.com/industry/banking/finance/banking/rssfeeds/13358259.cms",
  },
  {
    name: "Business Standard",
    url: "https://www.business-standard.com/rss/finance/news-10301.rss",
  },
  {
    name: "Livemint",
    url: "https://www.livemint.com/rss/money",
  },
  {
    name: "Financial Express",
    url: "https://www.financialexpress.com/market/rss",
  },
  {
    name: "Hindu BusinessLine",
    url: "https://www.thehindubusinessline.com/money-and-banking/feeder/default.rss",
  },
];

// Keywords to filter relevant articles before sending to Claude
const RELEVANT_KEYWORDS = [
  "credit card",
  "debit card",
  "rbi",
  "reserve bank",
  "upi",
  "unified payment",
  "credit line",
  "rupay",
  "cashback",
  "reward point",
  "lounge access",
  "annual fee",
  "joining fee",
  "hdfc card",
  "sbi card",
  "icici card",
  "axis card",
  "amex",
  "american express",
  "mastercard",
  "visa card",
  "npci",
  "payment network",
  "card launch",
  "card benefit",
];

// ── Helpers ────────────────────────────────────────────────────────────────
function getWeekId(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    Math.round(
      ((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    ) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getEditionLabel(date) {
  const d = new Date(date);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt) =>
    dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${fmt(monday)} – ${fmt(sunday)}, ${sunday.getFullYear()}`;
}

// ── Parse RSS XML manually (no external library needed) ───────────────────
function parseRSS(xml, sourceName) {
  const articles = [];
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const item of items) {
    const get = (tag) => {
      const match = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return match ? (match[1] || match[2] || "").trim() : "";
    };

    const title = get("title");
    const description = get("description").replace(/<[^>]+>/g, "").trim();
    const url = get("link") || get("guid");
    const pubDate = get("pubDate");

    if (!title || !url) continue;

    articles.push({
      source: { name: sourceName },
      title,
      description: description || title,
      url,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }

  return articles;
}

// ── Step 1: Fetch articles from RSS feeds ─────────────────────────────────
async function fetchArticles() {
  const allArticles = [];
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  for (const feed of RSS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "PixieTimes/1.0 RSS Reader" },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.log(`Feed ${feed.name} returned ${res.status}`);
        continue;
      }

      const xml = await res.text();
      const articles = parseRSS(xml, feed.name);
      console.log(`${feed.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      console.error(`Failed to fetch ${feed.name}:`, err.message);
    }
  }

  // Filter by date (last 7 days) and keyword relevance
  const seen = new Set();
  return allArticles.filter((a) => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);

    // Date filter
    try {
      const pubDate = new Date(a.publishedAt);
      if (pubDate < oneWeekAgo) return false;
    } catch {
      // keep if date is unparseable
    }

    // Keyword filter — must contain at least one relevant keyword
    const text = `${a.title} ${a.description}`.toLowerCase();
    return RELEVANT_KEYWORDS.some((kw) => text.includes(kw));
  });
}

// ── Step 2: Process with Claude ────────────────────────────────────────────
async function processWithClaude(articles) {
  const articleList = articles
    .map(
      (a, i) =>
        `[${i + 1}] SOURCE: ${a.source?.name || "Unknown"}
TITLE: ${a.title}
DESCRIPTION: ${a.description}
URL: ${a.url}
DATE: ${a.publishedAt}`
    )
    .join("\n\n");

  const prompt = `You are the editor of Pixie Times, a weekly news briefing for Product, Design, and Business professionals working in India's credit card industry.

Below is a raw list of news articles collected this week from Indian financial publications. Your job is to:

1. DEDUPLICATE — if multiple articles cover the same event, treat them as one story. Pick the best source to cite (prefer: Economic Times, Livemint, Business Standard, Financial Express, Hindu BusinessLine in that order).

2. FILTER — keep only articles directly relevant to:
   - New credit card launches in India
   - Changes to existing credit cards (rewards, features, fees, lounge access, etc.)
   - RBI guidelines on credit cards, UPI, or credit line on UPI
   - Industry news relevant to India's credit card market
   Discard anything not directly relevant to these topics.

3. CATEGORISE each story as exactly one of: launch, feature, fee, rbi, upi, industry

4. ASSESS IMPACT as: high, med, or low
   - high = affects many cardholders or signals a major industry shift
   - med = meaningful change for a segment of users
   - low = minor update or niche relevance

5. OUTPUT up to ${MAX_STORIES} stories as a JSON array sorted by impact (high first) then recency.

For each story output this exact JSON shape:
{
  "id": <number starting from 1>,
  "category": "<launch|feature|fee|rbi|upi|industry>",
  "badge": "badge-<category>",
  "badgeLabel": "<New Launch|Feature Change|Fee Change|RBI Guideline|UPI|Industry>",
  "impact": "<high|med|low>",
  "headline": "<clear factual headline under 15 words>",
  "summary": "<2 sentences max, plain English, what happened and why it matters>",
  "description": "<the original description from the source article verbatim>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "source": "<publication name>",
  "sourceUrl": "<original article URL>",
  "date": "<formatted as Mon DD, YYYY>",
  "highlight": {
    "label": "Why it matters for your team",
    "text": "<2-3 sentences of sharp specific analysis for product/design/business professionals in the credit card industry>"
  }
}

If there are genuinely no relevant articles, return an empty array [].
Return ONLY the JSON array. No explanation, no markdown, no preamble.

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
  const text = data.content?.[0]?.text || "[]";
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("Failed to parse Claude response:", text);
    return [];
  }
}

// ── Step 3: Save to Redis ──────────────────────────────────────────────────
async function saveEdition(stories) {
  const redis = await getClient();
  const now = new Date();
  const id = getWeekId(now);
  const label = getEditionLabel(now);

  const edition = {
    id,
    label,
    isCurrent: true,
    generatedAt: now.toISOString(),
    news: stories,
  };

  const raw = await redis.get("editions:index");
  let index = raw ? JSON.parse(raw) : [];

  // Mark previous editions as not current
  for (const existingId of index) {
    const existingRaw = await redis.get(`edition:${existingId}`);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw);
      if (existing.isCurrent) {
        await redis.set(
          `edition:${existingId}`,
          JSON.stringify({ ...existing, isCurrent: false })
        );
      }
    }
  }

  index = index.filter((i) => i !== id);
  index.unshift(id);

  if (index.length > MAX_EDITIONS) {
    const toDelete = index.splice(MAX_EDITIONS);
    for (const oldId of toDelete) {
      await redis.del(`edition:${oldId}`);
    }
  }

  await redis.set(`edition:${id}`, JSON.stringify(edition));
  await redis.set("editions:index", JSON.stringify(index));

  return edition;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // auth temporarily disabled for launch test
  try {
    console.log("Step 1: Fetching articles from RSS feeds...");
    const articles = await fetchArticles();
    console.log(`Fetched ${articles.length} relevant articles after filtering`);

    if (articles.length === 0) {
      return res.status(200).json({ message: "No relevant articles found this week", stories: 0 });
    }

    console.log("Step 2: Processing with Claude...");
    const stories = await processWithClaude(articles);
    console.log(`Claude produced ${stories.length} stories`);

    console.log("Step 3: Saving to Redis...");
    const edition = await saveEdition(stories);

    return res.status(200).json({
      message: "Edition generated successfully",
      editionId: edition.id,
      stories: stories.length,
    });
  } catch (err) {
    console.error("Refresh error:", err);
    return res.status(500).json({ error: err.message });
  }
}
