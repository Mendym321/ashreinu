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

const ASHREINU_API = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';
// Ashreinu's HTML (outline, hanacha) as plain text with paragraph breaks.
function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
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

      // No human-confirmed link, but the catalogue has an entry Claude wrote
      // from Ashreinu's own outline for this exact track. Its text is the
      // track's own hanacha when there is one (else the outline is shown).
      // Checked even when eventId === farbrengenId: a standalone event (a
      // private audience, a Kos Shel Brachah) has no parent, so it is its own
      // "farbrengen", yet it can be catalogued. Real farbrengens never are.
      {
        const { data: cat } = await supabase
          .from('track_metadata')
          .select('title_en, summary_en, key_points, main_topic, topics, occasions, people, outline_he, transcript, transcript_kind')
          .eq('ashreinu_event_id', eventId)
          .eq('status', 'enriched')
          .maybeSingle();
        if (cat) {
          res.setHeader('Cache-Control', 's-maxage=300');
          return res.status(200).json({
            hasText: true,
            precise: false,
            catalogued: true,
            segments: [{
              title_en: cat.title_en, summary_en: cat.summary_en, key_points: cat.key_points || [],
              main_topic: cat.main_topic, topic_slugs: [cat.main_topic, ...(cat.topics || [])].filter(Boolean),
              occasions: cat.occasions || [], people: cat.people || [],
              outline_he: cat.outline_he, source_text: cat.transcript || null, transcript_kind: cat.transcript_kind,
            }]
          });
        }
      }

      // Not catalogued yet, but Ashreinu has its own outline or hanacha for
      // this exact track: show that (already collected by the pipeline, or
      // fetched from Ashreinu now). No summary, just the archive's text.
      {
        const { data: tm } = await supabase.from('track_metadata')
          .select('outline_he, transcript, transcript_kind').eq('ashreinu_event_id', eventId).maybeSingle();
        let outline = tm?.outline_he || '', transcript = tm?.transcript || '', kind = tm?.transcript_kind || null;
        if (!outline && !transcript) {
          const { data: ev } = await supabase.from('ashreinu_events')
            .select('has_transcript, has_ld:raw_data->>has_long_description').eq('id', eventId).maybeSingle();
          const get = async (path) => { try { const r = await fetch(ASHREINU_API + path); return r.ok ? (await r.json())?.data : null; } catch { return null; } };
          const [ld, tr] = await Promise.all([
            ev?.has_ld === 'true' ? get(`/event/${eventId}/long-description`) : null,
            ev?.has_transcript ? get(`/event/${eventId}/transcript`) : null,
          ]);
          outline = htmlToText(ld);
          const t = tr && typeof tr === 'object' ? tr : null;
          transcript = htmlToText(t?.content); kind = t?.type || null;
        }
        if (outline || transcript) {
          res.setHeader('Cache-Control', 's-maxage=3600');
          return res.status(200).json({
            hasText: true, precise: false, ashreinu: true,
            segments: [{ outline_he: outline || null, source_text: transcript || null, transcript_kind: kind }],
          });
        }
      }

      // An individual track (Sicha 1, Nigun 2...) with no confirmed link
      // must NOT fall back to every sicha in the farbrengen — that showed
      // all the text on every track, even niggunim. Only the farbrengen
      // itself (eventId === farbrengenId) gets the farbrengen-wide view.
      // We still report how many written sichos exist, so the UI can say
      // "text exists, just not matched to this track yet".
      if (String(eventId) !== String(farbrengenId)) {
        const { count } = await supabase
          .from('farbrengen_texts')
          .select('farbrengen_id', { count: 'exact', head: true })
          .eq('farbrengen_id', farbrengenId);
        res.setHeader('Cache-Control', 's-maxage=300');
        return res.status(200).json({ hasText: false, precise: false, unconfirmed: true, candidateCount: count || 0, segments: [] });
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
