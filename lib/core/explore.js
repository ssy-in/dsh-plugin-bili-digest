/**
 * 每周探两个没见过的题材（人类 10-30 定）。
 *
 * 为什么单开一个文件：`suggestKeywords` 的探索是「每轮按 exploreRate 随机」，
 * 抽到的一瞬就没了，人类和日志都看不见「它这周到底在试什么」。这里按周落盘，
 * 一周固定挑几个题材出来试，试完不喜欢他说一句「少看点这类」就压下去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { isGeneric, normTag } from './weights.js';

function file() {
  return path.join(paths().cache, 'explore.json');
}

/**
 * 自然周的键：同一年同一周用同一个（ISO 周，周一算起）。
 * 全程用 UTC：之前一半 getFullYear 一半 getUTC*，东八区晚上跨零点会算出两个键，
 * 探索池在周日夜里被提前换掉。
 */
export function weekKey(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function readExplore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { week: String(parsed.week || ''), topics: Array.isArray(parsed.topics) ? parsed.topics : [], cursor: Number(parsed.cursor) || 0 };
  } catch {
    return { week: '', topics: [], cursor: 0 };
  }
}

function writeExplore(state) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2));
  fs.chmodSync(target, 0o600);
  return state;
}

/**
 * 这周该试哪些新题材。
 * `extra` 是首选候选（视频标签，最像题材），`hot` 是补位候选（站内热词，多是事件句）。
 * `known` 是我自己表里已有的标签。一周只挑一次，中途不再换 —— 换来换去等于哪个都没试。
 */
export function pickWeekly({ now = new Date(), config = {}, extra = [], hot = [], known = [], random = Math.random } = {}) {
  const want = Math.max(0, Math.min(10, Number(config.explorePerWeek ?? 2)));
  const week = weekKey(now);
  const state = readExplore();
  if (want === 0) return { ...state, week, topics: [], picked: false };
  if (state.week === week && state.topics.length) return { ...state, picked: false };
  const knownSet = new Set((known || []).map((tag) => String(tag).toLowerCase()));
  const seen = new Set();
  const clean = (list) => {
    const out = [];
    for (const raw of list || []) {
      const tag = normTag(typeof raw === 'string' ? raw : raw?.tag || raw?.keyword || '');
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (knownSet.has(key) || seen.has(key) || isGeneric(key)) continue;
      seen.add(key);
      out.push(tag);
    }
    return out;
  };
  // 先挑真·题材（视频标签），不够再用热词补：热词多是「XX 为什么赢了」这种事件句，
  // 当搜索词没问题，但不像「一个题材」，一周只试两个的时候不该全给它。
  const pool = clean(extra);
  const backup = clean(hot);
  const topics = [];
  while (topics.length < want && pool.length) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    topics.push(pool.splice(index, 1)[0]);
  }
  while (topics.length < want && backup.length) {
    const index = Math.min(backup.length - 1, Math.floor(random() * backup.length));
    topics.push(backup.splice(index, 1)[0]);
  }
  return { ...writeExplore({ week, topics, cursor: 0 }), picked: topics.length > 0 };
}

/** 这一轮拿哪个在试的题材去搜（轮着来，一周内不重复用同一个词霸屏）。 */
export function nextTopic(state = readExplore()) {
  if (!state.topics?.length) return '';
  const index = Math.max(0, state.cursor % state.topics.length);
  return state.topics[index];
}

/** 用过这个题材了，游标前挪一格。 */
export function advanceTopic(state = readExplore()) {
  return writeExplore({ ...state, cursor: (Number(state.cursor) || 0) + 1 });
}
