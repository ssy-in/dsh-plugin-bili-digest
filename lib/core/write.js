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
};

export const PUSH_PER_DAY = 3;

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
  const text = String(message || '').trim();
  if (!text) throw new Error('评论内容为空');
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

/** 今天已经 @ 过几条（每天最多 3 条）。 */
export function pushState(now = new Date()) {
  const file = path.join(paths().cache, 'push.json');
  let log = { date: '', count: 0, items: [] };
  try {
    log = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 第一次跑，用空账本 */
  }
  const today = stampDay(now);
  if (log.date !== today) return { file, today, count: 0, items: [], remaining: PUSH_PER_DAY };
  const count = Number(log.count) || 0;
  return { file, today, count, items: Array.isArray(log.items) ? log.items : [], remaining: Math.max(0, PUSH_PER_DAY - count) };
}

export function recordPush(entry, now = new Date()) {
  const state = pushState(now);
  const log = { date: state.today, count: state.count + 1, items: [...state.items, { ...entry, at: now.toISOString() }].slice(-20) };
  fs.mkdirSync(path.dirname(state.file), { recursive: true });
  fs.writeFileSync(state.file, JSON.stringify(log, null, 2));
  fs.chmodSync(state.file, 0o600);
  return { ...state, count: log.count, remaining: Math.max(0, PUSH_PER_DAY - log.count) };
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

function stampDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cookieOf(config) {
  return `SESSDATA=${config.sessdata}; buvid3=${config.buvid3}`;
}
