// GET:  fetches the read-along text for a farbrengen. If ?eventId= is given
//       and a precise manual link exists for that specific audio track, that
//       exact range is returned instead of the general farbrengen-wide segments.
// POST: saves a new precise link — the real fix for cases where automated
//       segmentation can't find every individual audio-track boundary, but a
//       human (listening + reading) can verify the exact text range by hand.
//
// GET  /api/get-farbrengen-text?farbrengenId=X&eventId=Y (eventId optional)
// POST /api/get-farbrengen-text { eventId, farbrengenId, startSnippet, endSnippet }

import { createClient } from '@supabase/supabase-js';

function findBoundary(haystack, snippet, searchFrom) {
  const words = snippet.trim().split(/\s+/);
  const minWords = Math.min(2, words.length);
  for (let n = words.length; n >= minWords; n--) {
    const candidate = words.slice(0, n).join(' ');
    const idx = haystack.indexOf(candidate, searchFrom || 0);
    if (idx !== -1) return idx;
  }
  return -1;
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (req.method === 'POST') {
    const { eventId, farbrengenId, startSnippet, endSnippet, manualTitle, manualSummary, manualTags } = req.body;
    if (!eventId || !farbrengenId || !startSnippet) {
      return res.status(400).json({ error: 'Missing eventId, farbrengenId, or startSnippet' });
    }

    const { data: transcript, error: tErr } = await supabase
      .from('raw_transcripts')
      .select('full_text')
      .eq('farbrengen_id', farbrengenId)
      .maybeSingle();

    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!transcript) return res.status(404).json({ error: 'No cached transcript found for this farbrengen — run it through finder.html first' });

    const text = transcript.full_text;
    const startIdx = findBoundary(text, startSnippet, 0);
    if (startIdx === -1) {
      return res.status(200).json({ error: 'Could not locate startSnippet in the transcript', hint: 'Check spelling/spacing matches the actual transcript text' });
    }

    let endIdx = text.length;
    if (endSnippet) {
      const foundEnd = findBoundary(text, endSnippet, startIdx + 1);
      if (foundEnd !== -1) endIdx = foundEnd;
    }

    const resolvedText = text.slice(startIdx, endIdx).trim();

    // Generate a title, summary, tags — and clean the text itself: strip
    // running page headers/page numbers, and pull footnotes out into a
    // structured list with simple {{fn:N}} markers left inline, so the
    // reading view can render them as real clickable footnotes instead of
    // mixed-in text.
    let titleEn = null, summaryEn = null, tags = [], cleanedText = resolvedText, footnotes = [];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 8192,
            messages: [{
              role: 'user',
              content: `This is a section of a chassidic sicha/farbrengen transcript, OCR'd page by page — it has running headers (a repeated date/page-number line at the top or bottom of each page) and footnotes mixed into the body text that need cleaning up.

Do the following:
1. Remove running headers and bare page numbers (short lines like a date + page number, e.g. "י״ט כסלו, ה'תשי״ג" alone on a line, or a lone number like "194") — these are page artifacts, not part of the actual sicha.
2. Find every footnote: a marker in the body (a number, often superscript or in parentheses) paired with its footnote text (usually collected near the bottom of the page it appeared on). Replace each marker in the body with a simple inline tag {{fn:N}} using sequential numbers 1,2,3... in the order they appear, and collect the actual footnote text separately.
3. Keep everything else in the body text EXACTLY as written — same words, same Hebrew, same paragraph breaks — just with headers/page-numbers removed and footnote markers normalized.
4. Also generate a short English title (5-8 words), a 2-3 sentence English summary, and 4-8 short lowercase tags (topics, dates/occasions, chassidic concepts, sources cited).

Respond ONLY with valid JSON, no other text:
{"cleanedText": "the cleaned Hebrew body text with {{fn:N}} markers", "footnotes": [{"marker":"1","text":"footnote text"}, ...], "titleEn": "...", "summaryEn": "...", "tags": ["...","..."]}

Text:

${resolvedText.slice(0, 14000)}`
            }]
          })
        });
        if (claudeRes.ok) {
          const claudeData = await claudeRes.json();
          let raw = (claudeData.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(raw);
          titleEn = parsed.titleEn || null;
          summaryEn = parsed.summaryEn || null;
          tags = parsed.tags || [];
          if (parsed.cleanedText) cleanedText = parsed.cleanedText;
          footnotes = parsed.footnotes || [];
        }
      } catch (e) { /* enrichment/cleanup is best-effort — a failed call shouldn't block saving the raw link */ }
    }

    // Manual overrides win if given — e.g. reusing a title/summary already
    // generated for the general (non-precise) segment covering this same
    // stretch of the farbrengen, instead of trusting a fresh Claude call.
    if (manualTitle) titleEn = manualTitle;
    if (manualSummary) summaryEn = manualSummary;
    if (manualTags && manualTags.length) tags = manualTags;

    const { error: saveErr } = await supabase
      .from('audio_text_links')
      .upsert({
        ashreinu_event_id: eventId,
        farbrengen_id: farbrengenId,
        start_snippet: startSnippet,
        end_snippet: endSnippet || null,
        resolved_text: cleanedText,
        title_en: titleEn,
        summary_en: summaryEn,
        tags,
        footnotes
      });

    if (saveErr) return res.status(500).json({ error: saveErr.message });

    return res.status(200).json({ saved: true, titleEn, summaryEn, tags, footnoteCount: footnotes.length, resolvedTextLength: cleanedText.length, resolvedTextPreview: cleanedText.slice(0, 300) });
  }

  // GET
  const { farbrengenId, eventId } = req.query;
  if (!farbrengenId) return res.status(400).json({ error: 'Missing farbrengenId' });

  try {
    // If a specific event id was given, check for a precise manual link first.
    if (eventId) {
      const { data: link } = await supabase
        .from('audio_text_links')
        .select('*')
        .eq('ashreinu_event_id', eventId)
        .maybeSingle();

      if (link) {
        res.setHeader('Cache-Control', 's-maxage=300');
        return res.status(200).json({
          hasText: true,
          precise: true,
          segments: [{ title_en: link.title_en, summary_en: link.summary_en, tags: link.tags || [], source_text: link.resolved_text, footnotes: link.footnotes || [] }]
        });
      }
    }

    // Fall back to the general, farbrengen-wide segments.
    const { data, error } = await supabase
      .from('farbrengen_texts')
      .select('*')
      .eq('farbrengen_id', farbrengenId)
      .order('segment_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ segments: data, hasText: data.length > 0, precise: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
