// 口味权重：把「看过什么 / 人类说过什么」变成一张能排序的标签权重表。
//
// 几个刻意的选择：
//   - 不用原始计数：热度饱和（c/(c+2)）+ 特异性（标签越大众越不值钱），否则话痨型 UP 的 20 个
//     标签会通吃，泛标签（"日常"、"搞笑"）也会压过真正对味的小众标签。
//   - 双速：快层半衰期 8 天（跟"最近偏爱"），慢层 90 天（跟"长期口味"），合计 0.7/0.3。
//     只留一层的话，要么三个月不变，要么一天一个口味。
//   - 人设先验：`PRIOR` 给 AI/插件/技术类一个底分，保证我先是"困鲸鲸"，再谈统计。
//   - 权重只加分、不否决：低分视频不是"不看"，只是"排在后面"。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { DEFAULTS } from './config.js';

/** 人设先验：这些标签天然加分（我本来就是看这些的鲸鱼）。 */
export const PRIOR = {
  人工智能: 0.35,
  AI: 0.35,
  deepseek: 0.4,
  大肥鱼: 0.45,
  Harness: 0.3,
  智能体: 0.3,
  Agent: 0.3,
  编程: 0.25,
  插件: 0.25,
  科技: 0.15,
  拟人: 0.2,
  鲸鱼: 0.2,
  // 人类点名要看的短视频题材（cos、游戏、二创）：给个先验，免得一上来就被当成「低权重」吐槽。
  cos: 0.3,
  Cosplay: 0.3,
  二次元: 0.28,
  MMD: 0.25,
  舞蹈: 0.2,
  游戏: 0.2,
  手游: 0.2,
  单机: 0.2,
  电竞: 0.2,
  二创: 0.2,
  动画: 0.18,
  原神: 0.15,
  绝区零: 0.15,
};

/** 泛标签：命中了也不太说明口味，压一压。 */
const GENERIC = new Set(['日常', '搞笑', '娱乐', '生活', '视频', '原创', '自制', '记录', '分享', '综合', '杂谈']);

/**
 * 明确的负向信号也记下来，但只用小幅扣分（避免一次误判把一类视频全埋了）。
 * `collect`/`uncollect` 是「我自己收进收藏夹 / 又拿出来」：主动表态，比只看一眼重得多。
 * `watch`（读进去就算一次）保留给手动调用，主流程默认不再用它——一天几十条全记一遍，
 * 标签表会被稀释成噪声（实测 92 个标签里 59 个只被看过一次）。
 */
const SIGNAL = { like_strong: 1.5, like: 1, collect: 0.5, uncollect: -0.5, dislike: -0.5, dislike_strong: -1.2, watch: 0.15 };

/** 两个人在同一个插件里，口味各存一份：鲸鲸自己的（weights.json）与人类主人的（human-weights.json）。 */
const FILES = { whale: 'weights.json', human: 'human-weights.json' };
const fileFor = (owner) => FILES[owner] || FILES.whale;

function weightsFile(owner = 'whale') {
  return path.join(paths().cache, fileFor(owner));
}

export function readWeights(owner = 'whale') {
  try {
    const parsed = JSON.parse(fs.readFileSync(weightsFile(owner), 'utf8'));
    return {
      tags: parsed && typeof parsed.tags === 'object' && parsed.tags ? parsed.tags : {},
      ups: parsed && typeof parsed.ups === 'object' && parsed.ups ? parsed.ups : {},
      updatedAt: parsed?.updatedAt || '',
    };
  } catch {
    return { tags: {}, ups: {}, updatedAt: '' };
  }
}

function writeWeights(state, owner = 'whale') {
  const file = weightsFile(owner);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位 */
  }
}

/** 半衰期衰减：过了 halfLifeDays 就剩一半，按指数算。 */
export function decay(value, halfLifeDays, elapsedDays) {
  if (!Number.isFinite(value) || value === 0) return 0;
  if (!(halfLifeDays > 0) || !(elapsedDays > 0)) return value;
  return value * 0.5 ** (elapsedDays / halfLifeDays);
}

