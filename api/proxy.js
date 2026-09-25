const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';

// Hugging Face model for Yiddish speech-to-text (public, ivrit.ai fine-tune of Whisper)
const HF_MODEL = 'ivrit-ai/yi-whisper-large-v3-turbo';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// Some CDNs reject requests with no User-Agent (server-side fetch sends none by default).
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, audio, whisper } = req.query;

  // --- Yiddish ASR test mode ---
  // Usage: /api/proxy?whisper=<direct audio URL, e.g. an Ashreinu mp3/opus link>
  if (whisper) {
    if (!process.env.HF_API_TOKEN) {
      return res.status(500).json({ error: 'HF_API_TOKEN not set in Vercel env vars' });
    }

    // Step 1: fetch the actual audio bytes from the CDN
    let audioBuffer, contentType;
    try {
      const audioRes = await fetch(whisper, { headers: BROWSER_HEADERS });
      if (!audioRes.ok) {
        return res.status(audioRes.status).json({
          error: `Could not fetch audio from source (status ${audioRes.status})`,
          url: whisper,
        });
      }
      audioBuffer = await audioRes.arrayBuffer();
      contentType = whisper.endsWith('.opus') ? 'audio/ogg' : 'audio/mpeg';
    } catch (err) {
      return res.status(502).json({
        error: 'Could not reach the audio URL',
        detail: String(err),
        cause: err && err.cause ? String(err.cause) : null,
        url: whisper,
      });
    }

    // Step 2: send it to Hugging Face's hosted Whisper model
    try {
      const hfRes = await fetch(HF_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.HF_API_TOKEN}`,
          'Content-Type': contentType,
        },
        body: Buffer.from(audioBuffer),
      });

      const raw = await hfRes.text();

      if (!hfRes.ok) {
        // Common case: model is "cold" and HF is loading it — it says so in the body,
        // and usually asks you to retry in N seconds.
        return res.status(hfRes.status).json({ error: 'Hugging Face error', detail: raw });
      }

      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        result = { raw };
      }

      return res.status(200).json({ model: HF_MODEL, audioBytes: audioBuffer.byteLength, result });
    } catch (err) {
      return res.status(502).json({
        error: 'Could not reach Hugging Face',
        detail: String(err),
        cause: err && err.cause ? String(err.cause) : null,
      });
    }
  }

  // --- existing: raw audio streaming (unchanged) ---
  if (audio) {
    const r = await fetch(audio, { headers: BROWSER_HEADERS });
    if (!r.ok) return res.status(r.status).end();
    res.setHeader('Content-Type', audio.endsWith('.opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
    res.setHeader('Cache-Control', 's-maxage=86400');
    const buf = await r.arrayBuffer();
    return res.send(Buffer.from(buf));
  }

  // --- existing: Ashreinu API passthrough (unchanged) ---
  if (!path) return res.status(400).json({ error: 'Missing path' });
  const r = await fetch(`${ASHREINU}${path}`);
  if (!r.ok) return res.status(r.status).json({ error: `Upstream ${r.status}` });
  const data = await r.json();
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(data);
}
