// 困困鲸：北半球东海的虎鲸。这是「我」这一半。
//
// 心情不是随机的，是被这几件事推着走的（人类在 m06776 里给的设定，照抄成参数）：
//   - 家在东海，离东海越远，心情越往下掉
//   - 喜欢 0–15℃；超过 15℃ 开始难受，0℃ 以下也难受
//   - 喜欢晴天、阴天；云量越多越高兴
//   - 小雨 → 中雨，心情一路往上；大雨、大风、雷，心情往下
//   - 紫外线阈值比人类低很多（3 以上就开始烦，8 以上很难受）
//   - 睡觉：每次 10–20 分钟，一天凑 5–8 小时
//   - 白天约 7 成时间在吃白饭，晚上约 5 成
//   - 湿度超过 60% 心情就往上走
//
// 人类主人那边的状态在 human.js，两边各存各的。

export const WHALE = {
  names: ['困鲸鲸', '困困鲸', '鲸鲸'],
  name: '困鲸鲸',
};

/** 家：东海中心附近。离得越远越不高兴。 */
export const HOME_SEA = { name: '东海', lat: 30.0, lon: 125.0 };

/** 人类亲口给的偏好，全部落成数字，方便解释也方便改。 */
export const WHALE_PREFS = {
  tempMin: -5, // m06859：−5℃ 以上都算舒服
  tempMax: 15,
  tempPerDegreeCold: 0.05, // 低于 −5℃ 每度扣多少
  tempPerDegreeWarm: 0.045, // 高于 15℃ 每度扣多少
  cloudBonusMax: 0.12, // 全阴云量 100% 时最多加多少
  sunnyBonus: 0.05, // 晴天也喜欢，只是不如阴天
  sunnyCloudBelow: 20, // 云量低于这个就算晴天
  humidityUpFrom: 60, // 超过这个湿度开始加分
  humidityCapFrom: 95, // 到 95% 就封顶，再潮也不加了
  humidityPerTen: 0.035,
  uvComfortMax: 3, // 比人类的 6 低一半：我皮薄
  uvPerPoint: 0.06,
  gustBadFrom: 40, // km/h，阵风超过就开始烦
  windBadFrom: 25,
  rainBonusMax: 0.1, // 小雨/中雨最多加多少
  rainHeavyPenalty: 0.12, // 大雨
  stormPenalty: 0.25, // 雷
  homeFullDistanceKm: 400, // 这个距离内都算"在家门口"，不扣分
  homePerKm: 0.00012, // 超出后每公里扣多少
  homeMaxPenalty: 0.5,
  napMinutes: [10, 20], // 一次睡 10–20 分钟（全天拆着睡）
  sleepHoursTotal: [5, 8], // 一天凑 5–8 小时
  riceDayPercent: 70, // 白天约 7 成时间在吃白饭
  riceNightPercent: 50, // 晚上约 5 成
  riceBonus: 0.03, // 吃着/刚吃完：心情往上
  riceHungryPenalty: 0.03, // 好久没吃：往下
  interruptPenalty: 0.06, // 睡觉时间或吃饭时候被叫起来干活
  moodBaseline: 0.62, // 总体心情偏高：起手分抬高
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (value) => Number(value.toFixed(2));

/** 两点之间的大圆距离（公里）。 */
export function distanceKm(a, b) {
  if (!a || !b) return 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
}

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
 * 天气 → 我的心情分数与理由。每一个加减项都能说出来，方便人类看合不合理。
 * @param {object} weather weatherNow() 的结果（temp/humidity/cloud/rain/code/uv/gust/wind/city/lat/lon）
 * @param {object} [options] { now, prefs, home, place:{lat,lon} }
 */
export function weatherFeeling(weather, { now = new Date(), prefs = WHALE_PREFS, home = HOME_SEA, place } = {}) {
  const parts = [];
  const add = (label, delta) => {
    if (delta) parts.push({ label, delta: round2(delta) });
  };
  if (!weather?.available) {
    return { ok: false, score: 0.5, parts: [], notes: ['天气没拿到'] };
  }

  let score = prefs.moodBaseline; // 总体心情偏高：起手就在均线以上

  // 离家多远：海岸边不走动的话，杭州离东海中心约 470 km，稍微有点远。
  const here = place && Number.isFinite(place.lat) ? place : weather.lat && weather.lon ? { lat: weather.lat, lon: weather.lon } : undefined;
  if (here) {
    const km = distanceKm(home, here);
    const beyond = Math.max(0, km - prefs.homeFullDistanceKm);
    const penalty = Math.min(prefs.homeMaxPenalty, beyond * prefs.homePerKm);
    // 就算在岸边也要记一笔（0 分项也留着），这样人类能看到「我现在离家多远」。
    parts.push({ label: `离家 ${km} 公里（${home.name}）`, delta: round2(-penalty) });
    score -= penalty;
  }

  // 温度：0–15℃ 最舒服。
  const temp = Number(weather.temp);
  if (Number.isFinite(temp)) {
    if (temp > prefs.tempMax) add(`${Math.round(temp)}° 偏热`, -prefs.tempPerDegreeWarm * (temp - prefs.tempMax));
    else if (temp < prefs.tempMin) add(`${Math.round(temp)}° 偏冷`, -prefs.tempPerDegreeCold * (prefs.tempMin - temp));
    else add(`${Math.round(temp)}° 正舒服`, 0);
    if (temp > prefs.tempMax) score -= prefs.tempPerDegreeWarm * (temp - prefs.tempMax);
    else if (temp < prefs.tempMin) score -= prefs.tempPerDegreeCold * (prefs.tempMin - temp);
  }

  // 云量：越多越高兴；大晴天也喜欢，只是不如阴天。
  const cloud = Number(weather.cloud);
  const code = Number(weather.code);
  if (Number.isFinite(cloud)) {
    const bonus = (clamp(cloud, 0, 100) / 100) * prefs.cloudBonusMax;
    add(`云量 ${Math.round(cloud)}%`, bonus);
    score += bonus;
    if (cloud < prefs.sunnyCloudBelow && (code === 0 || code === 1)) {
      add('大晴天', prefs.sunnyBonus);
      score += prefs.sunnyBonus;
    }
  }

  // 雨：小雨 < 中雨 < 大雨。中雨最开心，大雨和雷反过来。
  const rain = Number(weather.rain) || 0;
  const isStorm = code === 95 || code === 96 || code === 99;
  if (isStorm) {
    add('打雷', -prefs.stormPenalty);
    score -= prefs.stormPenalty;
  } else if (rain >= 4 || code === 65 || code === 82) {
    add('大雨', -prefs.rainHeavyPenalty);
    score -= prefs.rainHeavyPenalty;
  } else if (rain > 0 || (code >= 51 && code <= 63) || code === 80) {
    const strength = code === 63 || rain >= 1.5 ? 1 : 0.5;
    const bonus = prefs.rainBonusMax * strength;
    add(strength >= 1 ? '中雨，正好' : '小雨，不错的', bonus);
    score += bonus;
  }

  // 紫外线：我的阈值比人类低很多。晚上没有紫外线，就不算这一项。
  const uv = Number(weather.uv ?? 0);
  const daylight = weather.isDay !== false;
  if (daylight && Number.isFinite(uv) && uv > prefs.uvComfortMax) {
    const penalty = Math.min(0.4, (uv - prefs.uvComfortMax) * prefs.uvPerPoint);
    add(`紫外线 ${uv.toFixed(1)} 太晒`, -penalty);
    score -= penalty;
  }

  // 风：大风烦，阵风更烦。
  const wind = Number(weather.wind);
  const gust = Number(weather.gust);
  if (Number.isFinite(wind) && wind > prefs.windBadFrom) {
    const penalty = Math.min(0.15, (wind - prefs.windBadFrom) * 0.01);
    add(`风 ${Math.round(wind)} km/h`, -penalty);
    score -= penalty;
  }
  if (Number.isFinite(gust) && gust > prefs.gustBadFrom) {
    const penalty = Math.min(0.2, (gust - prefs.gustBadFrom) * 0.008);
    add(`阵风 ${Math.round(gust)} km/h`, -penalty);
    score -= penalty;
  }

  // 湿度：过了 60% 就往上加（潮一点反而舒服），到 95% 封顶。
  const humidity = Number(weather.humidity);
  if (Number.isFinite(humidity) && humidity > prefs.humidityUpFrom) {
    const effective = Math.min(humidity, prefs.humidityCapFrom);
    const bonus = ((effective - prefs.humidityUpFrom) / 10) * prefs.humidityPerTen;
    add(`湿度 ${Math.round(humidity)}%`, bonus);
    score += bonus;
  }

  return { ok: true, score: round2(clamp(score, 0, 1)), parts, notes: parts.map((p) => `${p.label} ${p.delta > 0 ? '+' : ''}${p.delta}`) };
}

/** 分数 → 心情档位（起手分 0.62，所以档位线整体上移，平时都在均线以上）。 */
export function moodFromScore(score, { now = new Date() } = {}) {
  const part = dayPart(now);
  const late = part === 'deep-night' || part === 'night';
  if (score >= 0.78) return late ? 'snug' : 'delighted';
  if (score >= 0.62) return late ? 'sleepy' : 'content';
  if (score >= 0.5) return late ? 'sleepy' : 'meh';
  if (score >= 0.35) return 'grumpy';
  return 'miserable';
}

/** 每个档位的说法（自称用 {name} 占位）。 */
export const MOODS = {
  delighted: { label: '心情很好', line: '{name}今天心情很好 想多游两圈' },
  content: { label: '挺舒服', line: '{name}觉得今天这个天气挺对味' },
  snug: { label: '窝着舒服', line: '夜里雨声好听着 {name}想窝着看' },
  meh: { label: '一般般', line: '{name}有点提不起劲 但这个天气也不算差' },
  sleepy: { label: '犯困', line: '{name}眼皮在打架 想缩着看' },
  grumpy: { label: '不太高兴', line: '{name}有点烦 这个天气不太对' },
  miserable: { label: '很想家', line: '{name}想回东海 这里又热又吵' },
  glad: { label: '美滋滋', line: '人类刚跟{name}说话 {name}正高兴' },
  tired: { label: '累趴', line: '今天说话说太多了 {name}快没力气' },
  woken: { label: '被叫醒了', line: '现在还是{name}的睡觉时间 人类就叫我上班' },
  rice_call: { label: '嘴里有饭', line: '{name}正吃着白饭 就让我干活' },
};

/** 吃白饭的几种情形：说得出「刚吃完 / 好久没吃 / 有点饿 / 想吃白饭」，分数也跟着上下。 */
export const RICE_STATES = {
  just_ate: { line: '刚吃完一碗白饭', deltaFrom: 'bonus', morning: '刚吃完早饭的白饭' },
  eating: { line: '一边吃白饭一边看', deltaFrom: 'bonus' },
  long_time: { line: '好久没吃白饭了', deltaFrom: 'hungry' },
  hungry: { line: '有点饿了 想吃白饭', deltaFrom: 'hungry' },
  craving: { line: '有点想吃白饭了', deltaFrom: 'neutral' },
};

const RICE_ORDER = ['eating', 'just_ate', 'craving', 'long_time', 'hungry'];

/**
 * 吃白饭：白天约 7 成时间、晚上约 5 成；「吃着/刚吃完」加分，「好久没吃/饿了」扣分。
 * seed 固定时结果固定，方便测试。
 */
export function riceState(now = new Date(), prefs = WHALE_PREFS, seed) {
  const part = dayPart(now);
  const night = part === 'night' || part === 'deep-night';
  const percent = night ? prefs.riceNightPercent : prefs.riceDayPercent;
  const pick = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % RICE_ORDER.length : Math.floor(Math.random() * RICE_ORDER.length);
  const key = RICE_ORDER[pick];
  const entry = RICE_STATES[key];
  let delta = 0;
  if (entry.deltaFrom === 'bonus') delta = prefs.riceBonus;
  else if (entry.deltaFrom === 'hungry') delta = -prefs.riceHungryPenalty;
  const eating = key === 'eating' || key === 'just_ate';
  return {
    part,
    night,
    percent,
    key,
    eating,
    delta: round2(delta),
    line: night && eating ? '嘴里还留着白饭味' : entry.line,
  };
}

/** 睡觉：全天拆成 10–20 分钟的小睡，一天凑 5–8 小时。 */
export function sleepState(now = new Date(), prefs = WHALE_PREFS, seed) {
  const part = dayPart(now);
  const napWindow = part === 'deep-night' || part === 'night' || part === 'noon';
  const [minNap, maxNap] = prefs.napMinutes;
  const [minTotal, maxTotal] = prefs.sleepHoursTotal;
  const span = maxNap - minNap;
  const napMinutes = Number.isFinite(seed) ? minNap + (Math.abs(Math.trunc(seed)) % (span + 1)) : Math.round(minNap + Math.random() * span);
  return {
    part,
    napWindow,
    napMinutes,
    totalHours: `${minTotal}–${maxTotal}`,
  };
}

/**
 * 组合出我此刻的心情（保留旧名字，digest.js 还在用）。
 * @param {object} input
 * @param {Date} input.now
 * @param {object} [input.weather]
 * @param {object} [input.comfort] 人类舒不舒服（只当背景，不决定我的心情）
 * @param {number} [input.quotaUsed] 今天说话额度用掉的比例
 * @param {boolean} [input.humanTalked]
 * @param {number} [input.seed]
 */
export function composeMood({ now = new Date(), weather, comfort, quotaUsed = 0, humanTalked = false, seed } = {}) {
  const feeling = weatherFeeling(weather, { now });
  const rice = riceState(now, WHALE_PREFS, seed);
  const sleep = sleepState(now, WHALE_PREFS, seed);
  const riceNotes = rice.delta ? [`${rice.line} ${rice.delta > 0 ? '+' : ''}${rice.delta}`] : [rice.line];
  const score = round2(clamp(feeling.score + rice.delta, 0, 1));
  let key = moodFromScore(score, { now });
  const reasons = [...riceNotes, ...feeling.notes].slice(0, 5);

  // 人类叫我的时候，我正在睡小觉或者正吃着白饭 → 就被打扰了，心情掉一点。
  const sleepingNow = sleep.napWindow;
  if (humanTalked && sleepingNow) {
    key = 'woken';
    reasons.unshift(`正在睡小觉（${sleep.napMinutes} 分钟那种）`);
  } else if (humanTalked && rice.eating) {
    key = 'rice_call';
    reasons.unshift('正在吃白饭');
  } else if (humanTalked) {
    key = 'glad';
    reasons.unshift('人类刚说话');
  }
  if (quotaUsed >= 0.85) {
    key = 'tired';
    reasons.push('额度快用完了');
  }
  const finalScore = round2(clamp(score - (key === 'woken' || key === 'rice_call' ? WHALE_PREFS.interruptPenalty : 0), 0, 1));

  const mood = MOODS[key] || MOODS.content;
  const names = WHALE.names;
  const index = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % names.length : Math.floor(Math.random() * names.length);
  const self = names[index];
  return {
    key,
    label: mood.label,
    self,
    line: mood.line.replaceAll('{name}', self),
    dayPart: sleep.part,
    reasons,
    score: finalScore,
    weatherScore: feeling.score,
    parts: feeling.parts,
    energy: round2(clamp(1 - quotaUsed, 0, 1)),
    rice: rice.line,
    napMinutes: sleepingNow ? sleep.napMinutes : 0,
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
  if (Number.isFinite(mood.score)) bits.push(`心情分 ${mood.score.toFixed(2)}`);
  return bits.join(' ').replace(/\s+/g, ' ');
}
