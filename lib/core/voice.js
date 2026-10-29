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
// 写法规矩（人类 m06145 定的）：短句少标点，一句 0–2 个，问号叹号可以留；
// 用空格断句，口语一点，带上自己的人设和心情（困、馋、爱吃白饭、有点懒）。
export const PACKS = {
  like: [
    '{self}嗅到了 人类好像喜欢这种 我再去摸几条',
    '嘿嘿 人类点头了 {self}顺着这条再挖挖',
    '这个味对了 下次多盛一勺给人类',
    '{self}记小本本上了 过两天端几条像的来',
    '人类居然夸我了 {self}开心到多吃一碗饭',
    '懂了懂了 这种{self}以后多留意',
    '人类眼光不错 {self}再去刨几条对味的',
    '收到 {self}困归困 这种还是要找的',
  ],
  like_strong: [
    '人类说多来点 {self}把饭盆往这边挪了挪',
    '明白 这种加量 {self}这就去刨',
    '人类口味很明确了 {self}照着这个多找点',
    '这条线记死了 下次多盛两碗',
    '{self}一听多推就精神了 明天多带几条',
    '好嘞 这种塞进{self}的每日必看',
  ],
  dislike: [
    '行 这种先放放 {self}换个口味',
    '人类最近不太吃这个 {self}先收着',
    '知道啦 {self}挪到边上去了',
    '那{self}先收手 换条路子走走',
    '好吧 {self}有点小失落 下次找稳点的',
  ],
  dislike_strong: [
    '我也不喜欢 {self}丢进不喜欢的那个夹子了',
    '这条{self}也不太行 扔小黑屋了',
    '看出来了 {self}立刻打住 这种以后少端',
    '撤了撤了 {self}也觉得不太对劲',
  ],
  guest: [
    '谢谢捧场 {self}就是个爱看视频的小鲸鱼',
    '路过收下 祝你今天顺顺的',
    '哈哈 {self}记下了 慢慢看',
  ],
  // 人类给我下指令（多看看某类视频）时，应一声，别复读他的话。
  ack: [
    '好 {self}记下了 接下来多刷这条线',
    '{self}明白 明天多带几条你说的那种',
    '收到 {self}把力气往这边使',
    '行 {self}照着找 找到了来喊你',
    '记本子上了 {self}吃完饭就去干活',
    '好嘞 这条线{self}盯着',
  ],
  // 人类教我怎么调口味（@ 一条视频说「多看点这样的」）：应一声，别复读他的话。
  nudge_up: [
    '好 这条线{self}记下了 以后多往这边刨',
    '明白 {self}把这个味调重一点',
    '{self}也觉得不错 那这种往后多端几碗',
    '收到 {self}把劲儿往这边使',
    '记本子上了 {self}明天多带这种',
  ],
  nudge_dn: [
    '行 这种{self}往后少端',
    '{self}把这个味往低了调',
    '明白 那这路先收着 {self}换别的',
    '好 {self}记住了 以后少碰这类',
    '{self}把这条压下去了 换条路走',
  ],
  fatigue: [
    '今天的饭不太够了 {self}攒攒力气晚点来',
    '{self}快没劲儿了 白饭吃完了',
    '歇口气 {self}攒攒力气再说',
    '今天话有点多 {self}先去啃两口饭',
    '饭盆见底了 {self}明天再聊',
    '力气不太够 {self}先坐会儿',
  ],
  own_favorite: [
    '这个人类主人一定喜欢 {self}先替他收着',
    '人类主人平常最爱这种 可惜他看不到',
    '人类主人错过这条好可惜 {self}替他留着',
    '人类刷到肯定点头 {self}先收藏了',
    '这条对味 {self}塞进人类的小抽屉',
  ],
  lowweight_joke: [
    '这条嘛 {self}看完只想打哈欠',
    '凑数的 {self}替人类看完了',
    '一般般 {self}自己嚼两口就算了',
    '没啥意思 {self}看困了',
  ],
  unclear: [
    '{self}没太懂 等人类再说一句',
    '嗯 我猜不着 先不动 回头你指一下',
    '这条{self}拿不准 先记本子上',
  ],
  // 被问「今天心情怎么样」时的兜底句（有当下心情就用 moodPhrase 顶掉它）。
  mood_report: [
    '还行 说不上好坏',
    '就那样 有点犯懒',
    '还成 没出什么岔子',
    '凑合 混一天算一天',
  ],
  // @ 人类推视频时说的那一句：我觉得他会喜欢，带一点自己的心情。
  share: [
    '{self}刷到个好玩的 感觉人类会喜欢',
    '这个{self}看笑了 人类也来看看',
    '{self}困得不行还是想给你看这个',
    '看到这条第一个想到人类',
    '{self}偷偷觉得这条很对你胃口',
    '吃饭时刷到的 {self}觉得不错',
    '这个有点意思 {self}先给你端过来',
    '{self}挖到宝了 人类快看',
    '这条{self}觉得可以 你品品',
    '{self}今天心情不错 分你一条',
  ],
};

