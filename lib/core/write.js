// 写操作：把视频收藏进指定收藏夹、在视频下发一条 @ 人类的评论（不 @ 的只归档）。
// 全部需要 bili_jct(csrf)；默认关闭，由调用方显式开启，且每天最多 @ 3 条。
import { getJson, postForm } from './http.js';
import { paths } from './store.js';
import fs from 'node:fs';
import path from 'node:path';

/** 收藏夹角色 → 配置里存的 media_id。标题只是给人看的默认值。 */
export const FOLDER_ROLES = {
  misc: { title: '默认收藏夹', hint: '没归类过的其他视频' },
  mood: { title: '我喜欢的视频', hint: '和当时心情对得上、有意思的' },
  deepseek: { title: '关于我的的视频', hint: 'deepseek 相关的学习和有趣的' },
  liked: { title: '人类主人喜欢的视频', hint: '人类点头之后才移进来的' },
  reject: { title: '我不喜欢的视频', hint: '宣扬不良价值观、引战骂人的；只归档，不打扰人类' },
  own: { title: '鲸鲸自己收藏的', hint: '按我自己的口味收的：不 @ 人类，只留一句短评' },
};

/**
 * 每天 @ 人类的数量分两条赛道：长视频（走字幕）与短视频（只抓画面）。
 * 测试期放宽（默认长 9 + 短 9 = 18 条/天），pushReduceAfterDays 天之后回落到长 5 + 短 3。
 */
export const PUSH_TRACKS = { long: 'long', short: 'short' };
export const PUSH_PER_DAY = 9; // 兼容旧调用：等于长视频档的默认上限

export function pushPlan(config = {}, now = new Date()) {
  const testDays = Number(config.pushReduceAfterDays) || 10;
  const start = Date.parse(config.pushTestStart || '') || 0;
  const elapsedDays = start ? (now.getTime() - start) / 86_400_000 : 0;
  const phase = start && elapsedDays >= testDays ? 'normal' : 'test';
  const longLimit = phase === 'normal' ? Number(config.pushDailyLongLater ?? 5) : Number(config.pushDailyLong ?? 9);
  const shortLimit = phase === 'normal' ? Number(config.pushDailyShortLater ?? 3) : Number(config.pushDailyShort ?? 9);
  return {
    phase,
    testDays,
    elapsedDays: Number(elapsedDays.toFixed(1)),
    longLimit,
    shortLimit,
    totalLimit: longLimit + shortLimit,
    start: config.pushTestStart || '',
  };
}

/** 第一次真发之前把测试起点记下来，否则「10 天后回落」永远不生效。 */
export function markPushStart(config, save, now = new Date()) {
  if (config?.pushTestStart) return config.pushTestStart;
  const start = now.toISOString();
  if (typeof save === 'function') save({ pushTestStart: start });
  return start;
}

/** 当天 0 点（本地时区）的 ISO 串：额度按天算，锚点也落在天边界上。 */
export function localDayStartIso(now = new Date()) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 测试期起点只在「某一天真发够了量」时才落定。
 * 理由：只发一两条的那天样本太少，不该开始倒计时；用户要求「刷够一半以上额度的第一天」才算。
 * 阈值 = ceil(totalLimit * pushStartAfterRatio)，默认 18 的半 = 9 条。
 */
export function maybeMarkPushStart(config, save, now = new Date()) {
  if (config?.pushTestStart) return config.pushTestStart;
  const plan = pushPlan(config, now);
  const ratio = Number(config?.pushStartAfterRatio);
  const threshold = Math.max(1, Math.ceil(plan.totalLimit * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.5)));
  const todayCount = pushState(now, config).count;
  if (todayCount < threshold) return '';
  const start = localDayStartIso(now);
  if (typeof save === 'function') save({ pushTestStart: start });
  return start;
}

const API = 'https://api.bilibili.com';

