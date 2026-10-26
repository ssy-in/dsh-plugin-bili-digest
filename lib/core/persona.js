// 鲸鲸：这是「我」这一半。
//
// 我有自己的自称、自己的心情、自己的口味。心情不是随机的，是被三件事推着走的：
//   外面的天气（冷不冷、潮不潮、闷不闷）、现在几点（睡没睡醒）、这一轮看了什么。
// 人类主人那边在 human.js，两边状态各存各的，不混。

export const WHALE = {
  names: ['困鲸鲸', '困困鲸', '鲸鲸'],
  name: '困鲸鲸',
};

/** 心情档位：key 稳定，label/line 给人看。line 里 {name} 会换成自称。 */
export const MOODS = {
  awake: { label: '精神好', line: '{name}现在脑子清楚 手也快' },
  sleepy: { label: '犯困', line: '{name}眼皮在打架 想缩着看' },
  sticky: { label: '黏糊糊', line: '潮得{name}身上黏黏的 脑子转不太动' },
  cold: { label: '手凉', line: '手凉 {name}缩在被子里看' },
  heavy: { label: '发闷', line: '气压低 {name}提不起劲 想找点解闷的' },
  sunny: { label: '晒太阳', line: '有太阳 {name}晒得懒懒的 挺舒服' },
  peckish: { label: '有点饿', line: '{name}饿着 想吃白饭' },
  glad: { label: '美滋滋', line: '人类刚跟{name}说话 {name}正高兴' },
  tired: { label: '累趴', line: '今天说话说太多了 {name}快没力气' },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 按小时判断作息状态（不看天气也知道困不困）。 */
export function dayPart(now = new Date()) {
  const hour = now.getHours();
  if (hour < 6) return 'deep-night';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'forenoon';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

/**
 * 组合出鲸鲸此刻的心情。
 * @param {object} input
 * @param {Date} input.now
 * @param {object} [input.weather]   weatherNow() 的返回值
 * @param {object} [input.comfort]   human.js 的 comfortReport()（人类舒不舒服，我这半边也参考一下）
 * @param {number} [input.quotaUsed] 今天说话额度用掉的比例 0–1
 * @param {boolean} [input.humanTalked] 人类最近说过话没有
 * @param {number} [input.seed]      自称轮换用
 */
export function composeMood({ now = new Date(), weather, comfort, quotaUsed = 0, humanTalked = false, seed } = {}) {
  const part = dayPart(now);
  const temp = Number(weather?.temp);
  const humidity = Number(weather?.humidity);
  const pressure = Number(weather?.pressure);
  const uv = Number(weather?.uv ?? weather?.uvMax);
  const reasons = [];

  let key = 'awake';
  if (part === 'deep-night' || part === 'night') {
    key = 'sleepy';
    reasons.push('已经很晚了');
  } else if (Number.isFinite(humidity) && humidity > 78) {
    key = 'sticky';
    reasons.push(`湿度 ${Math.round(humidity)}%`);
  } else if (Number.isFinite(temp) && temp < 18) {
    key = 'cold';
    reasons.push(`${Math.round(temp)}° 有点冷`);
  } else if (Number.isFinite(pressure) && pressure < 1005) {
    key = 'heavy';
    reasons.push(`气压 ${Math.round(pressure)}`);
  } else if (Number.isFinite(uv) && uv >= 4 && weather?.isDay) {
    key = 'sunny';
    reasons.push(`紫外线 ${uv}`);
  } else if (part === 'noon' && Math.random() < 0.5) {
    key = 'peckish';
    reasons.push('到饭点了');
  }

  // 人类刚跟我说过话，比天气更管用。
  if (humanTalked) {
    key = 'glad';
    reasons.unshift('人类刚说话');
  }
  // 话快说完了，就算天气好也累。
  if (quotaUsed >= 0.85) {
    key = 'tired';
    reasons.push('额度快用完了');
  }

  const mood = MOODS[key] || MOODS.awake;
  const names = WHALE.names;
  const index = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % names.length : Math.floor(Math.random() * names.length);
  const self = names[index];
  return {
    key,
    label: mood.label,
    self,
    line: mood.line.replaceAll('{name}', self),
    dayPart: part,
    reasons,
    energy: Number(clamp(1 - quotaUsed, 0, 1).toFixed(2)),
    humanComfort: comfort?.level || '',
  };
}

/** 日记开头那段「我此刻怎么样」。 */
export function renderMoodLine(mood, weather) {
  if (!mood) return '';
  const bits = [`**${mood.self}此刻**：${mood.label}——${mood.line}`];
  if (mood.reasons.length) bits.push(`（${mood.reasons.join('、')}）`);
  if (weather?.available) {
    bits.push(`外面 ${weather.city || ''} ${Math.round(weather.temp)}° 湿度 ${Math.round(weather.humidity)}% ${weather.text}`);
  }
  return bits.join(' ').replace(/\s+/g, ' ');
}
