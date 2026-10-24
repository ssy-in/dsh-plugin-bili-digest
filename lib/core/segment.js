// 切段与打分：把字幕后切成 1–2 分钟的语义段，按关键词/结论词/数字密度/位置给每段打分。
const CONCLUDE = [
  '所以', '因此', '总结', '结论', '关键', '重点', '其实', '本质', '问题在于', '建议', '注意', '坑', '反而',
  '但是', '然而', '意味着', '第一', '第二', '核心', '原因', '区别', '对比', '代价', '成本', '风险', '好处',
  '优势', '缺点', '为什么', '比如', '举个例子', '也就是说', '换句话说',
];
const NUM_RE = /\d+([.,]\d+)?\s*(%|元|万|亿|倍|天|小时|分钟|秒|个|条|次|人|GB|MB|token|k|w)?/gi;
const SENTENCE_END = /[。！？!?；;]$/;
const CLAUSE_END = /[，,、]$/;

export const DEFAULT_SEGMENT = { maxGap: 1.4, maxChars: 120, maxDur: 28 };

/** 把任意长度的一句话切成 <= maxChars 的小块，尽量落在标点处。 */
export function splitText(text, maxChars) {
  const source = String(text || '');
  if (source.length <= maxChars) return source ? [source] : [];
  const parts = source.split(/(?<=[。！？!?；;，,、])/).filter(Boolean);
  const out = [];
  let buffer = '';
  for (const part of parts) {
    if ((buffer + part).length <= maxChars) {
      buffer += part;
      continue;
    }
    if (buffer) {
      out.push(buffer);
      buffer = '';
    }
    if (part.length <= maxChars) {
      buffer = part;
      continue;
    }
    for (let i = 0; i < part.length; i += maxChars) out.push(part.slice(i, i + maxChars));
  }
  if (buffer) out.push(buffer);
  return out;
}

/** 字幕 cue → 语义段（相邻小块按间隔/字数/时长/句末合并）。 */
export function mergeCues(cues, options = {}) {
  const { maxGap, maxChars, maxDur } = { ...DEFAULT_SEGMENT, ...options };
  const pieces = [];
  for (const cue of cues) {
    const chunks = splitText(cue.text, Math.min(maxChars, 60));
    if (chunks.length <= 1) {
      pieces.push({ from: cue.from, to: cue.to, text: cue.text });
      continue;
    }
    const span = Math.max(0.3, cue.to - cue.from);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    let consumed = 0;
    for (const chunk of chunks) {
      const from = cue.from + (span * consumed) / total;
      const to = cue.from + (span * (consumed + chunk.length)) / total;
      pieces.push({ from: +from.toFixed(2), to: +to.toFixed(2), text: chunk });
      consumed += chunk.length;
    }
  }
  const segments = [];
  let current = null;
  for (const piece of pieces) {
    if (!current) {
      current = { from: piece.from, to: piece.to, text: piece.text };
      continue;
    }
    const gap = piece.from - current.to;
    const mergedChars = current.text.length + piece.text.length;
    const mergedDur = piece.to - current.from;
    if (gap > maxGap || mergedChars > maxChars || mergedDur > maxDur || SENTENCE_END.test(current.text)) {
      segments.push(current);
      current = { from: piece.from, to: piece.to, text: piece.text };
    } else {
      current.text += (CLAUSE_END.test(current.text) ? '' : '，') + piece.text;
      current.to = piece.to;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** 中文没空格，标题按 2-gram 拆词才有用；英文单词整体保留。 */
export function expandKeywords(keywords, title = '') {
  const out = new Set();
  const push = (value) => {
    const token = String(value || '').trim().toLowerCase();
    if (token.length >= 2) out.add(token);
  };
  for (const raw of keywords || []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (/\s/.test(text)) text.split(/\s+/).forEach(push);
    else push(text);
  }
  const titleText = String(title || '').replace(/[\[\]【】()（）<>《》|/\\:：!?！？,，.。;；'"“”‘’\-_=+*#@$%^&~`]/g, ' ');
  for (const word of titleText.split(/\s+/)) {
    if (/^[A-Za-z0-9-]{2,}$/.test(word)) push(word);
    else if (word.length >= 4 && word.length <= 20) for (let i = 0; i + 2 <= word.length; i += 1) push(word.slice(i, i + 2));
  }
  return [...out];
}

export function scoreSegments(segments, { keywords = [] } = {}) {
  const list = keywords.map((keyword) => String(keyword).toLowerCase()).filter((keyword) => keyword.length >= 2);
  return segments.map((segment, index) => {
    const lower = segment.text.toLowerCase();
    const chars = segment.text.length;
    const duration = Math.max(0.5, segment.to - segment.from);
    const position = index / Math.max(1, segments.length - 1);
    const keywordHits = list.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 1 : 0), 0);
    const numberHits = (segment.text.match(NUM_RE) || []).length;
    const concludeHits = CONCLUDE.reduce((sum, word) => sum + (segment.text.includes(word) ? 1 : 0), 0);
    const positionBonus = position < 0.08 ? 1.2 : position > 0.92 ? 0.8 : 0;
    const density = chars / duration;
    const score =
      keywordHits * 2 + concludeHits * 1 + Math.min(numberHits, 5) * 0.5 + Math.min(density, 6) * 0.4 + positionBonus;
    return {
      ...segment,
      index,
      chars,
      duration: +duration.toFixed(1),
      density: +density.toFixed(2),
      keywordHits,
      numberHits,
      concludeHits,
      score: +score.toFixed(2),
    };
  });
}

function trigrams(text) {
  const clean = text.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 3 <= clean.length; i += 1) set.add(clean.slice(i, i + 3));
  return set;
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * 覆盖优先的贪心选段：分数最高的先入选，相邻 ±2 段降权，并跳过与已选内容高度重复的段。
 * @param {ReturnType<typeof scoreSegments>} scored
 */
export function pickSegments(scored, options = {}) {
  const { k = 8, maxChars = 3600, neighborPenalty = 2.5, duplicateThreshold = 0.7 } = options;
  const pool = scored.map((segment) => ({ ...segment, effective: segment.score }));
  const chosen = [];
  const chosenGrams = [];
  const taken = new Set();
  let chars = 0;
  while (chosen.length < k) {
    const candidates = pool.filter((segment) => !taken.has(segment.index)).sort((a, b) => b.effective - a.effective);
    const best = candidates[0];
    if (!best) break;
    taken.add(best.index);
    const grams = trigrams(best.text);
    if (chosenGrams.some((other) => similarity(grams, other) >= duplicateThreshold)) continue;
    if (chars + best.chars > maxChars && chosen.length >= 3) continue;
    chosen.push(best);
    chosenGrams.push(grams);
    chars += best.chars;
    for (const segment of pool) {
      if (taken.has(segment.index)) continue;
      const distance = Math.abs(segment.index - best.index);
      if (distance <= 2) segment.effective = +(segment.effective - neighborPenalty / Math.max(1, distance)).toFixed(2);
    }
  }
  return chosen.sort((a, b) => a.index - b.index);
}

export const stamp = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