function requireCsrf(config) {
  if (!config.csrf) {
    throw new Error(
      '写操作需要 bili_jct：在 B 站网页版 Cookie 里复制 bili_jct 的值，然后 `bili-digest login --jct <值>`（只存本地 0600 文件，不打印）。',
    );
  }
  return config.csrf;
}

/** 读出账号下所有收藏夹：[{id, title, count}]。只读，SESSDATA 就够。 */
export async function listFolders(config) {
  if (!config.sessdata) throw new Error('列出收藏夹需要 SESSDATA');
  const me = await getJson(`${API}/x/web-interface/nav`, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieOf(config) } });
  const mid = me?.data?.mid;
  if (!mid) throw new Error(`读不到 mid：${me?.message || me?.code}`);
  const data = await getJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}&web_location=333.1387`, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieOf(config) },
  });
  if (data.code !== 0) throw new Error(`列收藏夹失败：${data.code} ${data.message}`);
  return (data.data?.list || []).map((folder) => ({ id: folder.id, title: folder.title, count: folder.media_count }));
}

/** 把收藏夹标题对到角色上：默认文件里只记标题，第一次用时解析成 media_id 存进配置。 */
export async function resolveFolders(config, save) {
  const existed = config.favFolders || {};
  const missing = Object.keys(FOLDER_ROLES).filter((role) => !existed[role]);
  if (!missing.length) return existed;
  const folders = await listFolders(config);
  const byTitle = new Map(folders.map((folder) => [folder.title, folder.id]));
  const next = { ...existed };
  for (const role of Object.keys(FOLDER_ROLES)) {
    if (next[role]) continue;
    const id = byTitle.get(FOLDER_ROLES[role].title);
    if (id) next[role] = id;
  }
  if (save && Object.keys(next).length !== Object.keys(existed).length) save({ favFolders: next });
  return next;
}

/**
 * 收藏 / 取消收藏一个视频。
 * @param {object} config
 * @param {{aid: number|string, add?: number[], del?: number[]}} options
 */
export async function dealFavorite(config, { aid, add = [], del = [] }) {
  const csrf = requireCsrf(config);
  if (!aid) throw new Error('缺少 aid');
  if (!add.length && !del.length) throw new Error('add 和 del 都是空的，没什么可做');
  const data = await postForm(
    `${API}/x/v3/fav/resource/deal`,
    {
      rid: String(aid),
      type: '2',
      add_media_ids: add.join(','),
      del_media_ids: del.join(','),
      csrf,
      platform: 'web',
    },
    { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/av${aid}/`, origin: 'https://www.bilibili.com', cookie: cookieOf(config) } },
  );
  if (data.code !== 0) throw new Error(`收藏失败：${data.code} ${data.message}`);
  return { code: data.code, add, del };
}

/** 发一条评论（可选 @ 某人）。不做重试：写操作重放会变成两条重复评论。 */
export async function postComment(config, { oid, message, atName, atMid }) {
  const csrf = requireCsrf(config);
  if (!oid) throw new Error('缺少 oid（视频 aid）');
  let text = String(message || '').trim();
  if (!text) throw new Error('评论内容为空');
  // B 站只有正文里真的写了「@昵称」才会发 @ 通知；自定义话术可能没带，这里统一补上。
  if (atName && atMid && !text.includes(`@${atName}`)) text = `@${atName} ${text}`;
  if (text.length > 900) throw new Error('评论过长（B 站上限 1000 字，这里留点余量）');
  const payload = {
    oid: String(oid),
    type: '1',
    message: text,
    plat: '1',
    csrf,
  };
  if (atName && atMid) {
    // @ 提示：正文里写 @名字，同时把 名字→mid 告诉服务端，否则只是纯文本。
    payload.at_name_to_mid = JSON.stringify({ [atName]: String(atMid) });
  }
  const data = await postForm(`${API}/x/v2/reply/add`, payload, {
    headers: {
      'user-agent': UA,
      referer: `https://www.bilibili.com/video/av${oid}/`,
      origin: 'https://www.bilibili.com',
      cookie: cookieOf(config),
    },
  });
  if (data.code !== 0) throw new Error(`发评论失败：${data.code} ${data.message}`);
  return { code: data.code, rpid: data.data?.rpid_str || data.data?.rpid || '' };
}

