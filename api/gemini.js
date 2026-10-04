// Server-side proxy to Gemini. The API key never reaches the browser.
// Environment variables (Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY – your Gemini API key (billing enabled)
//   APP_CODES      – one code per family, e.g. "F01:k7Qm2x,F02:p9Va4r"  (family id : code)
//   APP_PASSCODE   – optional; the old single passcode still works and is logged as family "OWNER"
//   GEMINI_MODEL   – optional model id, default "gemini-3.8-flash"

const MAX_AUDIO_B64 = 4_000_000; // ~90 s of 16 kHz mono WAV, under Vercel's 4.5 MB request limit

function familyFor(code) {
  if (!code) return null;
  for (const pair of (process.env.APP_CODES || "").split(",")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    if (pair.slice(i + 1).trim() === code) return pair.slice(0, i).trim();
  }
  if (process.env.APP_PASSCODE && code === process.env.APP_PASSCODE) return "OWNER";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "missing_key", message: "GEMINI_API_KEY is not set in Vercel." });
  if (!process.env.APP_CODES && !process.env.APP_PASSCODE)
    return res.status(500).json({ error: "missing_passcode", message: "APP_CODES is not set in Vercel." });

  const family = familyFor(String(req.headers["x-passcode"] || "").trim());
  if (!family) return res.status(401).json({ error: "wrong_passcode", message: "Wrong family code." });

  const body = req.body || {};
  if (body.action === "whoami") return res.status(200).json({ family });

  const kind = String(req.headers["x-call-kind"] || "other").slice(0, 20);
  const parts = Array.isArray(body.parts) ? body.parts : null;
  if (!parts || !parts.length || parts.length > 6) return res.status(400).json({ error: "bad_request" });

  const clean = [];
  for (const p of parts) {
    if (typeof p.text === "string") clean.push({ text: p.text.slice(0, 20000) });
    else if (p.inlineData && /^(image|audio)\//.test(p.inlineData.mimeType || "") && typeof p.inlineData.data === "string") {
      if (p.inlineData.mimeType.startsWith("audio/") && p.inlineData.data.length > MAX_AUDIO_B64)
        return res.status(413).json({ error: "audio_too_long", message: "The recording is too long. Keep answers under 90 seconds." });
      clean.push({ inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } });
    } else return res.status(400).json({ error: "bad_part" });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const t0 = Date.now();
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
    const u = data?.usageMetadata || {};
    // One log line per call: who, what, how many tokens. No answer content is logged.
    console.log(JSON.stringify({ evt: "gemini", family, kind, status: r.status, ms: Date.now() - t0,
      inTok: u.promptTokenCount || 0, outTok: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }));
    if (!r.ok) {
      const quota = r.status === 429;
      return res.status(quota ? 429 : 502).json({
        error: quota ? "daily_limit" : "gemini_error", status: r.status,
        message: quota ? "Today's practice limit has been reached. Please try again tomorrow." : (data?.error?.message || "Gemini request failed."),
      });
    }
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (!text) return res.status(502).json({ error: "empty", message: "Gemini returned no answer." });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "network", message: String(e?.message || e) });
  }
}
