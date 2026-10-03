// Server-side proxy to Gemini. The API key never reaches the browser.
// Required environment variables (set in Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY  – your Gemini API key (billing enabled)
//   APP_PASSCODE    – a family passcode; requests without it are refused
// Optional:
//   GEMINI_MODEL    – model id, default "gemini-3.8-flash"

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  const pass = process.env.APP_PASSCODE;
  if (!key) return res.status(500).json({ error: "missing_key", message: "GEMINI_API_KEY is not set in Vercel." });
  if (!pass) return res.status(500).json({ error: "missing_passcode", message: "APP_PASSCODE is not set in Vercel." });
  if (req.headers["x-passcode"] !== pass) return res.status(401).json({ error: "wrong_passcode", message: "Wrong passcode." });

  const body = req.body || {};
  const parts = Array.isArray(body.parts) ? body.parts : null;
  if (!parts || !parts.length || parts.length > 6) return res.status(400).json({ error: "bad_request" });

  // Only allow plain text and inline image/audio parts.
  const clean = [];
  for (const p of parts) {
    if (typeof p.text === "string") clean.push({ text: p.text.slice(0, 20000) });
    else if (p.inlineData && /^(image|audio)\//.test(p.inlineData.mimeType || "") && typeof p.inlineData.data === "string")
      clean.push({ inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } });
    else return res.status(400).json({ error: "bad_part" });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: clean }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: "gemini_error", status: r.status, message: data?.error?.message || "Gemini request failed." });
    }
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (!text) return res.status(502).json({ error: "empty", message: "Gemini returned no answer." });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "network", message: String(e?.message || e) });
  }
}
