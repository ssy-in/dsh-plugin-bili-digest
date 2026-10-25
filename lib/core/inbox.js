// 消息中心：读「回复我的 / @我的」，按配额挑出该回的那几条，回一句聊天的话。
//
// 规则（人类定的）：
//   - 人类（主人）回我 → 一律回一句，不限额度（他一天最多回十来条）。
//   - 其他人也能回，但共用一个池子（默认 6 次/小时、24 次/天），同一个人最多 2 次。
//   - 从新到旧处理，超配额的留给下一轮；额度见底时用「饭不够了」这种话说清楚。
//   - 人类说的东西我判断不了归属 → 不塞收藏夹，把他的话 + 我的不确定写进日报，等他复盘。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { postForm, getJson } from './http.js';
import { createApi } from './api.js';
import { resolveFolders, dealFavorite, FOLDER_ROLES } from './write.js';
import { addToTagBook, syncTagBook, detectPreference } from './tagbook.js';
import { addSignal } from './weights.js';
import { peekLine, commitLine } from './voice.js';
import { appendTalk, syncTalks } from './talks.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 护栏：人类不限额，其他人共用一个池子。
 * perPerson 是「同一个人最多几次」——定 2 是给正常搭话留余地，又不至于被一个人刷屏。
 */
export const LIMITS = { otherPerHour: 6, otherPerDay: 24, otherPerPerson: 2 };
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function cookieOf(config) {
  const parts = [`SESSDATA=${config.sessdata}`];
  if (config.csrf) parts.push(`bili_jct=${config.csrf}`);
  if (config.buvid3) parts.push(`buvid3=${config.buvid3}`);
  return parts.join('; ');
}

function headers(config, referer = 'https://www.bilibili.com/') {
  return { 'user-agent': UA, referer, origin: 'https://www.bilibili.com', cookie: cookieOf(config) };
}

function ledgerFile() {
  return path.join(paths().cache, 'inbox.json');
}

/** 回复账本：谁回过、什么时候回过。用于算配额和防重复。 */
export function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

export function recordReply(entry, now = new Date()) {
  const ledger = readLedger();
  ledger.items = [...ledger.items, { ...entry, at: now.toISOString() }].slice(-500);
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.writeFileSync(ledgerFile(), JSON.stringify(ledger, null, 2));
  fs.chmodSync(ledgerFile(), 0o600);
  return ledger;
}

function bvidOf(...values) {
  for (const value of values) {
    const match = String(value || '').match(/BV[0-9A-Za-z]{10}/);
    if (match) return match[0];
  }
  return '';
}

/** 一条消息变成一个扁平结构，后面所有逻辑只看这个。 */
export function normalize(item, kind = 'reply') {
  const payload = item?.item || {};
  const user = item?.user || {};
  // 「回复 @某人 :」这种前缀是 B 站自己加的，剥掉再判断内容。
  const text = String(payload.source_content || payload.title || payload.content || '')
    .replace(/^\s*回复\s*@[^:：]{1,40}[:：]\s*/u, '')
    .trim();
  // 消息中心的字段名不太统一：@我的里 source_id 是那条新评论，回复我的里 source_id 是被回复的那条。
  const rpid = String(payload.source_id || item?.reply_id || payload.rpid || payload.rp_id || item?.id || '');
  const root = String(payload.root_id || item?.root_id || payload.source_id || rpid);
  return {
    id: `${kind}:${rpid || `${user.mid}-${item?.reply_time || item?.ctime || 0}`}`,
    kind,
    mid: String(user.mid || ''),
    nickname: String(user.nickname || ''),
    text,
    ctime: Number(item?.reply_time || item?.at_time || item?.ctime || 0),
    bvid: bvidOf(payload.uri, payload.native_uri, payload.source_content, payload.title),
    uri: String(payload.uri || payload.native_uri || ''),
    oid: String(payload.subject_id || payload.oid || ''),
    rpid,
    root,
  };
}

