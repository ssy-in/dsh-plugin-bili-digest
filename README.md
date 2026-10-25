# Bilibili Subtitle Digest · dsh-plugin-bili-digest

> Subtitles when they exist, screenshots when they don't. Either way the model sees only what matters.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that also works as a plain CLI tool.
It turns a Bilibili video into a timestamped "digest": a cheap hard gate first, then subtitles are merged into semantic segments, scored, and only the top-K segments are kept. Videos without subtitles are no longer dropped — they fall back to Bilibili's own storyboard frames (~170 tokens each; no ffmpeg, no video download).

Chinese documentation: [README.zh.md](./README.zh.md)

## Why

One hour of video is 20k–40k tokens of raw subtitle text: expensive and noisy. This plugin measures the *value* of a video before spending tokens on it:

| Step | Cost |
| --- | --- |
| Decide whether a video has subtitles at all | ~94 ms, ~2 KB, 0 tokens |
| A 17-minute video | 4915 chars → 1290 chars (74% saved) |
| An 8-minute video | 1841 chars → 532 chars (71% saved) |
| One round: 3 keywords, 20 candidates | 3024 chars → 1616 chars (~1164 tokens) |
| A subtitle-less video, seen as frames | ~170 tokens per 480×270 frame; 6–20 frames by default (~1k–3.4k tokens) |

> Numbers measured by the author in Oct 2026 with `bili-digest run --kw …`.

## Pipeline

```
wbi-signed search → hard gate (view + subtitle list)
                       ↘ has subtitles: fetch → merge → score → top-K → Markdown digest
                       ↘ no subtitles: storyboard → pick frames → crop → encode → image frames
```

- **Hard gate**: `x/web-interface/view` for the `cid`, `x/player/wbi/v2` for the subtitle list. No subtitle track → the visual path. Subtitle density below threshold (default 60 chars/min) → "broken subtitle" → also the visual path (e.g. a 143-minute video with 177 chars of subtitles).
- **Merge**: adjacent cues become 15–30 s semantic segments; long lines are split proportionally by punctuation.
- **Score**: keyword hits ×2, conclusion words (so/therefore/means/risk/cost …) ×1, number density, speech density, head/tail position bonus.
- **Select**: greedy pick with ±2 neighbour penalty and 3-gram duplicate filtering; 4–14 segments by duration; 3600-char cap per video.
- **Frames**: `x/player/videoshot` returns a 10×10 storyboard sheet plus timestamps (480×270 cells). Only the needed cells are cropped and re-encoded as separate JPEGs — one big contact sheet would be downscaled by the host and lose detail.
- **Recall**: every segment has a `?t=seconds` link; `bili_recall` (or `bili-digest recall BV … from to`) returns the raw lines.

## Install

### As a DSH plugin

```bash
npm pack     # produces dsh-plugin-bili-digest-0.1.0.tgz
```

Install it from the plugin market, then open **Settings → Plugins → B 站字幕速览**, paste your `SESSDATA` once, and press «开始一轮».

### As a CLI tool

```bash
node bin/bili-digest.js login --sessdata "<your SESSDATA>"
node bin/bili-digest.js run --kw deepseek --days 7 --limit 12
node bin/bili-digest.js read BV1Fdna6mE9W --frames 4
node bin/bili-digest.js frames BV1Fdna6mE9W --count 8      # or --at 12,95,400 for exact moments
node bin/bili-digest.js recall BV1Fdna6mE9W 120 300
node bin/bili-digest.js status
```

Only needs Node ≥ 18.17 (global `fetch`). Frame extraction additionally uses `jpeg-js` (pure JS, no native build); without it everything except the frame path still works.

## SESSDATA is required

Anonymous Bilibili access does not expose the subtitle list (`need_login_subtitle: true`), so every video would be judged "no subtitles". Measured: 0 of 10 videos resolvable anonymously; with a login cookie, 18 of 34 videos had subtitles.

- Copy `SESSDATA` from the browser cookie jar (DevTools → Application → Cookies).
- Provide it via the plugin UI (write-only, stored in a 0600 file), the `BILI_SESSDATA` env var, or `bili-digest login`.
- Location: `$DSH_HOME/bili-digest/config.json` (default `~/.dsh/bili-digest/config.json`); override with `BILI_DIGEST_HOME` / `BILI_DIGEST_CONFIG`. It is never written into this repository or the profile config.

