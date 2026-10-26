// 主流程：搜索 → 硬门槛 → 取字幕 → 切段打分 → 选段 → 报告。
import { createApi } from './api.js';
import { readVideo, VERDICT } from './gate.js';
import { mergeCues, scoreSegments, pickSegments, expandKeywords } from './segment.js';
import { renderReport, renderBrief } from './render.js';
import { renderDiary } from './diary.js';
import { parseMood } from './mood.js';
import { appendDailyDiary, appendDailyReport, cacheGet, cacheSet, filterFresh, markSeen, saveLastDigest } from './store.js';
import { loadConfig } from './config.js';
import { addToTagBook, entriesFromSections, syncTagBook } from './tagbook.js';
import { addSignal, readWeights } from './weights.js';
import { recordTitleTokens } from './titles.js';
import { collectFrames, saveFrames } from './visual.js';
import { weatherNow, placeFromConfig } from './weather.js';
import { comfortReport, describeHuman, humanProfile } from './human.js';
import { composeMood, weatherFeeling, fatigueState, readMeal, noteMeal, notePlace } from './persona.js';

const HOUR_MS = 3600_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(+value) ? +value : min));

/**
 * 解析 B 站搜索里的时长字段：可能是秒数，也可能是 "12:34" / "1:02:33"。
 * @returns {number} 秒数，解析不了返回 0
 */
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\[\]【】()（）<>《》|/\\:：!?！？,，.。;；'"“”‘’\-_=+*#@$%^&~`]/g, '');
}

/**
 * 热度分：播放、收藏、点赞取对数加权（收藏最能说明「值得看」）。
 * 粉丝量不参与，人类说麻烦可以不判断。
 */
export function hotScore(item = {}) {
  const log = (value) => Math.log10((Number(value) || 0) + 1);
  return log(item.play) + 1.5 * log(item.favorites) + 1.2 * log(item.like) + 0.3 * log(item.danmaku);
}

/**
 * 跑一轮阅读。
 * @param {{keywords?: string[], bv?: string, days?: number, limit?: number, k?: number, minCharsPerMinute?: number, config?: object, onProgress?: (event: object) => void}} options
 */
