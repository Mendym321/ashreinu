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

    // Strip obvious page artifacts ourselves — instant, no API call needed.
    // Running headers and bare page numbers reliably appear right after a
    // "--- page break ---" marker, as one or two short standalone lines
    // before the real sentence resumes.
    function stripPageArtifacts(t) {
      return t
        .split(/---\s*page break\s*---/g)
        .map((chunk, i) => {
          if (i === 0) return chunk;
          // Drop up to 2 leading short lines (a bare number, or a short
          // date-like header line) at the start of each new page's chunk.
          const lines = chunk.split('\n');
          let dropped = 0;
          while (dropped < 3 && lines.length && (
            /^\s*$/.test(lines[0]) ||
            /^\s*#?\s*\d{1,4}\s*$/.test(lines[0]) ||
            (lines[0].length < 40 && /כסלו|תשרי|חשון|טבת|שבט|אדר|ניסן|אייר|סיון|תמוז|אב|אלול|ה'תש|ה׳תש/.test(lines[0]))
          )) {
            lines.shift();
            dropped++;
          }
          return lines.join('\n');
        })
        .join('\n\n');
    }

    // Footnote markers came through the page-by-page transcription as
    // <sup>N</sup> tags where the source had a clear superscript — convert
    // those to {{fn:N}} tokens directly (deterministic, instant). Footnotes
    // referenced by a plain trailing number (no <sup>) aren't auto-linked
    // yet — a known limitation, safer than a fragile regex that risks
    // mismatching ordinary numbers in the text.
    const headerStripped = stripPageArtifacts(resolvedText);
    const withFnTokens = headerStripped.replace(/<sup>(\w+)<\/sup>/g, '{{fn:$1}}');
    const referencedMarkers = [...new Set([...withFnTokens.matchAll(/\{\{fn:(\w+)\}\}/g)].map(m => m[1]))];

    let titleEn = null, summaryEn = null, tags = [], footnotes = [];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 2048,
            messages: [{
              role: 'user',
              content: `This is a section of a chassidic sicha/farbrengen transcript. Do NOT reproduce or repeat the body text back — respond ONLY with this JSON:

{"titleEn": "short English title (5-8 words)", "summaryEn": "2-3 sentence English summary", "tags": ["4-8 short lowercase tags: topics, dates/occasions, chassidic concepts, sources cited"], "footnotes": [{"marker": "N", "text": "the footnote's actual text, found elsewhere in this excerpt (often near the bottom of the page it was referenced on)"}]}

Provide footnote text for exactly these marker numbers, in this order, if you can find each one's corresponding text in the excerpt: ${referencedMarkers.join(', ') || '(none found)'}

Text:

${withFnTokens.slice(0, 14000)}`
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
          footnotes = parsed.footnotes || [];
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
        start_snippet: startSnippet,
        end_snippet: endSnippet || null,
        resolved_text: withFnTokens,
        title_en: titleEn,
        summary_en: summaryEn,
        tags,
        footnotes
      });

    if (saveErr) return res.status(500).json({ error: saveErr.message });

    return res.status(200).json({ saved: true, titleEn, summaryEn, tags, footnoteCount: footnotes.length, resolvedTextLength: withFnTokens.length, resolvedTextPreview: withFnTokens.slice(0, 300) });
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