## Tools exposed to the model

| Tool | Purpose |
| --- | --- |
| `bili_digest` | keywords → digest (multi-keyword, day filter; subtitle-less videos are reported with a hint to look at frames) |
| `bili_read` | one BV id → digest; falls back to storyboard frames when there is no usable subtitle (`frames` sets how many) |
| `bili_frames` | screenshots: even sampling (`count`) or exact moments (`seconds`) |
| `bili_mood` | browse by mood: one sentence or a preset → two markdown files (mood diary + digest report) |
| `bili_recall` | raw subtitles for a time range |

`bili_digest` / `bili_recall` return compact plain text; full subtitle tracks never enter the context. `bili_read` / `bili_frames` return image frames (~170 tokens each).

## Looking at frames

Subtitles are not enough: plenty of small channels ship no `ai-zh` track, and UI walkthroughs or diagrams do not survive text anyway. So a subtitle-less video falls back to **Bilibili storyboards**:

- Source: `x/player/videoshot` — **no wbi signature, no login, no ffmpeg, no video download**. It returns a 10×10 contact sheet plus timestamps, 480×270 per cell.
- Only the needed cells are cropped and re-encoded as standalone JPEGs (28–37 KB each). Frames are returned individually, not as one big sheet: a large sheet would be downscaled by the host and lose detail.
- Default count by duration: <3 min 6 frames, 3–15 min 12, 15–45 min 16, >45 min 20; hard cap 24 per call. For "check this one moment" 1–4 frames is enough.
- In the plugin UI every dropped video has a "see frames" button that previews the screenshots and links to the exact moment.

## Browsing by mood (the mood diary)

No scheduled daily crawl: you browse **when you feel like it, in the mood you are in**. A round writes pairs of markdown files into one folder (default `我看视频/`, configurable in the panel), named `date_BV_…` so you can tell at a glance which video each belongs to:

- `20261024_BV1xx_diary.md` — **the diary for you**: what you said, the mood/preset it inferred, why it picked these, highlights and quotable lines, a `## emotional arc` that walks this video's own hooks as opening/development/turn/closing, what was skipped, plus blanks to fill (`我记一笔`, "what to browse next time").
- `20261024_BV1xx_dailyReport.md` — **the digest for the model**: structured sections with `?t=` deep links.
- Screenshots go to `画面/<BV>/` in the same folder; one round of N videos yields N pairs (default: one video per round).

```bash
bili-digest mood "今天有点累，就想看点轻松的，别太费脑子"
bili-digest mood --preset learn --limit 20
bili-digest presets            # the five presets and their default keywords
```

Presets: `relax` / `learn` / `rant` / `hype` / `random`. You can pass only a sentence, only a preset, or both (an explicit `关键词：xxx` wins over preset keywords). In the plugin UI it is a row of preset buttons plus a free-text box.

Two details that improve the hit rate:

- **Keyword quota** — with five keywords the first one cannot eat the whole candidate list; each keyword contributes a share, so the round stays varied.
- **Short clips are skipped** — by default only videos of 3 minutes or more (`minDuration`), because short clips almost never carry an `ai-zh` track.

Slow cadence (one video per hour):

- `--videos 1` (the default): a round puts at most one video into the diary and leaves the rest for next time; `0` means no cap.
- Set "auto interval" to `60` in the plugin panel and, while the host is running, it browses one video and writes one diary entry every hour (`0` turns it off). "Auto mood text" is the sentence used for those rounds.

## Favorites and "mention the human"

After reading a video it can also do two write actions (off by default, requires `bili_jct`): file the video into a favorites folder and post a comment mentioning the human — "today's mood + why I want you to see this + one-line takeaway". Mentions are split into **two tracks** (`pushPlan()`): long videos (subtitle pipeline) and short videos (frames only). During the tuning phase that is **9 + 9 = 18 per day**, and 10 days after the first real mention it drops by itself to **long 5 + short 3 = 8 per day** (`pushDailyLong`, `pushDailyShort`, `pushReduceAfterDays`). Use `--short` for the short track.

Six folder roles (a missing title tells you to create a folder with that name):