export async function run(options = {}) {
  const config = options.config || loadConfig();
  const api = createApi(config);
  const keywords = (options.keywords || []).map((keyword) => String(keyword).trim()).filter(Boolean).slice(0, 8);
  const minCharsPerMinute = clamp(options.minCharsPerMinute ?? config.minCharsPerMinute, 10, 600);
  const limit = clamp(options.limit ?? config.limit, 1, 30);
  const days = clamp(options.days ?? config.days, 0, 3650);
  const minDuration = clamp(options.minDuration ?? 0, 0, 4 * 3600);
  const fixedK = options.k !== undefined ? clamp(options.k, 1, 20) : 0;
  const order = ['pubdate', 'totalrank', 'click', 'dm', 'stow', 'scores'].includes(options.order) ? options.order : 'pubdate';
  const skipSeen = options.skipSeen === true;
  // 「一小时看一条」这类慢节奏：一轮最多读进去几条，剩下的留给下一轮。
  const maxVideos = clamp(options.maxVideos ?? 0, 0, 30);
  // 短视频可以单独给额度：maxShorts>0 时，长视频和短视频各算各的。
  const maxShorts = clamp(options.maxShorts ?? 0, 0, 30);
  const shortCap = maxShorts > 0 ? maxShorts : maxVideos;
  const totalCap = maxVideos > 0 ? maxVideos + (maxShorts > 0 ? maxShorts : 0) : 0;
  const seenDays = clamp(options.seenDays ?? config.seenDays ?? 14, 0, 3650);
  // 短视频赛道：≤N 秒的视频不看字幕，只看标签和画面（0 = 关掉）。
  const shortVideoMax = clamp(options.shortVideoMax ?? config.shortVideoMax ?? 0, 0, 1800);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const started = Date.now();
  // 先确认登录态：匿名态下 B 站不下发字幕清单，几乎什么都读不到，早报比事后猜原因好。
  let login = { isLogin: false, uname: '' };
  try {
    login = await api.me();
  } catch {
    // 网络抖动不该挡住整轮，交给后面的真实请求去暴露
  }

  /** @type {{bvid: string, title: string}[]} */
  let candidates = [];
  if (options.bv) {
    candidates = [{ bvid: String(options.bv).trim(), title: '' }];
  } else if (Array.isArray(options.candidates)) {
    // 首页推荐：候选已经由队列挑好了，这里只做去重和长短分流，不再搜索。
    candidates = options.candidates.filter((item) => item && item.bvid).slice(0, limit);
  } else {
    if (!keywords.length) throw new Error('至少给一个关键词，或用 bv 读单条视频');
    const seenBvid = new Set();
    const seenTitle = new Set();
    // 多个关键词时不能一口气被第一个词占满，否则「心情词」里的其它方向永远轮不到。
    let perKeyword = clamp(
      options.perKeyword ?? (keywords.length > 1 ? Math.ceil(limit / Math.min(keywords.length, 4)) : limit),
      1,
      40,
    );
    // 热门档要「先多收再排」：只收 limit 条再排序，等于在搜索排序的前 limit 条里挑，热的进不来。
    const hotMode = options.rankBy === 'hot';
    const collectCap = hotMode ? Math.max(limit, limit * 3) : limit;
    if (hotMode) perKeyword = Math.max(perKeyword, Math.ceil(collectCap / Math.max(1, Math.min(keywords.length, 4))));
    for (const keyword of keywords) {
      let added = 0;
      const found = await api.search(keyword, { pageSize: 20, days, order });
      onProgress({ phase: 'search', keyword, found: found.length });
      for (const item of found) {
        // 长视频要够长才值得读字幕；短视频走另一条赛道（只看标签 + 画面），不受时长门槛限制。
        const seconds = parseDuration(item.duration);
        const isShort = shortVideoMax > 0 && seconds > 0 && seconds <= shortVideoMax;
        if (minDuration > 0 && seconds < minDuration && !isShort) continue;
        const titleKey = normalizeTitle(item.title);
        if (seenBvid.has(item.bvid) || (titleKey && seenTitle.has(titleKey))) continue;
        seenBvid.add(item.bvid);
        if (titleKey) seenTitle.add(titleKey);
        candidates.push(item);
        added += 1;
        if (added >= perKeyword || candidates.length >= collectCap) break;
      }
      if (candidates.length >= collectCap) break;
    }
    // 热门档：按播放/收藏/点赞排一遍，先读最热的（粉丝量不看）。
    if (hotMode) candidates = candidates.sort((a, b) => hotScore(b) - hotScore(a)).slice(0, limit);
  }

  const sections = [];
  const shorts = [];
  const skipped = [];
  let charsIn = 0;
  let charsOut = 0;
  let deferred = 0;

  // 标题词元：只记录、不改权重（可选开关）。known 用来算「切出来的词有多少本来就在权重表里」。
  const titleKnown =
    options.learnTitleTokens === false
      ? null
      : (() => {
          try {
            const state = readWeights();
            return Object.keys(state?.tags || {});
          } catch {
            return [];
          }
        })();
  const noteTitle = (meta) => {
    if (!titleKnown) return;
    try {
      recordTitleTokens({ bvid: meta?.bvid, title: meta?.title, known: titleKnown });
    } catch {
      /* 记不下来不影响这一轮 */
    }
  };

  // 去重：同一批视频不必每天重复推。
  let toRead = candidates;
  if (skipSeen && !options.bv) {
    const { fresh, repeated } = filterFresh(candidates, { withinDays: seenDays });
    toRead = fresh;
    for (const item of repeated) {
      skipped.push({
        bvid: item.bvid,
        title: item.title,
        verdict: 'seen',
        reason: seenDays > 0 ? `最近 ${seenDays} 天内已经推过（${String(item.seenAt).slice(0, 10)}）` : '已经推过',
      });
    }
    onProgress({ phase: 'dedupe', candidates: candidates.length, fresh: fresh.length, repeated: repeated.length });
  }

  for (const [index, candidate] of toRead.entries()) {
    const ttl = Math.max(0, config.subtitleCacheHours) * HOUR_MS;
    const cacheKey = `sub:${candidate.bvid}`;
    let gate = ttl > 0 ? cacheGet(cacheKey, ttl) : undefined;
    const cached = Boolean(gate);
    if (!gate) {
      gate = await readVideo(api, candidate.bvid, {
        minCharsPerMinute,
        shortVideoMax,
        probeShortSubtitle: config.shortProbeSubtitle !== false,
        shortMinCharsPerMinute: config.shortMinCharsPerMinute,
      });
      if (ttl > 0 && gate.verdict === VERDICT.OK) cacheSet(cacheKey, gate);
    }
    onProgress({ phase: 'gate', index: index + 1, total: toRead.length, bvid: candidate.bvid, verdict: gate.verdict, cached });

    // 短视频：不算丢弃，进自己的通道（标签 + 画面），也占「一轮看几条」的额度。
    if (gate.verdict === VERDICT.SHORT) {
      const meta = gate.meta;
      // 短视频额度用完了就跳过（长视频还继续找）。
      if (shortCap > 0 && shorts.length >= shortCap) continue;
      shorts.push({ meta, tags: meta.tags || [], reason: gate.reason });
      noteTitle(meta);
      if (options.learnTags !== false) {
        try {
          addSignal({ tags: meta.tags || [], up: meta.owner?.mid || meta.owner?.name || '', signal: 'watch', config });
        } catch {
          /* 权重写不进去不该影响这一轮 */
        }
      }
      if (totalCap > 0 && sections.length + shorts.length >= totalCap) {
        deferred = Math.max(0, toRead.length - (index + 1));
        onProgress({ phase: 'pause', read: sections.length + shorts.length, deferred });
        break;
      }
      continue;
    }

    if (gate.verdict !== VERDICT.OK) {
      skipped.push({
        bvid: candidate.bvid,
        title: gate.meta?.title || candidate.title,
        verdict: gate.verdict,
        reason: gate.reason,
        assessment: gate.assessment,
      });
      // 价值观不合格的：只归档（收藏进「我不喜欢的视频」），不 @、不进日记、不交给模型。
      if (gate.verdict === VERDICT.REJECTED && typeof options.onVeto === 'function') {
        try {
          await options.onVeto({ meta: gate.meta, assessment: gate.assessment });
        } catch {
          /* 归档失败不影响这一轮继续 */
        }
      }
      continue;
    }

    const meta = gate.meta;
    const cues = gate.cues;
    const segments = mergeCues(cues, { maxChars: config.segmentChars });
    const scored = scoreSegments(segments, { keywords: expandKeywords(keywords, meta.title) });
    // 短视频（有字幕那种）段数少一点就够了，别把 2 分钟的切片塞成 8 段。
    const k = gate.short
      ? clamp(Math.round(meta.duration / 60), 1, 3)
      : fixedK || clamp(Math.round(meta.duration / 90), config.minK, config.maxK);
    const picked = pickSegments(scored, { k, maxChars: config.maxSegmentChars });
    const chars = picked.reduce((sum, segment) => sum + segment.chars, 0);
    charsIn += gate.chars;
    charsOut += chars;
    sections.push({ meta, picked, chars, track: gate.track, charsPerMinute: gate.charsPerMinute, cueCount: cues.length, short: Boolean(gate.short) });
    noteTitle(meta);
    // 我自己的口味：真读进去的视频给标签记一笔很轻的正分（0.15），
    // 人类说喜欢/不喜欢的时候再加一次更重的（见 inbox.applyPreference）。
    if (options.learnTags !== false) {
      try {
        addSignal({ tags: meta.tags || [], up: meta.owner?.mid || meta.owner?.name || '', signal: 'watch', config });
      } catch {
        /* 权重写不进去不该影响这一轮 */
      }
    }

    if (totalCap > 0 && sections.length >= maxVideos && sections.length + shorts.length >= totalCap) {
      deferred = Math.max(0, toRead.length - (index + 1));
      onProgress({ phase: 'pause', read: sections.length, deferred });
      break;
    }
  }

  const stats = {
    candidates: candidates.length,
    readable: sections.length + shorts.length,
    shorts: shorts.length,
    dropped: skipped.length,
    charsIn,
    charsOut,
    // 短视频字幕很短时"入模比原文还长"，这时候不该报负数，直接算 0（没省下东西）。
    saved: charsIn ? Math.max(0, Math.round((1 - charsOut / charsIn) * 100)) : 0,
    ms: Date.now() - started,
    keywords,
    minCharsPerMinute,
    minDuration,
    limit,
    maxVideos,
    shortVideoMax,
    deferred,
    order,
    seenSkipped: skipped.filter((item) => item.verdict === 'seen').length,
    login: { isLogin: Boolean(login.isLogin), uname: login.uname || '' },
  };
  const report = { sections, shorts, skipped, stats, generatedAt: new Date() };
  const markdown = renderReport(report);
  const brief = renderBrief(report);
  return { ...report, markdown, brief, dropped: skipped };
}