/** 拉「回复我的」和「@我的」。任一路失败不影响另一路。 */
export async function fetchMessages(config) {
  const messages = [];
  const errors = [];
  const routes = [
    ['reply', '/x/msgfeed/reply?platform=web&build=0&mobi_app=web'],
    ['at', '/x/msgfeed/at?platform=web&build=0&mobi_app=web'],
  ];
  for (const [kind, route] of routes) {
    try {
      const data = await getJson(`${API}${route}`, { headers: headers(config, 'https://message.bilibili.com/') });
      const items = data?.data?.items || [];
      for (const item of items) messages.push(normalize(item, kind));
    } catch (error) {
      errors.push({ kind, error: String(error?.message || error) });
    }
  }
  messages.sort((a, b) => b.ctime - a.ctime);
  return { messages, errors };
}

/** 现在还剩多少配额。人类的回话单独计数，不占池子。 */
export function quotaState(ledger = readLedger(), now = new Date(), { ownerMid = '', limits = LIMITS } = {}) {
  const time = now.getTime();
  const recent = ledger.items.filter((entry) => time - (Date.parse(entry.at || '') || 0) < DAY_MS);
  const isOwner = (entry) => Boolean(ownerMid) && String(entry.mid || '') === String(ownerMid);
  const others = recent.filter((entry) => !isOwner(entry));
  const hourUsed = others.filter((entry) => time - (Date.parse(entry.at || '') || 0) < HOUR_MS).length;
  const perPerson = {};
  for (const entry of others) perPerson[String(entry.mid || '')] = (perPerson[String(entry.mid || '')] || 0) + 1;
  return {
    hourUsed,
    dayUsed: others.length,
    ownerUsed: recent.filter(isOwner).length,
    perPerson,
    limits,
    hourLeft: Math.max(0, limits.otherPerHour - hourUsed),
    dayLeft: Math.max(0, limits.otherPerDay - others.length),
  };
}

/** 从新到旧挑该回的：人类不限额度；其他人按「同一人 2 次 + 共用池子」算。 */
export function pickPending(messages, quota, ownerMid = '') {
  const seen = new Set(readLedger().items.map((entry) => entry.id));
  const limits = quota.limits || LIMITS;
  const picked = [];
  const skipped = [];
  let hourLeft = quota.hourLeft;
  let dayLeft = quota.dayLeft;
  const personCount = { ...quota.perPerson };
  for (const message of messages) {
    if (!message.text) {
      skipped.push({ ...message, reason: '没有正文' });
      continue;
    }
    if (seen.has(message.id)) {
      skipped.push({ ...message, reason: '这一条已经回过了' });
      continue;
    }
    const toOwner = Boolean(ownerMid) && String(message.mid) === String(ownerMid);
    if (!toOwner) {
      const used = personCount[message.mid] || 0;
      if (used >= limits.otherPerPerson) {
        skipped.push({ ...message, reason: `${message.nickname || message.mid} 已经回过 ${used} 次了` });
        continue;
      }
      if (hourLeft <= 0) {
        skipped.push({ ...message, reason: '这一小时陪人聊天的额度用完了' });
        continue;
      }
      if (dayLeft <= 0) {
        skipped.push({ ...message, reason: '今天的额度用完了，明天再聊' });
        continue;
      }
      personCount[message.mid] = used + 1;
      hourLeft -= 1;
      dayLeft -= 1;
    }
    picked.push({ ...message, toOwner });
  }
  return { picked, skipped };
}

const STRONG = /(特别|非常|超级|最喜欢|疯狂|多来|多推|一直|天天)/;

/**
 * 这一条该用哪种口气回。
 * 人类：说喜欢/不喜欢 → 对应的四档；下指令 → 应一声（ack）；其余 → 也按 ack 轻轻回。
 * 其他人：客气一份（guest）；池子快见底时改成「饭不够了」（fatigue），不装没事。
 */
