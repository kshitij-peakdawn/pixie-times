export default async function handler(req, res) {
  const apiKey = process.env.NEWS_API_KEY;
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const from = oneWeekAgo.toISOString().split("T")[0];

  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", "credit card India");
  url.searchParams.set("from", from);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "relevancy");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("apiKey", apiKey);

  const response = await fetch(url.toString());
  const data = await response.json();

  return res.status(200).json(data);
}
