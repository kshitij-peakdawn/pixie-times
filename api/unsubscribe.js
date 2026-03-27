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
  const { email } = req.query;

  if (!email) {
    return res.status(400).send(page("Invalid link", "No email address provided in this unsubscribe link."));
  }

  try {
    const redis = await getClient();
    const normalised = decodeURIComponent(email).toLowerCase().trim();
    await redis.sRem("subscribers", normalised);

    return res.status(200).send(page(
      "Unsubscribed",
      `<strong>${normalised}</strong> has been removed from Pixie Times.<br/>You won't receive any more emails from us.`
    ));
  } catch (err) {
    console.error("unsubscribe error:", err);
    return res.status(500).send(page("Error", "Something went wrong. Please try again later."));
  }
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title} — Pixie Times</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet"/>
<style>
  body { font-family: 'DM Sans', sans-serif; background: #faf7f2; color: #1a1208; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fffcf8; border: 1px solid #d9d0c3; border-radius: 8px; padding: 2.5rem 2rem; max-width: 420px; text-align: center; }
  .logo { font-family: 'Playfair Display', serif; font-size: 1.8rem; font-weight: 700; margin-bottom: 1.25rem; }
  .logo span { color: #c0392b; }
  p { font-size: 0.9rem; color: #6b6052; line-height: 1.65; margin: 0 0 1.25rem; }
  a { color: #c0392b; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">Pixie<span> Times</span></div>
  <p>${body}</p>
  <a href="/">← Back to Pixie Times</a>
</div>
</body>
</html>`;
}