export function replyIntent(message, { ownerMid = '', quota } = {}) {
  const toOwner = Boolean(ownerMid) && String(message.mid) === String(ownerMid);
  const said = String(message.text || '');
  if (!toOwner) {
    if (quota && quota.hourLeft <= 1) return 'fatigue';
    return 'guest';
  }
  const pref = detectPreference(said);
  if (pref === 'dislike') return STRONG.test(said) ? 'dislike_strong' : 'dislike';
  if (pref === 'like') return STRONG.test(said) ? 'like_strong' : 'like';
  return 'ack';
}

/** 回一句话：从人设池里挑，30 天内不重复，说出来才记账（草稿不占）。 */
export function buildReplyText(message, { ownerMid = '', quota, now = new Date(), seed } = {}) {
  const intent = replyIntent(message, { ownerMid, quota });
  const line = peekLine(intent, { now, seed });
  return { text: line.text, intent, key: line.key, self: line.self };
}

/** 发一条子回复（root=根评论，parent=被回的那条）。 */
export async function sendReply(config, message, text) {
  if (!config.csrf) throw new Error('还没有 bili_jct，回复没解锁');
  const body = String(text || '').trim();
  if (!body) throw new Error('回复内容为空');
  if (body.length > 400) throw new Error('回复过长（这里限 400 字）');
  if (!message.rpid) throw new Error('这条消息没有可回复的评论 id');
  const payload = {
    oid: String(message.oid || message.aid || ''),
    type: '1',
    message: body,
    root: String(message.root || message.rpid),
    parent: String(message.rpid),
    plat: '1',
    csrf: config.csrf,
  };
  const data = await postForm(`${API}/x/v2/reply/add`, payload, {
    headers: headers(config, message.bvid ? `https://www.bilibili.com/video/${message.bvid}/` : 'https://www.bilibili.com/'),
  });
  if (data.code !== 0) throw new Error(`回话失败：${data.code} ${data.message}`);
  return { code: data.code, rpid: data.data?.rpid_str || data.data?.rpid || '' };
}

/**
 * 人类说「喜欢/不喜欢」→ 收藏进对应夹子 + 记进标签库。
 * 他说喜欢却忘了收藏，这条就是补上的那一步。
 */
export async function applyPreference(config, message, kind, { save = () => {}, now = new Date(), api } = {}) {
  if (!message?.bvid) return { ok: false, reason: '这条消息里没有 BV 号，认不出是哪个视频' };
  const client = api || createApi(config);
  const video = await client.view(message.bvid);
  const target = kind === 'like' ? 'liked' : 'reject';
  let favorite = null;
  let mediaId = '';
  if (config.csrf) {
    try {
      const roles = await resolveFolders(config, save);
      mediaId = roles[target] || '';
      if (mediaId) {
        const res = await dealFavorite(config, { aid: video.aid, add: [mediaId] });
        favorite = res?.code === 0 ? 'ok' : 'failed';
      }
    } catch (error) {
      favorite = `failed: ${error?.message || error}`;
    }
  }
  addToTagBook(
    [{ bvid: message.bvid, title: video.title, tags: video.tags, note: kind === 'like' ? '人类说喜欢' : '人类说不要' }],
    'his',
    now,
  );
  // 人类的表态要算进权重：说喜欢 +1，说不要 −0.5（他一句顶我自己看十条）。
  try {
    addSignal({ tags: video.tags || [], up: video.owner?.mid || '', signal: kind === 'like' ? 'like' : 'dislike', now });
  } catch {
    /* 权重写失败不影响收藏动作 */
  }
  const book = syncTagBook(now);
  return {
    ok: true,
    kind,
    bvid: message.bvid,
    title: video.title,
    folder: FOLDER_ROLES[target]?.title || target,
    favorite,
    tagFile: book.file,
  };
}

