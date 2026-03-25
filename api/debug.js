export default async function handler(req, res) {
  const response = await fetch(
    "https://economictimes.indiatimes.com/industry/banking/finance/banking/rssfeeds/13358259.cms",
    { headers: { "User-Agent": "PixieTimes/1.0" } }
  );
  const text = await response.text();
  return res.status(200).send(text);
}
