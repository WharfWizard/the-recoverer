// api/case.js
// Serverless proxy between the browser and Supabase for case persistence.
// The browser NEVER talks to Supabase directly and never sees the service
// role key — this function is the only thing that does, via
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in Vercel's environment.
//
// Deliberately more locked-down than exposing an anon key + RLS policies:
// the "cases" table has RLS enabled with zero policies, so the anon/
// authenticated roles have no access at all — only the service role key,
// used only here, can read or write. That trades a little convenience
// (no direct client-side Supabase calls) for a table that's unreachable
// from the browser under any circumstances.
//
// Identity model: there is no login. Each browser generates a random,
// unguessable case token (a UUID) client-side and that token IS the
// access credential — same trust model as a "anyone with this link" share.
// This is fine as a prototype but is not equivalent to real authentication;
// see the README's "Known gaps" section.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server is not configured with Supabase credentials." });
  }

  const restHeaders = {
    "Content-Type": "application/json",
    "apikey": serviceKey,
    "Authorization": `Bearer ${serviceKey}`,
  };

  try {
    if (req.method === "GET") {
      const token = req.query.token;
      if (!token || !UUID_RE.test(token)) {
        return res.status(400).json({ error: "Missing or invalid token." });
      }
      const url = `${supabaseUrl}/rest/v1/cases?token=eq.${token}&select=case_title,case_data,updated_at`;
      const upstream = await fetch(url, { headers: restHeaders });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return res.status(upstream.status).json({ error: "Supabase read failed", detail });
      }
      const rows = await upstream.json();
      return res.status(200).json({ found: rows.length > 0, case: rows[0] || null });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { token, caseTitle, caseData } = body || {};
      if (!token || !UUID_RE.test(token)) {
        return res.status(400).json({ error: "Missing or invalid token." });
      }
      const url = `${supabaseUrl}/rest/v1/cases`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { ...restHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{ token, case_title: caseTitle || null, case_data: caseData || {} }]),
      });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return res.status(upstream.status).json({ error: "Supabase write failed", detail });
      }
      return res.status(200).json({ saved: true });
    }

    if (req.method === "DELETE") {
      const token = req.query.token;
      if (!token || !UUID_RE.test(token)) {
        return res.status(400).json({ error: "Missing or invalid token." });
      }
      const url = `${supabaseUrl}/rest/v1/cases?token=eq.${token}`;
      const upstream = await fetch(url, { method: "DELETE", headers: restHeaders });
      if (!upstream.ok) {
        const detail = await upstream.text();
        return res.status(upstream.status).json({ error: "Supabase delete failed", detail });
      }
      return res.status(200).json({ deleted: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(502).json({ error: "Could not reach Supabase. Please try again." });
  }
};