/** 今天已经 @ 过几条（长/短分开算）。 */
export function pushState(now = new Date(), config = {}) {
  const file = path.join(paths().cache, 'push.json');
  const plan = pushPlan(config, now);
  let log = { date: '', count: 0, items: [], tracks: {} };
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 第一次跑，用空账本 */
  }
  const today = stampDay(now);
  const tracks = log.date === today ? log.tracks || {} : {};
  const longUsed = Number(tracks.long) || 0;
  const shortUsed = Number(tracks.short) || 0;
  const count = log.date === today ? Number(log.count) || 0 : 0;
  const items = log.date === today && Array.isArray(log.items) ? log.items : [];
  return {
    file,
    today,
    count,
    items,
    tracks: { long: longUsed, short: shortUsed },
    plan,
    longRemaining: Math.max(0, plan.longLimit - longUsed),
    shortRemaining: Math.max(0, plan.shortLimit - shortUsed),
    remaining: Math.max(0, plan.totalLimit - count),
  };
}

export function recordPush(entry, now = new Date(), config = {}, save) {
  const state = pushState(now, config);
  const track = entry?.track === PUSH_TRACKS.short ? PUSH_TRACKS.short : PUSH_TRACKS.long;
  const tracks = { ...state.tracks, [track]: (state.tracks[track] || 0) + 1 };
  const log = { date: state.today, count: state.count + 1, items: [...state.items, { ...entry, track, at: now.toISOString() }].slice(-40), tracks };
  fs.mkdirSync(path.dirname(state.file), { recursive: true });
  fs.writeFileSync(state.file, JSON.stringify(log, null, 2));
  try {
    fs.chmodSync(state.file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位 */
  }
  // 发够量就落定测试起点（每天只可能触发一次，已存在则直接返回）。
  const next = { ...config };
  if (!next.pushTestStart) {
    const plan = pushPlan(next, now);
    const ratio = Number(next.pushStartAfterRatio);
    const threshold = Math.max(1, Math.ceil(plan.totalLimit * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.5)));
    if (log.count >= threshold) {
      next.pushTestStart = localDayStartIso(now);
      if (typeof save === 'function') save({ pushTestStart: next.pushTestStart });
    }
  }
  return pushState(now, next);
}

/** 按视频内容挑一个收藏角色：被判定为无价值 → reject；deepseek 相关 → deepseek；和心情对得上 → mood；其余 → misc。 */
export function roleForVideo({ mood, title = '', summary = '', keywords = [], rejected = false }) {
  if (rejected) return 'reject';
  const haystack = `${title} ${summary} ${(keywords || []).join(' ')}`.toLowerCase();
  if (/deepseek|大肥鱼|大飞鱼|ds-?v\d|harness/.test(haystack)) return 'deepseek';
  if (mood && mood.keywords && mood.keywords.some((word) => haystack.includes(String(word).toLowerCase()))) return 'mood';
  return 'misc';
}

