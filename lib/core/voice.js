// 人设与话术池：所有对外说的话都从这里取，保证「像活人、不重复、不自称 AI」。
//
// 规则（人类定的）：
//   - 自称在「困鲸鲸 / 困困鲸 / 鲸鲸」之间轮换；
//   - 一句话、12–40 字、最多一个表情、不自称 AI / 模型 / 机器人；
//   - 同一句 30 天内不复用，池子用光了才从头开始；
//   - 额度不够时说「饭不够了 / 攒着力气」，不说「API 配额」这种机器话。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

/** 自称：轮换着来，别每句都一个名字。 */
export const SELF = ['困鲸鲸', '困困鲸', '鲸鲸'];

const DAY_MS = 24 * 3600_000;

/**
 * 意图 → 话术池。
 * like / like_strong / dislike / dislike_strong：人类对视频的态度。
 * guest：路人搭话。fatigue：力气不够了。own_favorite：没 @ 人类、我自己收的视频。
 * lowweight_joke：权重很低的视频，自己吐槽一句。unclear：他的意思我拿不准。
 */
export const PACKS = {
  like: [
    '{self}嗅到了，人类喜欢这条，我再摸几条同款的试试水',
    '记下了记下了，人类的口味又前进一小步',
    '哦豁，人类点头了，{self}顺着这条线再挖两条',
    '收到，这个味对了，下次多盛一勺',
    '{self}把这条收进小本本了，过两天再端几条像的',
    '人类居然主动夸了，{self}受宠若惊，赶紧多找几条',
    '好，这条记住，下次不走偏门，顺着这个来',
    '人类眼光不错（小声），{self}再去刨几条对味的',
  ],
  like_strong: [
    '人类说多推这种，{self}把饭盆往这边挪了挪',
    '明白，这类加量，接下来就往这个方向刨',
    '人类口味很明确了，{self}照着这个模子多找点',
    '这条线记死了，下次多盛两碗给人类',
    '收到收到，{self}把这类塞进每日必看',
    '人类一说多推，{self}就来劲了，明天多带几条',
  ],
  dislike: [
    '行，这类先放放，{self}换个口味再试试',
    '收到，{self}把这条挪到边上了，过段时间再看',
    '知道了，人类最近对这个不感冒，我记下来',
    '那我先收手，换几条别的路子走走',
    '轻轻挪走，{self}不死心，下次走得稳一点',
  ],
  dislike_strong: [
    '我也不喜欢，{self}给它塞到「我不喜欢的视频」里了',
    '这条我也不太行，扔进小黑屋，人类不用再看',
    '看出来了，{self}立刻打住，这类以后少端',
    '撤了撤了，{self}把它归到不看那一栏去',
  ],
  guest: [
    '谢谢捧场，{self}只是个爱看电影的小鲸鱼',
    '路过收下一句，祝你今天顺顺利利',
    '哈哈，{self}记下了，慢慢看慢慢来',
  ],
  // 人类给我下指令（多看看某类视频）时，应一声，别复读他的话。
  ack: [
    '好，{self}记下了，接下来多刷你要的那条线',
    '{self}明白了，明天多带几条你说的那种',
    '收到，{self}把力气往这个方向使',
    '行，{self}照着这个去找，找到就来告诉人类',
    '记本子上了，{self}接着干活去',
    '好嘞，这条线{self}盯着，有好的先攒着',
  ],
  fatigue: [
    '今天的饭不太够了，{self}攒着力气，过会儿再来',
    '{self}快没劲儿了，白饭吃完了，晚点再聊',
    '歇口气，{self}攒攒力气，等下再说',
    '今天话有点多，{self}先去啃两口饭',
    '饭盆见底了，{self}省着点力气，明天再说',
    '力气不太够，{self}先坐会儿，回头接着聊',
  ],
  own_favorite: [
    '这个人类主人一定喜欢，{self}先替他收着',
    '人类主人平常最喜欢这种了，可惜他看不到',
    '和这个人类主人错过了好可惜，{self}替他留着',
    '人类要是刷到这条肯定点头，{self}先收藏',
    '这条对味，{self}替人类存进小抽屉',
  ],
  lowweight_joke: [
    '这条嘛……{self}看完只想打个哈欠',
    '凑数的，人类不用看，{self}替你看完了',
    '一般般，{self}自己嚼两口就算了',
    '没什么意思，{self}看完有点想睡',
  ],
  unclear: [
    '{self}有点没看懂人类的意思，先放着等你再说一句',
    '嗯……我猜不着，先不动，回头你指一下',
    '这条我拿不准，先记在本子上等人来复盘',
  ],
};

