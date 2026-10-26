// 心情 → 搜索词：预设档位 + 自由文本里的情绪词都能转成关键词。
// 设计目标：让「按心情刷」这件事在离线、无模型的环境下也能跑通，且行为可解释。

export const PRESETS = [
  { id: 'relax', label: '想放松一下', tone: '低电量', keywords: ['轻松', '搞笑', '沙雕', '萌宠', '日常'] },
  { id: 'learn', label: '想学点东西', tone: '想输入', keywords: ['教程', '原理', '拆解', '科普', '复盘'] },
  { id: 'rant', label: '想听人吐槽', tone: '有火', keywords: ['吐槽', '锐评', '翻车', '对比'] },
  { id: 'hype', label: '想激动一下', tone: '亢奋', keywords: ['实测', '首发', '硬核', '震撼'] },
  { id: 'random', label: '随便看看', tone: '随意', keywords: ['热门', '开箱', '实验', '记录'] },
];

/** 情绪词 → 基调 + 补充关键词。命中越多的条目优先级越高。 */
const LEXICON = [
  { words: ['累', '疲惫', '困', '没劲', '摆烂', '放空', '不想动'], tone: '低电量', keywords: ['轻松', '日常', '治愈'] },
  { words: ['焦虑', '烦', '郁闷', 'emo', '丧', '难受', '压力', '内耗'], tone: '需要安抚', keywords: ['治愈', '慢节奏', '生活'] },
  { words: ['好奇', '想知道', '为什么', '了解', '看看'], tone: '好奇', keywords: ['科普', '原理'] },
  { words: ['学', '搞懂', '搞清', '提升', '复习', '研究'], tone: '想输入', keywords: ['教程', '拆解', '复盘'] },
  { words: ['气', '离谱', '恶心', '受不了', '吐槽'], tone: '有火', keywords: ['吐槽', '锐评', '翻车'] },
  { words: ['爽', '燃', '冲', '激动', '热血', '上头'], tone: '亢奋', keywords: ['硬核', '实测', '首发'] },
  { words: ['无聊', '空白', '随便', '都行', '没想法'], tone: '随意', keywords: ['热门', '开箱', '记录'] },
];

const HINT = /(?:关键词|搜索|搜一下|找一下|关于|想看的主题)[:：]?\s*([^\n；;。]{1,60})/;
const MAX_KEYWORDS = 8;
/** 明显不是搜索词的片段（语气、限定语）。 */
const NOISE = /^(?:点|些|一点|有点|不要|别|看|想|要|能|可以|就行|就好)/;

export function presetById(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return undefined;
  return PRESETS.find((preset) => preset.id === key || preset.label === id);
}

/** 从自由文本里认出用户点了哪个档位（例如「想放松」）。 */
export function pickPresetByKeyword(text) {
  const raw = String(text || '');
  return PRESETS.find((preset) => raw.includes(preset.label) || preset.keywords.some((keyword) => raw.includes(keyword)));
}

export function expandHint(text) {
  const match = HINT.exec(String(text || ''));
  if (!match) return [];
  return match[1]
    .split(/[、,，/\s+]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 12 && !NOISE.test(token));
}

/**
 * 解析一句心情。
 * @param {string} text 用户原话
 * @param {string} [presetId] 点选的档位 id
 * @returns {{raw: string, preset?: {id: string, label: string, tone: string, keywords: string[]}, tone: string, keywords: string[], matched: Array<{tone: string, words: string[]}>}}
 */
export function parseMood(text, presetId) {
  const raw = String(text || '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  const preset = presetById(presetId) || (raw ? pickPresetByKeyword(raw) : undefined);

  const matched = [];
  if (raw) {
    for (const entry of LEXICON) {
      const words = entry.words.filter((word) => raw.includes(word));
      if (words.length) matched.push({ tone: entry.tone, words });
    }
  }
  matched.sort((a, b) => b.words.length - a.words.length);

  const keywords = [];
  const push = (value) => {
    const token = String(value || '').trim();
    if (token && !keywords.includes(token) && keywords.length < MAX_KEYWORDS) keywords.push(token);
  };
  // 显式说出的关键词最可信，其次情绪词，再其次档位默认词。
  expandHint(raw).forEach(push);
  matched.forEach((entry) => {
    const source = LEXICON.find((item) => item.tone === entry.tone);
    if (source) source.keywords.forEach(push);
  });
  if (preset) preset.keywords.forEach(push);

  const tone = matched[0]?.tone || preset?.tone || '未命名';

  return { raw, preset, tone, keywords, matched };
}

/** 一句话解释这次心情被理解成了什么（写进日记开头）。 */
export function explainMood(mood) {
  const parts = [];
  if (mood.raw) parts.push(`你写的是「${mood.raw}」`);
  if (mood.preset) parts.push(`对上了「${mood.preset.label}」这一档`);
  if (mood.matched.length) parts.push(`听出来的情绪是${mood.matched.map((entry) => `${entry.tone}（${entry.words.join('、')}）`).join('、')}`);
  else parts.push(`情绪是${mood.tone}`);
  parts.push(mood.keywords.length ? `于是去找：${mood.keywords.join('、')}` : '这一轮没搜词，直接刷首页推荐');
  return `${parts.join('，')}。`;
}