/** 一句话总结：取第一个选中段落的第一句，压到 maxChars 以内。 */
export function oneLine(section, maxChars = 70) {
  const first = section?.picked?.[0]?.text || section?.segments?.[0]?.text || '';
  const raw = String(first).replace(/\s+/g, ' ').trim();
  const sentences = raw.split(/[。！？!?；;\n]/).map((part) => part.trim()).filter((part) => part.length >= 4);
  let sentence = sentences.find((part) => part.length >= 10) || sentences[0] || '';
  if (!sentence) return '';
  if (sentence.length > maxChars) {
    // 太长就退到第一个逗号处断句，读起来才像一句人话。
    const head = sentence.split(/[，,]/)[0].trim();
    sentence = head.length >= 10 ? head : sentence.slice(0, maxChars);
  }
  const clean = sentence.replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/** 拼出一条 @ 人类的评论：今天心情 → 为什么想发给你 → 一句话总结。 */
export function buildComment({ mood, section, atName }) {
  const tone = mood?.tone && mood.tone !== '按关键词' ? `今天心情：${mood.tone}` : '今天心情还不错';
  const why = mood?.keywords?.length ? `想找点「${mood.keywords.slice(0, 3).join('、')}」的东西` : '想随便看看';
  const line = oneLine(section) || section?.meta?.title || '';
  const mention = atName ? `@${atName} ` : '';
  return `${mention}${tone}，${why}。\n这条看完觉得值得给人类看看——${line}`;
}

/** 把「我不喜欢的视频」这类内容静默归档：只收藏，不 @、不进日记。没有 csrf 时直接跳过。 */
export async function vetoVideo(config, meta, save) {
  if (!config?.csrf || !meta?.aid) return { ok: false, skipped: config?.csrf ? '没有 aid' : '还没有 bili_jct' };
  const folders = await resolveFolders(config, save || (() => {}));
  const mediaId = folders.reject;
  if (!mediaId) return { ok: false, skipped: '没找到「我不喜欢的视频」收藏夹' };
  await dealFavorite(config, { aid: meta.aid, add: [mediaId] });
  return { ok: true, folder: FOLDER_ROLES.reject.title, bvid: meta.bvid };
}

/** 我自己收藏的账本：今天已经公开短评了几条（这个有日上限），以及收了几条。 */
export function ownLedger(now = new Date()) {
  const file = path.join(paths().cache, 'own.json');
  let log = { date: '', comments: 0, kept: [] };
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 第一次 */
  }
  const today = stampDay(now);
  if (log.date !== today) return { file, today, comments: 0, kept: [] };
  return { file, today, comments: Number(log.comments) || 0, kept: Array.isArray(log.kept) ? log.kept : [] };
}

export function recordOwn(entry, now = new Date()) {
  const ledger = ownLedger(now);
  const next = {
    date: ledger.today,
    comments: ledger.comments + (entry.commented ? 1 : 0),
    kept: [...ledger.kept, { ...entry, at: now.toISOString() }].slice(-200),
  };
  fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
  fs.writeFileSync(ledger.file, JSON.stringify(next, null, 2));
  try {
    fs.chmodSync(ledger.file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位 */
  }
  return { ...ledger, comments: next.comments, kept: next.kept };
}

/**
 * 收进我自己的收藏夹（不 @ 人类）。
 * 短评是「公开的」但很轻：「人类主人平常最喜欢这种了，可惜他看不到」这类——每天有上限。
 * 其余不公开的总结走日报/日记，不往视频底下写。
 */
export async function keepForSelf(config, { meta, weight = 0, comment = '', save = () => {}, now = new Date(), dayLimit } = {}) {
  if (!config?.csrf || !meta?.aid) return { ok: false, skipped: config?.csrf ? '没有 aid' : '还没有 bili_jct' };
  const folders = await resolveFolders(config, save);
  const mediaId = folders.own;
  let favorited = false;
  if (mediaId) {
    await dealFavorite(config, { aid: meta.aid, add: [mediaId] });
    favorited = true;
  }
  const limit = Number.isFinite(Number(dayLimit)) ? Number(dayLimit) : Number(config.ownFavoriteCommentPerDay ?? 3);
  const ledger = ownLedger(now);
  let commented = false;
  const wantComment = Boolean(comment) && ledger.comments < limit;
  if (wantComment) {
    await postComment(config, { oid: meta.aid, message: comment });
    commented = true;
  }
  const after = recordOwn({ bvid: meta.bvid || '', weight: Number(weight) || 0, commented, comment: commented ? comment : '' }, now);
  return {
    ok: true,
    folder: FOLDER_ROLES.own.title,
    favorited,
    commented,
    bvid: meta.bvid || '',
    commentsLeft: Math.max(0, limit - after.comments),
  };
}

function stampDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cookieOf(config) {
  return `SESSDATA=${config.sessdata}; buvid3=${config.buvid3}`;
}