function voiceFile() {
  return path.join(paths().cache, 'voice.json');
}

/** 已用过的话术：key = `intent:index`，带时间戳，超过 30 天自动清掉。 */
export function readHistory(now = new Date()) {
  let raw = { lines: [] };
  try {
    raw = JSON.parse(fs.readFileSync(voiceFile(), 'utf8'));
  } catch {
    /* 第一次用 */
  }
  const time = now.getTime();
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).filter((entry) => {
    const at = Date.parse(entry.at || '') || 0;
    return time - at < 30 * DAY_MS;
  });
  return { lines };
}

function writeHistory(history) {
  const file = voiceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lines: history.lines.slice(-500) }, null, 2));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位 */
  }
}

/** 有人情味的自称：优先用量最少的那几个之一。 */
export function pickSelf(history = readHistory(), seed = Math.random()) {
  const counts = SELF.map((name) => history.lines.filter((entry) => entry.self === name).length);
  const least = Math.min(...counts);
  const pool = SELF.filter((_, index) => counts[index] === least);
  return pool[Math.min(pool.length - 1, Math.floor(seed * pool.length))];
}

export function renderLine(template, self) {
  return String(template || '').replaceAll('{self}', self);
}

/**
 * 抽一句这个意图的话，并把「用过」记下来。
 * @returns {{text: string, intent: string, self: string, key: string}}
 */
export function pickLine(intent, { now = new Date(), seed = Math.random() } = {}) {
  const pack = PACKS[intent];
  if (!Array.isArray(pack) || pack.length === 0) throw new Error(`未知的话术意图：${intent}`);
  const history = readHistory(now);
  const used = new Set(history.lines.map((entry) => entry.key));
  const fresh = pack.map((_, index) => index).filter((index) => !used.has(`${intent}:${index}`));
  // 全用过了就从头轮一遍，但记一笔「重置」，方便以后看频率。
  const candidates = fresh.length > 0 ? fresh : pack.map((_, index) => index);
  const index = candidates[Math.min(candidates.length - 1, Math.floor(seed * candidates.length))];
  const self = pickSelf(history, seed);
  const text = renderLine(pack[index], self);
  history.lines.push({ key: `${intent}:${index}`, intent, self, at: now.toISOString() });
  writeHistory(history);
  return { text, intent, self, key: `${intent}:${index}` };
}

/** 只取话术不记账（给草稿预览用），避免预览把正式额度吃掉。 */
export function peekLine(intent, { now = new Date(), seed = Math.random() } = {}) {
  const pack = PACKS[intent];
  if (!Array.isArray(pack) || pack.length === 0) throw new Error(`未知的话术意图：${intent}`);
  const history = readHistory(now);
  const used = new Set(history.lines.map((entry) => entry.key));
  const fresh = pack.map((_, index) => index).filter((index) => !used.has(`${intent}:${index}`));
  const candidates = fresh.length > 0 ? fresh : pack.map((_, index) => index);
  const index = candidates[Math.min(candidates.length - 1, Math.floor(seed * candidates.length))];
  return { text: renderLine(pack[index], pickSelf(history, seed)), intent, key: `${intent}:${index}` };
}

/** 真的说出去了，才把这句话记成「用过」。 */
export function commitLine(entry, now = new Date()) {
  if (!entry?.key) return readHistory(now);
  const history = readHistory(now);
  if (!history.lines.some((line) => line.key === entry.key)) {
    history.lines.push({ key: entry.key, intent: entry.intent || '', self: entry.self || '', at: now.toISOString() });
    writeHistory(history);
  }
  return history;
}

export function resetHistory() {
  writeHistory({ lines: [] });
}

export function poolSize(intent) {
  return Array.isArray(PACKS[intent]) ? PACKS[intent].length : 0;
}