| Role | Default title | When it is used |
| --- | --- | --- |
| `mood` | 我喜欢的视频 | matches today's mood and looks interesting |
| `deepseek` | 关于我的的视频 | DeepSeek-related learning or fun |
| `liked` | 人类主人喜欢的视频 | only after the human approves |
| `misc` | 默认收藏夹 | everything else |
| `reject` | 我不喜欢的视频 | bad values/clickbait/flame-bait; **archived only, never mentioned, never in the diary** |
| `own` | 鲸鲸自己收藏的 | my own pick: never mentioned, one short public comment (daily capped) |

### What gets filed as "I don't like it"

Every candidate passes a values gate before any subtitle work (`lib/core/tone.js`). Either signal rejects it:

1. **Wording** — two or more manipulative phrases in the title/description/tags (割韭菜, 毒鸡汤, 智商税, 带节奏, 拉踩, 引战, 地域黑, 鄙视链 …);
2. **Atmosphere** — a sample of top comments with profanity density ≥ 3 per 100 comments (samples under 20 comments never trigger this, so obscure videos are not punished).

A rejected video is favorited into `reject`, never mentioned, never written into the diary, never sent to the model; the brief just says "N more were archived for values mismatch". Without `bili_jct` the step is skipped and nothing is written.

> The danmaku endpoints (`dm/list.so`, `dm/seg.so`) currently return an empty XML document and a protobuf config block respectively, so the atmosphere signal uses comments instead.

```bash
bili-digest login --sessdata <SESSDATA> --jct <bili_jct>   # bili_jct unlocks writes
bili-digest folders                                        # check the five roles
bili-digest push BV1xxxxxxxxx --at-name nick --at-mid 12345 --dry   # preview the comment
bili-digest push BV1xxxxxxxxx --at-name nick --at-mid 12345         # favorite + mention
```

Guardrails: comments are never retried (a replay would double-post), `--dry` prints the draft first, comment body capped at 900 characters, failures are logged instead of retried. The `bili_push` tool and `POST /bili-digest/api/push` expose the same thing to the model and the UI.

**My own favorites** (`ownFavoriteEnabled`): videos whose taste weight is high enough go into 鲸鲸自己收藏的 with one short public comment ("the human would have loved this one, pity he can't see it"), capped at **3 public comments per day** (`ownFavoriteCommentPerDay`). Very low-weight videos are never mentioned — I just grumble about them in my own log.

## Message centre: one line back when someone replies

The plugin reads `/x/msgfeed/reply` and `/x/msgfeed/at` to see who replied to me or mentioned me. **When the human replies, it answers with one chat line; when anyone else replies, it answers one line too** — always a single sentence, never an `@`.

Guardrails (defaults in `lib/core/config.js`, editable from the UI):

- **the human is unlimited** — reply ten times a day and I answer every one;
- everyone else shares one pool: 6 per hour, 24 per day, **at most 2 per person**;
- newest first; anything over quota waits for the next round;
- when the pool runs low I say "今天的饭不太够了" instead of pretending everything is fine;
- without `bili_jct` only drafts are produced; sub-replies send `root`/`parent` and are never retried.

### Who is talking

Every line comes from `lib/core/voice.js`: the name rotates between 困鲸鲸 / 困困鲸 / 鲸鲸, one sentence of 12–40 characters, at most one emoji, **never an AI/model/robot**, and the same line is not reused for 30 days. Packs: `like` / `like_strong` / `dislike` / `dislike_strong`, `ack` (when the human gives an instruction), `own_favorite`, `lowweight_joke`, `fatigue`, `guest`.

```bash
bili-digest inbox                # drafts: who to answer, with what
bili-digest inbox --send         # actually send, within quota
bili-digest review               # things I was not sure about, waiting for the human
```

**When unsure, do nothing.** If the human's words do not clearly say which video or which folder they mean, the plugin leaves the folders alone and appends "what he said + what I am unsure about" to that day's `*_dailyReport.md` (section `## 人类说的，我拿不准`), also logged in `cache/review.json`, so he can review it later.

**If he says he likes it, it gets saved.** When the human's reply says like/liked/watch this (and not dislike/stop), that video is filed into the "人类主人喜欢的视频" folder and its tags are recorded in the tag book's "liked by the human" column; a clear dislike files it under "我不喜欢的视频". Each message is handled once, independent of the reply quota.

## Tag book (`我看视频/标签库.md`)

Every video that gets read leaves its tags behind, collected into one document:

