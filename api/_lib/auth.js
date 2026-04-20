export function isAuthorizedRequest(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const cronSecret = process.env.CRON_SECRET;
  const refreshSecret = process.env.REFRESH_SECRET;
  const manualSecret = req.headers["x-refresh-secret"];

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return true;
  if (refreshSecret && manualSecret === refreshSecret) return true;

  return false;
}

export function requireAuthorizedRequest(req, res) {
  if (isAuthorizedRequest(req)) return true;

  res.status(401).json({ error: "Unauthorized" });
  return false;
}