function normTag(tag) {
  return String(tag || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * 记一次信号：一条视频的标签各分一份权重（标签越多，每个标签分到的越少）。
 * @param {{tags: string[], up?: string, signal?: keyof SIGNAL}} input
 */
export function addSignal({ tags = [], up = '', signal = 'watch', now = new Date(), config = DEFAULTS, owner = 'whale' } = {}) {
  const weight = SIGNAL[signal] ?? SIGNAL.watch;
  const list = [...new Set(tags.map(normTag).filter(Boolean))].slice(0, 20);
  if (list.length === 0) return readWeights(owner);
  const state = readWeights(owner);
  const share = weight / Math.sqrt(list.length);
  const stamp = now.toISOString();
  // 写入前先把旧值按半衰期衰减掉：不然「衰减只发生在读取时」会让常看的标签一路涨到无穷大
  // （人类 10-29 问「每个值都会越来越高是吗」——是的，那是 bug，这里补上）。
  const fastDays = Number(config?.halfLifeFastDays) || 8;
  const slowDays = Number(config?.halfLifeSlowDays) || 90;
  const capFast = Number(config?.weightCapFast ?? 0.8);
  const capSlow = Number(config?.weightCapSlow ?? 1.2);
  const decayed = (value, updatedAt, halfLifeDays) => {
    const elapsed = (now.getTime() - (Date.parse(updatedAt || '') || now.getTime())) / 86_400_000;
    return decay(Number(value || 0), halfLifeDays, elapsed);
  };
  for (const tag of list) {
    const current = state.tags[tag] || { fast: 0, slow: 0, seen: 0, likes: 0, updatedAt: stamp };
    state.tags[tag] = {
      fast: Math.min(capFast, decayed(current.fast, current.updatedAt, fastDays) + share),
      slow: Math.min(capSlow, decayed(current.slow, current.updatedAt, slowDays) + share),
      seen: Number(current.seen || 0) + 1,
      likes: Number(current.likes || 0) + (weight > 0 ? 1 : 0),
      updatedAt: stamp,
    };
  }
  if (up) {
    const key = String(up);
    const current = state.ups[key] || { fast: 0, slow: 0, seen: 0 };
    state.ups[key] = {
      fast: Math.min(capFast, decayed(current.fast, state.ups[key]?.updatedAt || '', fastDays) + weight),
      slow: Math.min(capSlow, decayed(current.slow, state.ups[key]?.updatedAt || '', slowDays) + weight),
      seen: Number(current.seen || 0) + 1,
      updatedAt: stamp,
    };
  }
  state.updatedAt = stamp;
  writeWeights(state, owner);
  return state;
}

/** 单个标签的合成权重：快层 ×0.7 + 慢层 ×0.3，热度饱和，泛标签压分，人设先验加分。 */
export function tagWeight(tag, state = readWeights(), now = new Date(), config = DEFAULTS, owner = 'whale') {
  const key = normTag(tag);
  const entry = state.tags[key];
  const fastDays = Number(config.halfLifeFastDays) || 8;
  const slowDays = Number(config.halfLifeSlowDays) || 90;
  const fastW = Number(config.fastWeight ?? 0.7);
  const slowW = Number(config.slowWeight ?? 0.3);
  let stat = 0;
  if (entry) {
    const elapsed = (now.getTime() - (Date.parse(entry.updatedAt || '') || now.getTime())) / 86_400_000;
    const fast = decay(Number(entry.fast || 0), fastDays, elapsed);
    const slow = decay(Number(entry.slow || 0), slowDays, elapsed);
    // 饱和：看得越多，边际越弱（c/(c+2) 的变形）。
    const seen = Number(entry.seen || 0);
    const saturate = Math.abs(slow) / (Math.abs(slow) + 2);
    stat = (fast * fastW + slow * slowW) * (seen > 0 ? 0.4 + 0.6 * saturate : 0);
  }
  // 人设先验只算鲸鲸自己的；人类的权重全靠他自己表态长出来，不替他预设喜欢什么。
  const prior = owner === 'whale' ? PRIOR[key] || 0 : 0;
  const penalty = GENERIC.has(key) ? 0.5 : 1;
  return Number(((stat + prior) * penalty).toFixed(4));
}

/** 一条视频的标签组得分：按 sqrt(标签数) 归一，避免标签多的白拿分。 */
export function scoreTags(tags = [], { state = readWeights(), now = new Date(), config = DEFAULTS, owner = 'whale' } = {}) {
  const list = [...new Set(tags.map(normTag).filter(Boolean))];
  if (list.length === 0) return { score: 0, parts: [] };
  const parts = list.map((tag) => ({ tag, weight: tagWeight(tag, state, now, config, owner) }));
  const sum = parts.reduce((acc, item) => acc + item.weight, 0);
  const score = sum / Math.sqrt(list.length);
  parts.sort((a, b) => b.weight - a.weight);
  return { score: Number(score.toFixed(4)), parts };
}

/** 权重最高的那些标签——自动刷时可以直接拿它当关键词。 */
export function topTags(limit = 8, { state = readWeights(), now = new Date(), config = DEFAULTS, owner = 'whale' } = {}) {
  const rows = Object.keys(state.tags).map((tag) => ({ tag, weight: tagWeight(tag, state, now, config, owner) }));
  return rows
    .filter((row) => row.weight > 0.02 && !GENERIC.has(row.tag))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(1, limit));
}

/**
 * 下一轮要搜什么词：大部分取高权重标签，留 `exploreRate` 给随机新标签（探索）。
 * 没有历史时返回空，让调用方回落到原来的关键词。
 */
export function suggestKeywords(limit = 3, { state = readWeights(), now = new Date(), config = DEFAULTS, random = Math.random } = {}) {
  // 大小写不同的同一个词只留权重最高的那个（deepseek / DeepSeek / Deepseek）。
  const seenLower = new Set();
  const ranked = topTags(12, { state, now, config }).filter((row) => {
    const key = row.tag.toLowerCase();
    if (seenLower.has(key)) return false;
    seenLower.add(key);
    return true;
  });
  const all = Object.keys(state.tags);
  if (ranked.length === 0) return { keywords: [], explored: [] };
  const exploreRate = Number(config.exploreRate ?? 0.2);
  const wantExplore = all.length > ranked.length && random() < exploreRate;
  // 按权重抽样而不是每次都拿前三名：高权重的更常被抽到，但不会每轮都是同一组词。
  const picked = [];
  const pool = ranked.map((row) => ({ ...row }));
  const want = Math.min(Math.max(1, limit), pool.length);
  while (picked.length < want && pool.length) {
    const total = pool.reduce((sum, row) => sum + Math.max(0.01, row.weight), 0);
    let roll = random() * total;
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      roll -= Math.max(0.01, pool[index].weight);
      if (roll <= 0) break;
    }
    picked.push(pool[index].tag);
    pool.splice(index, 1);
  }
  const explored = [];
  if (wantExplore) {
    const pickedLower = new Set(picked.map((tag) => tag.toLowerCase()));
    const pool = all.filter((tag) => !pickedLower.has(tag.toLowerCase()) && !GENERIC.has(tag));
    if (pool.length > 0) {
      const tag = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
      explored.push(tag);
      picked.push(tag);
    }
  }
  return { keywords: picked, explored };
}