/** 一整轮：拉消息 → 处理人类的偏好 → 挑该回的 → （可选）真发。默认只出草稿。 */
export async function runInbox({ config, send = false, now = new Date(), maxPerRun = 0, save = () => {} } = {}) {
  const { messages, errors } = await fetchMessages(config);
  const ledger = readLedger();
  const quota = quotaState(ledger, now, {
    ownerMid: config.atMid,
    limits: {
      otherPerHour: Number(config.otherReplyPerHour) || LIMITS.otherPerHour,
      otherPerDay: Number(config.otherReplyPerDay) || LIMITS.otherPerDay,
      otherPerPerson: Number(config.otherPerPerson) || LIMITS.otherPerPerson,
    },
  });

  // 先处理偏好：这属于「他说了喜欢就别忘了收藏」，跟回话额度无关，一人一次。
  const preferences = [];
  const handled = new Set(ledger.items.filter((entry) => entry.kind === 'pref').map((entry) => entry.id));
  for (const message of messages) {
    if (!config.atMid || String(message.mid) !== String(config.atMid)) continue;
    if (handled.has(`pref:${message.id}`)) continue;
    const kind = detectPreference(message.text);
    if (!kind) continue;
    try {
      const applied = await applyPreference(config, message, kind, { save, now });
      recordReply({ id: `pref:${message.id}`, kind: 'pref', mid: message.mid, nickname: message.nickname, text: message.text, pref: kind, bvid: message.bvid || '', favorite: applied.favorite || '' }, now);
      preferences.push({ ...message, pref: kind, applied });
    } catch (error) {
      errors.push({ kind: 'preference', error: String(error?.message || error) });
    }
  }

  const { picked, skipped } = pickPending(messages, quota, config.atMid);
  const capped = maxPerRun > 0 ? picked.slice(0, maxPerRun) : picked;
  const drafts = capped.map((message) => {
    const built = buildReplyText(message, { ownerMid: config.atMid, quota, now });
    return { ...message, ...built, incoming: message.text, replyText: built.text };
  });
  const replied = [];
  if (send) {
    for (const draft of drafts) {
      const result = await sendReply(config, draft, draft.text);
      commitLine({ key: draft.key, intent: draft.intent, self: draft.self }, now);
      recordReply({ id: draft.id, mid: draft.mid, nickname: draft.nickname, rpid: draft.rpid, text: draft.text, intent: draft.intent, sent: result.rpid }, now);
      // 对话流水：人类/别人说了什么、我怎么接的，都留一份，方便日后复盘。
      appendTalk({ who: String(draft.mid) === String(config.atMid) ? 'human' : 'other', kind: 'in', text: draft.incoming || '', ref: draft.id, at: now });
      appendTalk({ who: 'me', kind: 'out', text: draft.replyText || '', ref: result.rpid, at: now });
      replied.push({ ...draft, sentRpid: result.rpid });
    }
  }
  if (replied.length || preferences.length) {
    try {
      syncTalks({ generatedAt: now });
    } catch {
      /* 流水写不进去不影响收发 */
    }
  }
  return { total: messages.length, drafts: send ? [] : drafts, replied, skipped, errors, quota, preferences };
}

/** 人类说的东西我拿不准 → 不塞收藏夹，写进今天的日报等他复盘。 */
export function noteUnclear({ comment, bvid = '', guess = '', reason = '', now = new Date() } = {}) {
  const time = now.toISOString();
  const entry = { at: time, comment: String(comment || ''), bvid, guess, reason };
  const file = path.join(paths().cache, 'review.json');
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')).items || [];
  } catch {
    /* 第一次 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: [...list, entry].slice(-200) }, null, 2));
  fs.chmodSync(file, 0o600);

  // 追加到今天那份日报末尾，人一眼能看到。
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const report = path.join(paths().reports, `${stamp}_${bvid || 'manual'}_dailyReport.md`);
  const block = [
    '',
    '## 人类说的，我拿不准',
    '',
    `- 原话：${String(comment || '').slice(0, 200) || '（空）'}`,
    `- 我的猜测：${guess || '说不准他要把这条放哪儿'}`,
    `- 为什么没动：${reason || '怕放错收藏夹，先留在原处'}`,
    '- 等他复盘：对 / 不对',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.appendFileSync(report, block);
  } catch {
    /* 日报写不进去就算了，review.json 里还有 */
  }
  return { ok: true, file, report, entry };
}

export function readReview() {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths().cache, 'review.json'), 'utf8')).items || [];
  } catch {
    return [];
  }
}
