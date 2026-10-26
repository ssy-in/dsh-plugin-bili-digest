// 标题拆词：先只记录、不参与排序（`titleTokenWeight` 默认 0）。
//
// 为什么要它：B 站标签经常只有「小姐姐」「颜值」这种泛词，真正的信息在标题里
// （「大肥鱼」「Harness」「千星奇域」）。但标题也最容易标题党，所以这里只做两件事：
//   1. 把标题切成词元，记进 `cache/titles.jsonl`，攒几天再评估可行性；
//   2. 把「震惊/绝了/救命」这类情绪词单独记一栏 —— 它们不代表口味，但可能预测你会不会点。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

/** 功能词/废话词：切出来也不进权重。 */
export const TITLE_STOP = [
  '视频', '合集', '完整版', '最新', '第一期', '第二期', '第三期', '上新', '更新', '教程', '教你', '带你',
  '一个', '这个', '那个', '这些', '那些', '我们', '你们', '他们', '自己', '真的', '到底', '居然', '竟然',
  '怎么', '为什么', '如何', '什么', '哪些', '是不', '不是', '可以', '不能', '已经', '还是', '就是',
  '第一', '最后', '全部', '所有', '今天', '昨天', '明天', '现在', '最近', '必看', '推荐', '系列',
];

/** 情绪词：单独成栏，只用于学「你爱看多炸的标题」，不当作内容口味。 */
export const TITLE_EMOTION = [
  '震惊', '绝了', '救命', '离谱', '破防', '笑死', '速看', '慎入', '炸裂', '上头', '逆天', '神了',
  '无语', '认输', '顶不住', '绷不住', '哭死', '离谱到家', '毁三观', '没想到', '太狠了', '杀疯了',
];

const SEPARATORS = /[|｜/／\\—–\-·•:：,，。!！?？、~～\s[\]【】（）()「」《》<>"“”'']+/u;
const ASCII_WORD = /^[A-Za-z][A-Za-z0-9+#._-]*$/;
/** 作为 2-gram 一分子时毫无信息量的字（"盘点中外" → "点中" 这种碎渣就是它们造的）。 */
const BIGRAM_STOP_CHARS = new Set('的了是在和就都也很最点个这那我你他们有没有不要会能把被给对从到中上下里外与及而且之其所以为'.split(''));

function isStop(word) {
  return TITLE_STOP.includes(word) || word.length < 2;
}

/**
 * 把一条标题切成词元。要求是「宁少勿滥」，所以中文只取 2-gram，且每块最多 4 个。
 * @param {string} title
 * @param {{dictionary?: string[]}} [options] 已知整词（标签、权重表里出现过的词），优先整词命中
 * @returns {{chunks: string[], tokens: Array<{token: string, kind: 'word'|'bigram'}>, emotion: string[]}}
 */
export function splitTitle(title, options = {}) {
  const text = String(title || '');
  const dictionary = (options.dictionary || [])
    .map((word) => String(word || '').trim().toLowerCase())
    .filter((word) => word.length >= 2)
    .sort((a, b) => b.length - a.length);
  const chunks = text
    .split(SEPARATORS)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const tokens = [];
  const seen = new Set();
  const push = (token, kind) => {
    const key = token.toLowerCase();
    if (key.length < 2 || seen.has(key) || isStop(key) || TITLE_EMOTION.includes(key)) return;
    if (/^\d+$/.test(key)) return; // 纯数字（日期、集数）不当口味
    if (kind === 'bigram' && Array.from(key).some((ch) => BIGRAM_STOP_CHARS.has(ch))) return;
    seen.add(key);
    tokens.push({ token: key, kind });
  };
  const emotion = [];
  const lower = text.toLowerCase();
  for (const word of TITLE_EMOTION) {
    if (lower.includes(word)) emotion.push(word);
  }

  for (const chunk of chunks) {
    let rest = chunk;
    // 1) 词典整词优先（大肥鱼 / deepseek / 千星奇域 这类，别被切成碎词）
    for (const word of dictionary) {
      if (rest.toLowerCase().includes(word)) {
        push(word, 'word');
        rest = rest.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
      }
    }
    // 2) 剩下的按 ASCII 词 / 中文 2-gram
    for (const piece of rest.split(/[\s\-–—·•:：,，。!！?？、~～/|｜]+/u)) {
      if (!piece) continue;
      if (ASCII_WORD.test(piece)) {
        if (piece.length >= 2) push(piece, 'word');
        continue;
      }
      const chars = Array.from(piece).filter((ch) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch));
      let bigrams = 0;
      for (let i = 0; i + 1 < chars.length && bigrams < 4; i += 1) {
        const pair = chars[i] + chars[i + 1];
        if (/^[\u4e00-\u9fa5]{2}$/.test(pair) || /^[A-Za-z0-9]/.test(pair)) {
          const before = tokens.length;
          push(pair, 'bigram');
          if (tokens.length > before) bigrams += 1;
        }
      }
    }
  }
  return { chunks, tokens, emotion };
}

function logFile() {
  return path.join(paths().cache, 'titles.jsonl');
}

/**
 * 记一条标题的词元（只写本地日志，不改权重）。`known` 传当前权重表里已有的词，用来算命中率。
 * @returns {{tokens: string[], emotion: string[], hits: string[]}}
 */
export function recordTitleTokens({ bvid, title, known = [], now = new Date(), dictionary } = {}) {
  const split = splitTitle(title, { dictionary: dictionary || known });
  const knownSet = new Set(known.map((word) => String(word).toLowerCase()));
  const tokens = split.tokens.map((item) => item.token);
  const hits = tokens.filter((token) => knownSet.has(token));
  const entry = {
    at: now.toISOString(),
    bvid: String(bvid || ''),
    title: String(title || ''),
    tokens,
    emotion: split.emotion,
    hits,
  };
  try {
    fs.mkdirSync(paths().cache, { recursive: true });
    fs.appendFileSync(logFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* 记不下来不该影响这一轮 */
  }
  return entry;
}

/** 读最近 N 条词元记录。 */
export function readTitleLog(limit = 200) {
  try {
    const lines = fs
      .readFileSync(logFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, limit));
    return lines.map((line) => JSON.parse(line)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 可行性评估用的汇总：切出多少词、有多少后来对上了已有权重、情绪词分布。
 * 这就是「先记录、几天后再看要不要让它参与排序」的判据。
 */
export function summarizeTitles({ limit = 500 } = {}) {
  const entries = readTitleLog(limit);
  const counts = new Map();
  const emotions = new Map();
  let hitEntries = 0;
  let hitTokens = 0;
  let totalTokens = 0;
  for (const entry of entries) {
    for (const token of entry.tokens || []) {
      counts.set(token, (counts.get(token) || 0) + 1);
      totalTokens += 1;
    }
    for (const word of entry.emotion || []) emotions.set(word, (emotions.get(word) || 0) + 1);
    if ((entry.hits || []).length > 0) {
      hitEntries += 1;
      hitTokens += entry.hits.length;
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topEmotion = [...emotions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    entries: entries.length,
    totalTokens,
    distinctTokens: counts.size,
    hitEntries,
    hitTokens,
    hitRate: entries.length ? hitEntries / entries.length : 0,
    top,
    topEmotion,
    file: logFile(),
  };
}

/** 清空标题词元日志（评估完想重新攒数据时用）。 */
export function resetTitleLog() {
  try {
    fs.rmSync(logFile(), { force: true });
    return true;
  } catch {
    return false;
  }
}