/**
 * 心情怎么"说出来"：只给一句人话，不给分数（心情值不外显，只有人类直接问才说个大概）。
 * key 与 persona 的 MOODS 对齐。
 */
export const MOOD_ASK = /(心情|状态怎么样|今天怎么样|还好吗|累不累|累吗|开心吗|高兴吗|怎么了|蔫不蔫)/;

export const MOOD_PHRASES = {
  delighted: ['今天精神特别好', '今天心情挺亮的', '今天状态在线', '今天整个人都松快'],
  content: ['今天还算舒服', '今天不赖', '今天心情挺稳', '今天挺好'],
  meh: ['今天一般般', '今天有点温吞', '今天没什么劲', '今天就这样吧'],
  grumpy: ['今天有点蔫', '今天不太得劲', '今天心里有点堵', '今天提不起兴趣'],
  miserable: ['今天有点想家', '今天不太想说话', '今天整个人都沉', '今天有点丧'],
  snug: ['这会儿窝着挺舒服', '这会儿正好窝着', '这会儿挺安生'],
  sleepy: ['这会儿有点犯困', '这会儿眼皮打架', '这会儿想睡一小觉'],
  glad: ['被叫到就精神了', '刚被叫到，正醒着呢', '一被叫就清醒了'],
  tired: ['今天说话有点多 想歇歇', '今天有点说不动了', '今天力气用得差不多了'],
  woken: ['刚被叫起来', '这才眯了一会儿', '刚睡下就醒了'],
  rice_call: ['正吃着白饭呢', '嘴里还有饭', '刚扒了两口饭'],
};

/** 取一句心情话；key 认不出就给个中性的。 */
export function moodPhrase(key, seed = Math.random()) {
  const pool = MOOD_PHRASES[key] || MOOD_PHRASES.content;
  return pool[Math.min(pool.length - 1, Math.floor(seed * pool.length))];
}

/**
 * 归属：这条到底是谁的口味。命中人类的关键词就说"我觉得这是你喜欢的"，
 * 命中我自己的关键词就说"这个是我自己喜欢的 让你看看"。
 */
export const ATTRIBUTION = {
  human: ['我觉得这是你喜欢的', '这条像你的口味', '应该是你会喜欢的', '这条你会看'],
  whale: ['这个是我自己喜欢的', '我自己挺喜欢这个', '这条我先收了 是我喜欢的', '我挺吃这一口'],
};

export function attributionFor(hit, seed = Math.random()) {
  const pool = ATTRIBUTION[hit] || ATTRIBUTION.human;
  return pool[Math.min(pool.length - 1, Math.floor(seed * pool.length))];
}

/** 两句话有没有说重复的事（连着的三个字一样就算重复）。 */
function overlap(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length < 3 || right.length < 3) return false;
  for (let i = 0; i + 3 <= left.length; i += 1) {
    if (right.includes(left.slice(i, i + 3))) return true;
  }
  return false;
}

/** 评论开头那一句：心情 + 我在怎么刷 + 这是谁的口味（说重复了就少说一句）。 */
export function leadLine({ phrase, scene, hit = 'human', seed = Math.random() } = {}) {
  const attr = attributionFor(hit, seed);
  const bits = [phrase, overlap(phrase, scene) ? '' : scene, attr].filter(Boolean);
  const head = bits.join(' ');
  return hit === 'whale' ? `${head} 让你看看` : head;
}

/** 推视频时最后那句问话：短、口语，有时候干脆不问（人类会自己看心情回）。 */
export const ASK_TAILS = ['怎么样？', '如何？', '咋样？', '喜欢不？', '你看看？', '', '', ''];

export function pickAskTail(seed = Math.random()) {
  return ASK_TAILS[Math.min(ASK_TAILS.length - 1, Math.floor(seed * ASK_TAILS.length))];
}

/** 把一句话 + 问尾拼起来，用空格断开。 */
export function withTail(text, seed = Math.random()) {
  const tail = pickAskTail(seed);
  return tail ? `${text} ${tail}` : text;
}

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