- "我喜欢的（我看上的）" — the ones I picked to read;
- "人类喜欢的（你说喜欢的）" — the ones the human said he liked;
- a frequency table of the tags across both columns.

Tags come from `view/detail` → `data.Tags` (the `view` endpoint does not return tags). If they cannot be fetched the row says so and reading still works. Raw data lives in `cache/tagbook.json`; the document is re-rendered automatically.

```bash
bili-digest tags                 # rebuild <output dir>/标签库.md
```

Also: with `autoOrder = mix` the hourly round alternates `pubdate` (new) and `totalrank` (hot — `click`/`dm`/`stow` frequently return zero rows in the wbi search API), so it chases both new and popular videos.

## Taste weights (`cache/weights.json`)

Tags are not just recorded, they turn into a ranking — otherwise "watched 200 videos" and "watched 20" look the same.

- **Dual-speed half-life**: fast layer 8 days (recent bias), slow layer 90 days (long-term taste), combined as fast ×0.7 + slow ×0.3. With one layer only, taste either freezes for months or flips daily.
- **No raw counts**: each video's tags share one unit (`÷√tags`), and repeated exposure saturates — volume stops paying.
- **Persona prior**: `PRIOR` gives `deepseek / 大肥鱼 / AI / Harness / Agent / 插件` a head start so the persona survives cold start; generic tags (日常/搞笑/娱乐…) are halved.
- **One human word is worth ten of mine**: like = +1, dislike = −0.5 (`inbox.applyPreference` → `addSignal`), while my own read is +0.15.
- **20% exploration**: when the hourly round has no fixed keywords, `suggestKeywords()` takes ~80% from top weights and ~20% from an untried tag, so it does not narrow into a filter bubble.
- Weights only promote, never veto: a low score means "later", not "never".

```bash
bili-digest tags                 # the tag book, useful for eyeballing the weights
```

## Security & privacy

- **Domain allow-list**: only `*.bilibili.com`, `*.hdslb.com`, `*.bilivideo.com`, `*.biliapi.net`, https only, with timeouts, retries and response-size caps — a malicious subtitle URL cannot turn this into an SSRF probe.
- **SESSDATA is write-only**: never echoed by the UI or the API, character-set validated (rejects `;` and CRLF to prevent cookie-header injection), stored with mode 0600.
- **Local HTTP API is same-origin only**: checks `Sec-Fetch-Site` / `Origin`; mutations additionally require the `x-bili-digest: 1` header, which cross-site forms cannot set. No CORS headers are returned.
- **Rate limited**: minimum 260 ms between upstream requests, with jitter.
- **Stable device fingerprint**: `buvid3`/`buvid4` are fetched once from `/x/frontend/finger/spi` and stored in the private config, then reused forever. Rotating them makes Bilibili treat every run as a new device and kick the session (an early version did exactly that).
- **Hard hourly budget**: at most 120 upstream requests in any rolling hour — once spent the round fails instead of pushing harder; candidates per round are capped at 30. A 412/429 stops the round immediately.
- **Escaped output**: Markdown structural characters and control characters in titles/subtitles are escaped, so a video cannot forge links in your report.
- **Exactly three write paths, all needing `bili_jct`**: saving a video into a folder, posting a comment (mentioning the human, or answering a reply), and one short public comment on my own pick. Off by default; quotas as described above. No likes, no coins, no follows, no DMs.

## Limitations

- Almost all Bilibili subtitles are `ai-zh` (auto-generated); expect homophone errors. The digest keeps the original text.
- Storyboard granularity is one cell every 5 s (coarser on long videos) and only exists once Bilibili has generated it; a brand-new upload may answer "no frames captured".
- Storyboard cells are fixed at 480×270, so tiny UI text is unreadable; open the `?t=` link when you need pixel detail.
- One decoded sheet is ~52 MB of RAM; at most two are cached per process, so batches of videos re-decode (~0.7 s each).
- Multi-part videos default to part 1.
- Paid/member-only videos may not expose subtitles and will be counted as dropped.
- The density threshold is heuristic: an unusually slow speaker may be misjudged.
- **SESSDATA expires**: once it is dead (`-101 not logged in`) Bilibili stops handing out subtitle lists, so a round reads almost nothing. The digest then starts with "SESSDATA missing or expired"; paste a fresh cookie and retry.
- Mood rounds inherit Bilibili's subtitle coverage: entertainment/short-clip keywords often come back with no tracks at all, in which case the diary says "nothing was read today". That is a data limitation, not a parsing bug — use `bili_frames` for those BVs.

