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
    const { eventId, farbrengenId, startSnippet, endSnippet, manualTitle, manualSummary, manualTags, resolvedText: directText } = req.body;
    if (!eventId || !farbrengenId || (!startSnippet && !directText)) {
      return res.status(400).json({ error: 'Missing eventId, farbrengenId, or startSnippet/resolvedText' });
    }

    let resolvedText;

    if (directText) {
      // The assignment tool already has the exact spliced text from
      // segmentation — no need to re-search the transcript for it at all.
      resolvedText = directText;
    } else {
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

      resolvedText = text.slice(startIdx, endIdx).trim();
    }

    // Footnote/header cleanup now happens entirely at DISPLAY time on the
    // frontend (pure pattern-matching, no API call) — so we just store the
    // raw resolved text here. This is simpler, faster, and also means any
    // improvement to the display-side cleanup applies retroactively to
    // everything already saved, without needing to re-run this endpoint.
    let titleEn = null, summaryEn = null, tags = [];
    // Skip the enrichment call entirely when the caller already supplied
    // title/summary/tags directly (the assignment tool always does, since
    // segmentation already generated them) — saves an API call, not just time.
    const needsEnrichment = !(manualTitle && manualSummary && manualTags?.length);
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && needsEnrichment) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: `This is a section of a chassidic sicha/farbrengen transcript. Respond ONLY with valid JSON, no other text:\n{"titleEn": "short English title (5-8 words)", "summaryEn": "2-3 sentence English summary", "tags": ["4-8 short lowercase tags: topics, dates/occasions, chassidic concepts, sources cited"]}\n\nText:\n\n${resolvedText.slice(0, 12000)}`
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
        }
      } catch (e) { /* enrichment is best-effort — a failed call shouldn't block saving the link */ }
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
        start_snippet: startSnippet || resolvedText.slice(0, 60),
        end_snippet: endSnippet || null,
        resolved_text: resolvedText,
        title_en: titleEn,
        summary_en: summaryEn,
        tags
      });

    if (saveErr) return res.status(500).json({ error: saveErr.message });

    return res.status(200).json({ saved: true, titleEn, summaryEn, tags, resolvedTextLength: resolvedText.length, resolvedTextPreview: resolvedText.slice(0, 300) });
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
          segments: [{ title_en: link.title_en, summary_en: link.summary_en, tags: link.tags || [], source_text: link.resolved_text }]
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
