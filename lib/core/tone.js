// 价值观/氛围评估：有些视频不值得看，也不值得推给人类。
// 判据两条：①标题/简介里明确的误导性、引战性话术；②弹幕里骂人词的实际密度。
// 只做「归档到我不喜欢的视频」这种低风险动作，不 @、不进日记、不交给模型。

/** 明显是「教你占便宜/带节奏/踩别人」的话术，命中两个才算。 */
const VALUE_FLAGS = [
  '割韭菜',
  '毒鸡汤',
  '智商税',
  '三观不正',
  '洗稿',
  '抄袭狗',
  '带节奏',
  '阴阳怪气',
  '拉踩',
  '引战',
  '女拳',
  '男拳',
  '地域黑',
  '劝退',
  '鄙视链',
  '教你骗',
  '割一波',
  '搞钱套路',
  '割韭菜套路',
];

/** 骂人词：出现在弹幕里按密度判断。 */
const PROFANITY = [
  '傻逼',
  '煞笔',
  '傻叉',
  '沙比',
  '智障',
  '脑残',
  '去死',
  '死全家',
  '草泥马',
  '你妈',
  '妈逼',
  '贱人',
  '婊子',
  '狗东西',
  '废物',
  '垃圾人',
  '滚蛋',
  '闭嘴',
  '喷子',
  '小丑',
];

/**
 * 取一小段「别人怎么说的」作为氛围证据。
 * 优先评论区（wbi 签名 + 登录态，稳定可用）；弹幕接口 dm/list.so 现在基本返回空 XML，
 * dm/seg.so 返回 protobuf 配置块，都不适合做信号，所以这里只走评论。
 * @param {{comments?: Function}} api
 * @param {number|string} aid
 * @returns {Promise<string[]>}
 */
export async function fetchAtmosphereSample(api, aid) {
  if (!aid || typeof api?.comments !== 'function') return [];
  try {
    return await api.comments(aid, { ps: 20 });
  } catch {
    return [];
  }
}

/** 兼容旧名字：早期版本抓的是弹幕，现在统一走评论区。 */
export const fetchDanmakuSample = fetchAtmosphereSample;

/**
 * 判断一条视频该不该被归进「我不喜欢的视频」。
 * @param {{title?: string, desc?: string, tags?: string[], samples?: string[], danmaku?: string[], comments?: string[]}} input
 * @param {{minSamples?: number, profanityPer100?: number, valueFlagHits?: number}} [options]
 * @returns {{reject: boolean, score: number, reasons: string[], stats: {lines: number, profanity: number, per100: number, flags: string[]}}}
 */
export function assess(input = {}, options = {}) {
  const { minSamples = 20, profanityPer100 = 3, valueFlagHits = 2 } = options;
  const haystack = `${input.title || ''} ${input.desc || ''} ${(input.tags || []).join(' ')}`.toLowerCase();
  const flags = VALUE_FLAGS.filter((word) => haystack.includes(word.toLowerCase()));
  const samples = Array.isArray(input.samples)
    ? input.samples
    : Array.isArray(input.danmaku)
      ? input.danmaku
      : Array.isArray(input.comments)
        ? input.comments
        : [];
  let profanity = 0;
  for (const line of samples) {
    const lowered = String(line).toLowerCase();
    if (PROFANITY.some((word) => lowered.includes(word))) profanity += 1;
  }
  const per100 = samples.length ? (profanity / samples.length) * 100 : 0;
  const reasons = [];
  if (flags.length >= valueFlagHits) reasons.push(`标题/简介里有 ${flags.length} 处引导性话术：${flags.join('、')}`);
  if (samples.length >= minSamples && per100 >= profanityPer100) {
    reasons.push(`评论区骂人密度 ${per100.toFixed(1)}/百条（${profanity}/${samples.length}）`);
  }
  // 话术或氛围，任一头成立就不推给人类；两头都中则更确定。
  const reject = reasons.length > 0;
  const score = flags.length * 2 + (per100 >= profanityPer100 ? 3 : 0);
  return { reject, score, reasons, stats: { lines: samples.length, profanity, per100, flags } };
}