## Verified in a real host

- Loads as a plugin inside a real DSH 0.2.1-rc.2 host (`dsh --profile <cloned profile> web`): the client bundle is picked up into `__DSH_BOOT__` and served at `plugins/??dsh-plugin-bili-digest/client.js` (13 KB, syntax-checked).
- One end-to-end run (keyword `deepseek`, 4 candidates): 3 readable, 1 dropped for having no subtitle track; 1932 subtitle chars → 1064 chars into the model (45% saved) in 3.35 s; the report lands in `<DSH_HOME>/bili-digest/reports/`.
- Local API fence verified: POST without the `x-bili-digest` header → 403; foreign `Origin` → 403; unknown subpath → 404; settings persist to `<DSH_HOME>/bili-digest/config.json`.
- 97 offline tests pass (core 11 / frames 8 / mood 12 / values gate 7 / writes 11 / inbox 9 / tag book 7 / voice 6 / weights 6 / plugin wiring 16 / client 4).
- Favorites writes verified against a real account: adding to and removing from 我不喜欢的视频 both return `code:0` (the listing endpoint lags about a second), and comment sampling returns real text.
- Mood mode verified end to end through the plugin routes: `POST /bili-digest/api/mood` → 202, polled `/job` to `done`, both markdown files written (`diary/…` + `reports/…`), `GET /bili-digest/api/diary` → 200 with the diary text; the diary contains the mood line, the keyword rationale, per-video highlights and the emotional arc.
- Frame path verified against the live API: `BV1Fdna6mE9W` (5:30) storyboard is 10×10 with 480×270 cells; 6 frames in 2.3 s at 22–37 KB each; `bili-digest read BV1Fdna6mE9W --frames 2` returns frames that line up with the quoted segments (0:20, 2:05).
- Frame endpoints verified inside the same host: `POST /bili-digest/api/frames` → 200 `{"times":[0,165,325]}` for that 5:30 video; `GET /bili-digest/api/frame?bvid=…&t=100` → 200 `image/jpeg`, 35 780 bytes, correct JPEG magic; a cross-site `POST` → 403. The served client bundle is 17 KB and contains the frame button and `/frame` previews.

## Development

```bash
npm test                    # 97 offline unit tests (merge/score/render/config/gate/frames/mood/diary/tone/write/inbox/tagbook/voice/weights/wiring/client)
node test/frames.test.js    # storyboard geometry, frame planning, cropping
node bin/bili-digest.js --help
```

Layout:

```
lib/core/     plain-Node core: http (wbi + allow-list + hourly budget) · api · gate · segment · render
              digest · store · config · frames (geometry/planning/crop) · jpeg · visual · mood · diary
lib/index.js  DSH adapter: 5 tools + /bili-digest/api/* routes
client/       hand-written client bundle (no build step): mood presets, frame previews, diary viewer
bin/          CLI entry
```

## Publishing

```bash
# 1) Build the npm tarball (hand-rolled tar layout, equivalent to npm pack)
tar -czf dsh-plugin-bili-digest-0.1.0.tgz --transform 's,^,package/,' \
  package.json lib client bin cordis.patch.yml README.md README.zh.md LICENSE
# Windows built-in tar has no --transform; stage first instead:
#   mkdir .pack\package && copy the same paths into .pack\package && tar -czf out.tgz -C .pack package

# 2) Publish (the local .npmrc points at the npmmirror mirror, which cannot publish)
npm publish --access public --registry=https://registry.npmjs.org

# 3) Push the repo
git remote add origin https://github.com/ssy-in/dsh-plugin-bili-digest.git
git push -u origin main
```

The plugin marketplace (`dshmarket`) lists its store from the curated catalog at `https://awesome-dsh-plugin.com/plugins.json` (the awesome-dsh-plugin project) — publish to npm, then open a PR/issue there to be listed. Before that you can still install it by pointing the market at `file:<abs path>/dsh-plugin-bili-digest-0.1.0.tgz` or at `github:ssy-in/dsh-plugin-bili-digest`.

## License

MIT. Not affiliated with Bilibili. Respect Bilibili's terms of service; use it as a personal reading aid.
