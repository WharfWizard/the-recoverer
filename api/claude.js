// api/claude.js
// Serverless proxy to the Anthropic API — the ONLY place the API key is used.
// The key lives in Vercel's environment variables (ANTHROPIC_API_KEY) and is
// never sent to, or visible from, the browser. The model is fixed here, not
// taken from the client, so a modified client request can't call a different
// (potentially more expensive) model.
//
// Called from exactly three places in the app: evidence analysis, report
// drafting, and the safeguard check. PDF generation never reaches this file.

const MODEL = "claude-sonnet-4-6";
const HARD_MAX_TOKENS = 1500; // ceiling regardless of what the client asks for

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is not configured with an API key." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { system, messages, max_tokens } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing messages." });
  }

  const cappedMaxTokens = Math.min(Number(max_tokens) || 800, HARD_MAX_TOKENS);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: cappedMaxTokens,
        system,
        messages,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const message = (data && data.error && data.error.message) || "Upstream error from the AI service.";
      return res.status(upstream.status).json({ error: message });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: "Could not reach the AI service. Please try again." });
  }
};
