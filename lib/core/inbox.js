// 消息中心：读「回复我的 / @我的」，按配额挑出该回的那几条，回一句聊天的话。
//
// 规则（用户定的）：
//   - 人类（主人）回复我 → 回 1 句聊天；别人回复我 → 也回 1 句。
//   - 同一个人最多回 1 次；每小时最多 10 次；每天最多 50 次。
//   - 从新到旧处理，超配额的留给下一轮。
//   - 人类说的东西我判断不了归属 → 不塞收藏夹，把他的话 + 我的不确定写进日报，等他复盘。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { postForm, getJson } from './http.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 护栏：写操作再保守也不为过。 */
export const LIMITS = { perHour: 10, perDay: 50, perPerson: 1 };
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
  const text = String(payload.source_content || payload.title || payload.content || '').trim();
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

/** 现在还剩多少配额。 */
export function quotaState(ledger = readLedger(), now = new Date()) {
  const time = now.getTime();
  const recent = ledger.items.filter((entry) => {
    const at = Date.parse(entry.at || '') || 0;
    return time - at < DAY_MS;
  });
  const hourUsed = recent.filter((entry) => time - (Date.parse(entry.at || '') || 0) < HOUR_MS).length;
  const perPerson = {};
  for (const entry of recent) perPerson[String(entry.mid || '')] = (perPerson[String(entry.mid || '')] || 0) + 1;
  return {
    hourUsed,
    dayUsed: recent.length,
    perPerson,
    limits: LIMITS,
    hourLeft: Math.max(0, LIMITS.perHour - hourUsed),
    dayLeft: Math.max(0, LIMITS.perDay - recent.length),
  };
}

/** 从新到旧挑该回的：已回过的不回、同一人超额的不回、超总配额的不回。 */
export function pickPending(messages, quota, ownerMid = '') {
  const seen = new Set(readLedger().items.map((entry) => entry.id));
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
    const used = personCount[message.mid] || 0;
    if (used >= LIMITS.perPerson) {
      skipped.push({ ...message, reason: `${message.nickname || message.mid} 今天已经回过一次了` });
      continue;
    }
    if (hourLeft <= 0) {
      skipped.push({ ...message, reason: '这一小时的回话额度用完了' });
      continue;
    }
    if (dayLeft <= 0) {
      skipped.push({ ...message, reason: '今天的回话额度用完了' });
      continue;
    }
    personCount[message.mid] = used + 1;
    hourLeft -= 1;
    dayLeft -= 1;
    picked.push({ ...message, toOwner: Boolean(ownerMid) && message.mid === String(ownerMid) });
  }
  return { picked, skipped };
}

/** 回一句聊天的话：给人类一回熟一点，给别人一回客气一点。都很短。 */
export function buildReplyText(message, { ownerMid = '', mood = '' } = {}) {
  const toOwner = Boolean(ownerMid) && message.mid === String(ownerMid);
  const said = String(message.text || '').replace(/\s+/g, ' ').slice(0, 24);
  if (toOwner) {
    const tail = mood ? `今天惦记着「${mood}」，它这条挺对味。` : '这条我记下了，回头再给你找对味的。';
    return `${said ? `你说「${said}」，` : ''}收到。${tail}`;
  }
  return `${said ? `「${said}」这句我记住了，` : ''}谢谢搭话，我接着去看视频了。`;
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

/** 一整轮：拉消息 → 挑 → （可选）真发。默认只出草稿。 */
export async function runInbox({ config, send = false, now = new Date(), maxPerRun = 0 } = {}) {
  const { messages, errors } = await fetchMessages(config);
  const quota = quotaState(readLedger(), now);
  const { picked, skipped } = pickPending(messages, quota, config.atMid);
  const capped = maxPerRun > 0 ? picked.slice(0, maxPerRun) : picked;
  const drafts = capped.map((message) => ({ ...message, text: buildReplyText(message, { ownerMid: config.atMid }) }));
  const replied = [];
  if (send) {
    for (const draft of drafts) {
      const result = await sendReply(config, draft, draft.text);
      recordReply({ id: draft.id, mid: draft.mid, nickname: draft.nickname, rpid: draft.rpid, text: draft.text, sent: result.rpid }, now);
      replied.push({ ...draft, sentRpid: result.rpid });
    }
  }
  return { total: messages.length, drafts: send ? [] : drafts, replied, skipped, errors, quota };
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