/** 跑一轮并落盘（报告 + last-digest.json）。 */
export async function runAndSave(options = {}) {
  const result = await run(options);
  const config = options.config || loadConfig();
  const file = appendDailyReport(result.markdown, { keep: config.keepReports });
  saveLastDigest({
    at: new Date().toISOString(),
    stats: result.stats,
    report: file,
    sections: result.sections.map((section) => ({
      bvid: section.meta.bvid,
      title: section.meta.title,
      up: section.meta.up,
      duration: section.meta.duration,
      chars: section.chars,
      picked: section.picked.map((segment) => ({ from: segment.from, to: segment.to, score: segment.score, text: segment.text.slice(0, 80) })),
    })),
    skipped: result.skipped,
  });
  return { ...result, report: file };
}

export { createApi, readVideo, VERDICT, loadConfig };

/** 按心情跑一轮：解析心情 → 搜索 → 阅读 → 报告 + 心情日记（给自己看的那份）。 */
export async function runMood(options = {}) {
  const config = options.config || loadConfig();
  // 两种入口：按心情（一句话/档位）解析关键词；或直接给关键词（「每小时看一条 deepseek 新视频」）。
  const fixedKeywords = (options.keywords || []).map((word) => String(word).trim()).filter(Boolean).slice(0, 8);
  const fromFeed = Array.isArray(options.candidates);
  const mood = fromFeed
    ? {
        // 首页轮没有搜索词：日记里写「随便刷刷首页」，再带上当时的作息状态。
        raw: options.moodText || '随便刷刷首页',
        tone: options.tone || '随便刷刷首页',
        preset: null,
        keywords: [],
        matched: [],
      }
    : fixedKeywords.length
    ? {
        raw: `关键词：${fixedKeywords.join('、')}`,
        tone: options.tone || '按关键词',
        preset: null,
        keywords: fixedKeywords,
        matched: [],
      }
    : parseMood(options.mood ?? options.text ?? '', options.preset);
  if (!fromFeed && !mood.keywords.length) {
    throw new Error('没听懂心情：写一句具体点的话，或直接选一个档位（relax / learn / rant / hype / random）');
  }

  // 先看一眼天气：下雨天我更想窝着看长视频，这一轮就不挑短视频了。
  let rainWantsLong = false;
  if (options.withWeather !== false) {
    try {
      const earlyWeather = await weatherNow({ now: new Date(), place: placeFromConfig(config) });
      rainWantsLong = Boolean(weatherFeeling(earlyWeather, { now: new Date() }).prefersLong);
    } catch {
      /* 拿不到天气就当没下雨 */
    }
  }

  const result = await run({
    keywords: mood.keywords,
    candidates: fromFeed ? options.candidates : undefined,
    days: options.days ?? config.days,
    limit: options.limit ?? config.limit,
    k: options.k,
    minCharsPerMinute: options.minCharsPerMinute,
    // 短视频基本没有 AI 字幕轨：心情模式默认只看 3 分钟以上的视频。
    minDuration: options.minDuration ?? config.minDuration ?? 180,
    shortVideoMax: rainWantsLong ? 0 : options.shortVideoMax ?? config.shortVideoMax ?? 0,
    order: options.order ?? 'totalrank',
    rankBy: options.rankBy,
    // 慢节奏默认：一轮只读一条（「一小时看一个」），其余留给下一轮。
    maxVideos: options.maxVideos ?? config.maxVideos ?? 1,
    // 短视频单独额度（首页轮会传 maxShorts:1）：不转发的话长短视频抢同一个 maxVideos 名额。
    maxShorts: options.maxShorts ?? config.maxShorts ?? 0,
    skipSeen: options.skipSeen !== false,
    seenDays: options.seenDays ?? config.seenDays,
    config,
    onVeto: options.onVeto,
    onProgress: options.onProgress,
  });

  const generatedAt = new Date();
  // 短视频：抓几张画面存下来，日记里只留一句"看了什么"，不写长总结。
  if (result.shorts?.length) {
    // 没有字幕的短视频就多给几帧：全片没有文字线索，只能靠画面。
    const baseFrames = Number(config.shortFramesNoSub ?? 6);
    const wanted = baseFrames === 0 ? 0 : clamp(baseFrames, 0, 10);
    if (wanted) {
      const api = createApi(config);
      for (const short of result.shorts) {
        try {
          const got = await collectFrames(api, short.meta.bvid, {
            cid: short.meta.cid,
            duration: short.meta.duration,
            count: wanted,
          });
          const saved = saveFrames(short.meta.bvid, got.frames);
          short.frames = saved.files.map((item) => ({ second: item.second, file: item.file }));
          short.frameDir = saved.dir;
        } catch {
          /* 抓不到画面就只留标签 */
        }
      }
    }
  }

  // 画面抓完再重渲一次报告，这样日报里也能看到"画面 N 帧"。
  if (result.shorts?.length) {
    result.markdown = renderReport({ sections: result.sections, shorts: result.shorts, skipped: result.skipped, stats: result.stats, generatedAt });
    result.brief = renderBrief({ sections: result.sections, shorts: result.shorts, skipped: result.skipped, stats: result.stats });
  }

  // 一天两个文件：<日期>_日记.md（给人看）、<日期>_日报.md（给我回查），每轮往后追加。
  const files = { diary: [], report: [] };
  // 我的心情 + 人类主人的处境：天气是两个人共同的背景，但各自解读。
  let weather;
  let feeling;
  let humanLine = '';
  if (options.withWeather !== false) {
    try {
      weather = await weatherNow({ now: generatedAt, place: placeFromConfig(config) });
      const profile = humanProfile(config);
      const comfort = comfortReport(weather, profile);
      // 在同一个城市住久了会适应一点（刚搬家按第 0 天算）。
      const stay = notePlace(weather, generatedAt);
      humanLine = describeHuman(weather, profile);
      // 这一轮看的东西的标签：用来判断「连看三条同类会烦」，也决定这一轮要不要记一条。
      const watchedTags = (result.sections?.[0]?.meta?.tags || result.shorts?.[0]?.meta?.tags || []).slice(0, 12);
      const fatigue = watchedTags.length ? fatigueState(watchedTags, { record: true, now: generatedAt }) : undefined;
      const meal = readMeal();
      feeling = composeMood({
        now: generatedAt,
        weather,
        comfort,
        quotaUsed: options.quotaUsed ?? 0,
        humanTalked: Boolean(options.humanTalked),
        tags: watchedTags,
        fatigue,
        lastMealAt: meal?.at,
        acclimatedDays: stay?.days ?? 0,
        seed: options.seed,
      });
      // 吃着白饭的这一轮，顺手把「上次吃饱」推到现在。
      // 只有「正吃着/刚吃完」才算吃过；「好久没吃白饭」这类句式不能记成刚吃（原来会误判，导致饥饿永远累积不起来）。
      if (feeling.rice && ['just_ate', 'eating'].includes(feeling.rice.key)) noteMeal({ at: generatedAt });
    } catch {
      // 天气/定位拿不到就不写这一段，别让整轮阅读失败。
    }
  }
  const diaryMarkdown = renderDiary({
    mood,
    sections: result.sections,
    shorts: result.shorts || [],
    skipped: result.skipped,
    stats: result.stats,
    generatedAt,
    feeling,
    weather,
    humanLine,
  });
  const diary = appendDailyDiary(diaryMarkdown, { keep: config.keepDiaries, generatedAt });
  const report = appendDailyReport(result.markdown, { keep: config.keepReports, generatedAt });
  files.diary.push(diary);
  files.report.push(report);
  markSeen(
    [
      ...result.sections.map((section) => ({ bvid: section.meta.bvid, title: section.meta.title, mood: mood.tone })),
      ...(result.shorts || []).map((short) => ({ bvid: short.meta.bvid, title: short.meta.title, mood: mood.tone })),
    ],
  );
  // 我看上的这些，连标签一起记进标签库（<out>/标签库.md 的「我喜欢的」那一栏）。
  try {
    addToTagBook(entriesFromSections(result.sections, { note: `心情：${mood.tone}` }), 'mine', generatedAt);
    addToTagBook(
      (result.shorts || []).map((short) => ({
        bvid: short.meta.bvid,
        title: short.meta.title,
        up: short.meta.up,
        duration: short.meta.duration,
        tags: short.tags || [],
        note: `短视频：${mood.tone}`,
      })),
      'mine',
      generatedAt,
    );
    syncTagBook(generatedAt);
  } catch {
    /* 标签库写不进去不该影响这一轮 */
  }
  saveLastDigest({
    at: generatedAt.toISOString(),
    mood: { raw: mood.raw, tone: mood.tone, preset: mood.preset?.id, keywords: mood.keywords },
    stats: result.stats,
    report,
    diary,
    files,
    sections: result.sections.map((section) => ({
      bvid: section.meta.bvid,
      title: section.meta.title,
      up: section.meta.up,
      duration: section.meta.duration,
      chars: section.chars,
      picked: section.picked.map((segment) => ({ from: segment.from, to: segment.to, score: segment.score, text: segment.text.slice(0, 80) })),
    })),
    skipped: result.skipped,
  });

  return { ...result, mood, diary, diaryMarkdown, report, files, feeling, weather, humanLine };
}
