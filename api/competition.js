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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const redis = await getClient();

    // Fetch all card profiles and changelogs
    const cards = await Promise.all(
      TRACKED_CARDS.map(async (meta) => {
        const profileRaw = await redis.get(`card:${meta.id}`);
        const changelogRaw = await redis.get(`card:${meta.id}:changelog`);
        const profile = profileRaw ? JSON.parse(profileRaw) : { id: meta.id, name: meta.name, issuer: meta.issuer };
        const changelog = changelogRaw ? JSON.parse(changelogRaw) : [];
        return { ...profile, changelog: changelog.slice().reverse() }; // newest first
      })
    );

    // Fetch QCRs
    const qcrIndexRaw = await redis.get("qcr:index");
    const qcrIndex = qcrIndexRaw ? JSON.parse(qcrIndexRaw) : [];
    const qcrs = await Promise.all(
      qcrIndex.map(async (id) => {
        const raw = await redis.get(`qcr:${id}`);
        return raw ? JSON.parse(raw) : null;
      })
    );

    return res.status(200).json({
      cards,
      qcrs: qcrs.filter(Boolean),
      lastUpdated: cards.find(c => c.lastUpdated)?.lastUpdated || null,
    });
  } catch (err) {
    console.error("competition error:", err);
    return res.status(500).json({ error: err.message });
  }
}
