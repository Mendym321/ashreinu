# Ashreinu's API: what's there

Base: `https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1`
(public, read-only, no key). Addresses that don't exist answer
`{"message":"Missing Authentication Token"}` (403).

| Address | What it gives | Used by us |
|---|---|---|
| `events` | Every top-level event (2,911: farbrengens, davening, sichos…), one list. Filters: `?year=5714`, `&month=11` | not yet (could replace the manual `build-index` crawl) |
| `years` | The list of years | no |
| `event/{id}` | One event: name, type, `description`, `dates` (with `after_nightfall`), `restored`, `pictures`, `sub_events`, `audio_recordings` | yes (`build-index`, pipeline) |
| `event/{id}/long-description` | The Hebrew outline (HTML) | yes (pipeline) |
| `event/{id}/transcript` | The hanacha (HTML, with its kind) | yes (pipeline) |
| `audio-recording/{id}` | One recording: name, duration, files | no |
| `playlists` | 123 JEM playlists: playlist, timeline, date_based_timeline, interactive_article, grouped_playlist, book | yes (pipeline: Import JEM playlists) |
| `playlist/{id}` | A playlist with its clips (each clip: title, start/end time, picture, recording) | yes |
| `clip/{id}` | One clip | no (we keep clips in Supabase) |
| `clip/{id}/document` | A clip's written text: JEM's English summary + the original (HTML) | yes |

Fields worth knowing:
- `description` on a talk: Ashreinu's editors' one-line English summary,
  often "Title: what it teaches" (1,205 talks, 153 farbrengens). On a niggun:
  the niggun names.
- `after_nightfall` on a date: the Hebrew date is already the next day.
  Not used yet.
- `restored`: JEM restored the audio. Not used yet.
- Audio files: `https://dtgj2yu3gmlic.cloudfront.net/<name>.mp3`; the app
  plays the `.opus` version when there is one and falls back to the `.mp3`.