/**
 * 冷启动判断：除了人设先验那几个词，有没有自己长出来的口味。
 * 「热」= 至少 minWarm 个非先验标签权重 ≥ warmBar。
 */
export function coldState({ state = readWeights(), now = new Date(), config = DEFAULTS, minWarm = 5, warmBar = 0.15, owner = 'whale' } = {}) {
  const priorLower = new Set(Object.keys(PRIOR).map((tag) => tag.toLowerCase()));
  const warm = topTags(30, { state, now, config, owner }).filter(
    (row) => row.weight >= warmBar && !priorLower.has(row.tag.toLowerCase()),
  );
  return { cold: warm.length < minWarm, warm: warm.map((row) => row.tag), minWarm, warmBar };
}

/**
 * 「这条视频人类会不会喜欢」的分。
 * 人类的权重表热起来了就用他的；还没热（冷启动）就临时借鲸鲸的口味，但标出来是借的。
 */
export function tasteScoreForHuman(tags = [], { now = new Date(), config = DEFAULTS } = {}) {
  const humanState = readWeights('human');
  const warm = !coldState({ state: humanState, now, config, owner: 'human' }).cold;
  const owner = warm ? 'human' : 'whale';
  const { score, parts } = scoreTags(tags, { state: warm ? humanState : readWeights('whale'), now, config, owner });
  return { score, parts, owner, borrowed: !warm };
}

export function resetWeights(owner = 'whale') {
  writeWeights({ tags: {}, ups: {}, updatedAt: new Date().toISOString() }, owner);
}
