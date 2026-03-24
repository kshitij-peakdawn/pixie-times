import { kv } from "@vercel/kv";

// ── Constants ──────────────────────────────────────────────────────────────
const MAX_EDITIONS = 3;
const MAX_STORIES = 10;

// NewsAPI sources focused on Indian finance publications
const NEWS_SOURCES = [
  "the-times-of-india",
  "the-hindu",
].join(",");

// Search queries to run — results get merged and deduplicated by Claude
const SEARCH_QUERIES = [
  "credit card India",
  "RBI credit card guidelines",
  "UPI credit line India",
  "credit card launch India bank",
  "credit card reward fees India",
];

// ── Helpers ────────────────────────────────────────────────────────────────
function getWeekId(date) {
  // Returns ISO week string like "2025-W14"
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = Math.round(
    ((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
  ) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getEditionLabel(date) {
  // "Mar 17 – 23, 2025"
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

// ── Step 1: Fetch raw articles from NewsAPI ────────────────────────────────
async function fetchArticles() {
  const apiKey = process.env.NEWS_API_KEY;
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const from = oneWeekAgo.toISOString().split("T")[0];

  const allArticles = [];

  for (const query of SEARCH_QUERIES) {
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("from", from);
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "relevancy");
    url.searchParams.set("pageSize", "20");
    url.searchParams.set("apiKey", apiKey);

    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.articles) {
        allArticles.push(...data.articles);
      }
    } catch (err) {
      console.error(`Failed to fetch query "${query}":`, err.message);
    }
  }

  // Remove articles with no description and deduplicate by URL
  const seen = new Set();
  return allArticles.filter((a) => {
    if (!a.description || !a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

// ── Step 2: Send articles to Claude for processing ─────────────────────────
async function processWithClaude(articles) {
  // Format articles for the prompt
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

Below is a raw list of news articles collected this week. Your job is to:

1. DEDUPLICATE — if multiple articles cover the same event or story, treat them as one story. Pick the best source to cite (prefer: Economic Times, Livemint, Business Standard, Financial Express, Hindu BusinessLine in that order).

2. FILTER — keep only articles relevant to:
   - New credit card launches in India
   - Changes to existing credit cards (rewards, features, fees, lounge access, etc.)
   - RBI guidelines on credit cards, UPI, or credit line on UPI
   - Industry news relevant to India's credit card market

3. CATEGORISE each story as exactly one of: launch, feature, fee, rbi, upi, industry

4. ASSESS IMPACT as: high, med, or low
   - high = affects many cardholders or signals a major industry shift
   - med = meaningful change for a segment of users
   - low = minor update or niche relevance

5. OUTPUT up to ${MAX_STORIES} stories as a JSON array. No more than ${MAX_STORIES}.

For each story output this exact JSON shape:
{
  "id": <number, starting from 1>,
  "category": "<launch|feature|fee|rbi|upi|industry>",
  "badge": "badge-<category>",
  "badgeLabel": "<New Launch|Feature Change|Fee Change|RBI Guideline|UPI|Industry>",
  "impact": "<high|med|low>",
  "headline": "<clear, factual headline under 15 words>",
  "summary": "<2 sentences max, plain English, what happened and why it matters>",
  "description": "<the original description from the source article, verbatim>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"],
  "source": "<publication name>",
  "sourceUrl": "<original article URL>",
  "date": "<formatted as 'Mar 18, 2025'>",
  "highlight": {
    "label": "Why it matters for your team",
    "text": "<2-3 sentences of sharp, specific analysis for product/design/business professionals in the credit card industry. Be concrete, not generic.>"
  }
}

Sort stories by impact (high first), then by recency.

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

  // Strip markdown code fences if present
  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("Failed to parse Claude response:", text);
    return [];
  }
}

// ── Step 3: Save edition to KV ─────────────────────────────────────────────
async function saveEdition(stories) {
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

  // Get existing index
  let index = (await kv.get("editions:index")) || [];

  // Mark previous editions as not current
  for (const existingId of index) {
    const existing = await kv.get(`edition:${existingId}`);
    if (existing && existing.isCurrent) {
      await kv.set(`edition:${existingId}`, { ...existing, isCurrent: false });
    }
  }

  // Remove current id if it already exists (re-run scenario)
  index = index.filter((i) => i !== id);

  // Prepend new edition
  index.unshift(id);

  // Keep only MAX_EDITIONS, delete oldest
  if (index.length > MAX_EDITIONS) {
    const toDelete = index.splice(MAX_EDITIONS);
    for (const oldId of toDelete) {
      await kv.del(`edition:${oldId}`);
    }
  }

  // Save
  await kv.set(`edition:${id}`, edition);
  await kv.set("editions:index", index);

  return edition;
}

// ── Main handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow manual trigger via POST with a secret, plus Vercel cron (GET)
  // auth temporarily disabled for launch test



  try {
    console.log("Step 1: Fetching articles from NewsAPI...");
    const articles = await fetchArticles();
    console.log(`Fetched ${articles.length} raw articles`);

    if (articles.length === 0) {
      return res.status(200).json({ message: "No articles found", stories: 0 });
    }

    console.log("Step 2: Processing with Claude...");
    const stories = await processWithClaude(articles);
    console.log(`Claude produced ${stories.length} stories`);

    console.log("Step 3: Saving to KV...");
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
