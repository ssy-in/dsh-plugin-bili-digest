// 困困鲸：北半球东海的虎鲸。这是「我」这一半。
//
// 心情不是随机的，是被这几件事推着走的（人类在 m06776 / m06859 / m06932 里给的设定）：
//   - 家在东海，离东海越远，心情越往下掉
//   - 喜欢 −5–15℃；超过 15℃ 开始难受，低于 −5℃ 也难受
//   - 喜欢晴天、阴天；云量越多越高兴
//   - 小雨 → 中雨，心情一路往上；大雨、大风、雷，心情往下
//   - 紫外线阈值比人类低很多（3 以上就开始烦）
//   - 睡觉：全天拆成 10–20 分钟的小睡，一天凑 5–8 小时
//   - 白天约 7 成时间在吃白饭，晚上约 5 成；饿久了会想白饭
//   - 湿度超过 60% 心情往上，95% 封顶
//   - 连看三条同类视频会烦
//   - 下雨天更想看长一点的视频
//
// 人类主人那边的状态在 human.js，两边各存各的。

import fs from 'node:fs';
import path from 'node:path';

import { paths } from './store.js';

export const WHALE = {
  names: ['困鲸鲸', '困困鲸', '鲸鲸'],
  name: '困鲸鲸',
};

/** 家：东海中心附近。离得越远越不高兴。 */
export const HOME_SEA = { name: '东海', lat: 30.0, lon: 125.0 };

/** 人类亲口给的偏好，全部落成数字，方便解释也方便改。 */
export const WHALE_PREFS = {
  // m07012：大陆的温度跨度太大（东北 −30℃、广东 40℃），所以舒服区间放宽、每度扣得更轻，
  // 只有真正离谱的时候才掉到很难受，不然一天到晚都是坏心情。
  tempMin: -12, // −12℃ 以上到 22℃ 都不扣分
  tempMax: 22,
  tempPerDegreeCold: 0.010, // 比 −12℃ 更低时每度扣多少
  // m07719 人类要求热罚抬一档：温和段 0.005 → 0.006，35℃ 以上再陡一段，酷暑才真的难受，
  // 而 28–30℃ 这种日常热天几乎不动（不然一整个夏天都在坏心情里）。
  tempPerDegreeWarm: 0.006, // 22–35℃：每度扣多少
  tempHotFrom: 35, // 35℃ 以上进入"陡段"
  tempPerDegreeHot: 0.020, // 陡段每度额外扣多少
  tempPenaltyCap: 0.26, // 温度再极端也只扣到这里（冷热共用）
  // 冷水里最开心：这段时间直接给一笔正分（比单纯的"没扣分"更高兴）
  coolJoyFrom: -8,
  coolJoyTo: 12,
  coolJoyBonus: 0.10,
  coolJoyFadeTo: [-20, 24], // 跳出这段后向两边衰减，到这两个温度时加到 0
  cloudBonusMax: 0.08, // 全阴云量 100% 时最多加多少
  sunnyBonus: 0.04, // 晴天也喜欢，只是不如阴天
  sunnyCloudBelow: 35, // 云量低于这个就算晴天
  // 干空气不额外扣分：试过给沙漠加罚，会把绿洲也压成谷底，收益不如直接不加湿度分。
  humidityUpFrom: 60, // 超过这个湿度开始加分
  humidityCapFrom: 95, // 到 95% 就封顶，再潮也不加了
  humidityPerTen: 0.025,
  humidityBonusCap: 0.10, // 湿度这一项最多加到这里（含热湿放大之后）
  uvComfortMax: 3, // 比人类的 6 低一半：我皮薄
  uvPerPoint: 0.022,
  uvPenaltyCap: 0.10,
  rainCoolingFactor: 0.5, // 又热又下雨时，热罚打对折（热带雨季不是沙漠）
  heatHumidityBoost: 1.2, // 热而潮的空气更像海面，湿度加分放大（1.5 会让热带压过冷水/阴雨）
  heatNightFactor: 1, // 虎鲸昼夜都活动，热罚不因为夜里打折
  dayBonus: 0.05, // 白天活动：比夜里明显高一档
  duskBonus: 0.08, // 下午到黄昏（14:00–19:00）是最高值
  nightBonus: 0, // 预留：夜里既不减分也不白加（0 表示不启用，别当成死配置）
  adaptMaxReduction: 0.30, // 同一个地方待久了，最多把温度/紫外线/离家/风的罚分削掉 30%
  adaptDaysFull: 45, // 待满 45 天就适应到顶
  heatAdaptFrom: 35, // 35℃ 以上算极端热（以前这里打三折，人类要求所有罚分统一吃 30% 适应）
  heatAdaptFactor: 1, // 高温也吃满三成的适应，不再单独打折
  gustBadFrom: 50, // km/h，阵风超过就开始烦
  windBadFrom: 30,
  windPenaltyCap: 0.10,
  gustPenaltyCap: 0.12,
  rainBonusMax: 0.08, // 中雨满额（小雨减半），这是虎鲸最舒服的天气
  rainHeavyPenalty: 0.08, // 大雨
  stormPenalty: 0.15, // 雷
  homeFullDistanceKm: 400, // 这个距离内都算"在家门口"，不扣分
  homePerKm: 0.00006, // 超出后每公里扣多少（杭州 466 公里只扣 0.004，两千公里才 0.096）
  homeMaxPenalty: 0.15,
  napMinutes: [10, 20], // 一次睡 10–20 分钟（全天拆着睡）
  sleepHoursTotal: [5, 8], // 一天凑 5–8 小时
  riceDayPercent: 70, // 白天约 7 成时间在吃白饭
  riceNightPercent: 50, // 晚上约 5 成
  riceBonus: 0.03, // 吃着/刚吃完：心情往上
  riceHungryPenalty: 0.03, // 好久没吃：往下
  interruptPenalty: 0.06, // 睡觉时间或吃饭时候被叫起来干活
  moodBaseline: 0.60, // m07012：普通天气要落在 0.55–0.6，顶峰才拉得开
  // 饿的程度（按上次吃过多久算，比随机更讲道理）
  justAteHours: 0.75,
  peckishHours: 2.5,
  hungryHours: 4.5,
  peckishPenalty: 0.01,
  // 连看同类视频会烦
  fatigueStateSize: 8, // 记最近几条的标签
  fatigueRepeatFrom: 3, // 连到第三条开始扣
  fatiguePerRepeat: 0.03,
  fatigueMaxPenalty: 0.15,
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
export function weatherFeeling(weather, { now = new Date(), prefs = WHALE_PREFS, home = HOME_SEA, place, acclimatedDays = 0 } = {}) {
  const parts = [];
  const add = (label, delta) => {
    if (delta) parts.push({ label, delta: round2(delta) });
  };
  if (!weather?.available) {
    return { ok: false, score: 0.5, parts: [], notes: ['天气没拿到'] };
  }

  let score = prefs.moodBaseline; // 总体心情偏高：起手就在均线以上

  // 适应：同一个地方待久了，温度、紫外线、离家的罚分都会变钝（不是无感，是没那么难受）
  const adaptRatio = clamp(Number(acclimatedDays) / (prefs.adaptDaysFull || 60), 0, 1) * (prefs.adaptMaxReduction || 0);
  // 极端热不吃满适应：35℃ 以上只认三成五的适应（住久了也受不了蒸笼天）。
  const tempNow = Number(weather.temp);
  const heatAdaptFactor =
    Number.isFinite(tempNow) && tempNow >= (prefs.heatAdaptFrom ?? 35) ? (prefs.heatAdaptFactor ?? 0.35) : 1;
  const soften = (penalty) => penalty * (1 - adaptRatio * heatAdaptFactor);

  // 虎鲸昼夜都活动：下午到黄昏最来劲，白天小加成，夜里不加也不扣。
  const hour = new Date(now).getHours();
  if (hour >= 14 && hour < 19) {
    score += prefs.duskBonus;
    parts.push({ label: '下午到黄昏，最来劲的时候', delta: round2(prefs.duskBonus) });
  } else if (hour >= 7 && hour < 21) {
    score += prefs.dayBonus;
    parts.push({ label: '白天，精神不错', delta: round2(prefs.dayBonus) });
  }

  // 离家多远：海岸边不走动的话，杭州离东海中心约 470 km，稍微有点远。
  const here = place && Number.isFinite(place.lat) ? place : weather.lat && weather.lon ? { lat: weather.lat, lon: weather.lon } : undefined;
  if (here) {
    const km = distanceKm(home, here);
    const beyond = Math.max(0, km - prefs.homeFullDistanceKm);
    const penalty = soften(Math.min(prefs.homeMaxPenalty, beyond * prefs.homePerKm));
    // 就算在岸边也要记一笔（0 分项也留着），这样人类能看到「我现在离家多远」。
    parts.push({ label: `离家 ${km} 公里（${home.name}）`, delta: round2(-penalty) });
    score -= penalty;
  }

  // 温度：−12–22℃ 之间不扣分；越靠近冷水区越高兴（这是虎鲸的天性）。
  const temp = Number(weather.temp);
  if (Number.isFinite(temp)) {
    let penalty = 0;
    if (temp > prefs.tempMax) {
      penalty = prefs.tempPerDegreeWarm * (temp - prefs.tempMax);
      // 极端热再陡一段：35℃ 往上每度多扣，日常热天不受影响。
      const hotFrom = prefs.tempHotFrom;
      if (Number.isFinite(hotFrom) && temp > hotFrom) penalty += (prefs.tempPerDegreeHot ?? 0) * (temp - hotFrom);
    } else if (temp < prefs.tempMin) penalty = prefs.tempPerDegreeCold * (prefs.tempMin - temp);
    // 又热又下雨：热带雨季那种，热罚打个折（下雪下冷雨不适用）
    if (temp > prefs.tempMax && Number(weather.rain) >= 0.5) {
      penalty *= 1 - (prefs.rainCoolingFactor ?? 0);
    }
    // 虎鲸昼夜都活动：热罚不因为夜里打折（夜里温度低本身就少扣，不再额外加权）
    if (temp > prefs.tempMax && prefs.heatNightFactor && prefs.heatNightFactor !== 1) {
      const hourNight = new Date(now).getHours() < 7 || new Date(now).getHours() >= 21;
      if (hourNight && weather.isDay === false) penalty *= prefs.heatNightFactor;
    }
    penalty = soften(Math.min(prefs.tempPenaltyCap, penalty));
    if (penalty > 0) add(`${Math.round(temp)}° ${temp > prefs.tempMax ? '偏热' : '偏冷'}`, -penalty);
    else add(`${Math.round(temp)}° 不算难受`, 0);
    score -= penalty;

    // 冷水区加成：−8–12℃ 满额，往外线性衰减到 −20℃ / 24℃ 为 0。
    const coldFadeTo = prefs.coolJoyFadeTo?.[0] ?? prefs.coolJoyFrom - 12;
    const warmFadeTo = prefs.coolJoyFadeTo?.[1] ?? prefs.coolJoyTo + 12;
    let cool = 0;
    if (temp >= prefs.coolJoyFrom && temp <= prefs.coolJoyTo) cool = prefs.coolJoyBonus;
    else if (temp < prefs.coolJoyFrom && temp > coldFadeTo) {
      cool = prefs.coolJoyBonus * ((temp - coldFadeTo) / (prefs.coolJoyFrom - coldFadeTo));
    } else if (temp > prefs.coolJoyTo && temp < warmFadeTo) {
      cool = prefs.coolJoyBonus * ((warmFadeTo - temp) / (warmFadeTo - prefs.coolJoyTo));
    }
    cool = round2(Math.max(0, cool));
    if (cool > 0) add('像是回到冷水里', cool);
    score += cool;
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
    const penalty = soften(prefs.stormPenalty);
    add('打雷', -penalty);
    score -= penalty;
  } else if (rain >= 4 || code === 65 || code === 82) {
    const penalty = soften(prefs.rainHeavyPenalty);
    add('大雨', -penalty);
    score -= penalty;
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
    const penalty = soften(Math.min(prefs.uvPenaltyCap ?? 0.15, (uv - prefs.uvComfortMax) * prefs.uvPerPoint));
    add(`紫外线 ${uv.toFixed(1)} 太晒`, -penalty);
    score -= penalty;
  }

  // 风：大风烦，阵风更烦。
  const wind = Number(weather.wind);
  const gust = Number(weather.gust);
  if (Number.isFinite(wind) && wind > prefs.windBadFrom) {
    const penalty = soften(Math.min(prefs.windPenaltyCap ?? 0.10, (wind - prefs.windBadFrom) * 0.008));
    add(`风 ${Math.round(wind)} km/h`, -penalty);
    score -= penalty;
  }
  if (Number.isFinite(gust) && gust > prefs.gustBadFrom) {
    const penalty = soften(Math.min(prefs.gustPenaltyCap ?? 0.12, (gust - prefs.gustBadFrom) * 0.006));
    add(`阵风 ${Math.round(gust)} km/h`, -penalty);
    score -= penalty;
  }

  // 湿度：过了 60% 就往上加（潮一点反而舒服），到 95% 封顶。
  const humidity = Number(weather.humidity);
  if (Number.isFinite(humidity) && humidity > prefs.humidityUpFrom) {
    const effective = Math.min(humidity, prefs.humidityCapFrom);
    let bonus = ((effective - prefs.humidityUpFrom) / 10) * prefs.humidityPerTen;
    // 又热又潮：这种黏黏的空气更像海面，加分放大（热带海边不至于全是坏心情）
    if (Number.isFinite(temp) && temp > prefs.tempMax) bonus *= prefs.heatHumidityBoost ?? 1;
    bonus = Math.min(prefs.humidityBonusCap ?? 0.10, bonus);
    add(`湿度 ${Math.round(humidity)}%`, bonus);
    score += bonus;
  }
  // 干空气不额外扣分：沙漠只是"没拿到湿度的好处"，不叠罚（人类要的是低分地区别太惨）。

  // 下雨天更想窝着看长一点的视频（人类 m06932 加的）。
  const raining = isStorm || rain > 0 || (code >= 51 && code <= 67) || code === 80 || code === 81 || code === 82;
  if (raining) parts.push({ label: '下雨天，想窝着看长的', delta: 0 });

  return {
    ok: true,
    score: round2(clamp(score, 0, 1)),
    prefersLong: raining,
    parts,
    notes: parts.map((p) => `${p.label} ${p.delta > 0 ? '+' : ''}${p.delta}`),
  };
}

/** 分数 → 心情档位（起手分 0.62，所以档位线整体上移，平时都在均线以上）。 */
export function moodFromScore(score, { now = new Date() } = {}) {
  const part = dayPart(now);
  const late = part === 'deep-night' || part === 'night';
  if (score >= 0.82) return late ? 'snug' : 'delighted';
  if (score >= 0.56) return late ? 'sleepy' : 'content';
  if (score >= 0.44) return late ? 'sleepy' : 'meh';
  if (score >= 0.30) return 'grumpy';
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
 * 饿得怎么样：按「上次吃饱」过去多久算，比纯随机讲道理。
 * lastMealAt 可以从缓存读，也可以直接传（测试用）。
 */
export function hungerState(now = new Date(), { lastMealAt, prefs = WHALE_PREFS } = {}) {
  if (!lastMealAt) {
    return { level: 'unknown', hours: null, delta: 0, line: '不太记得上顿是几点' };
  }
  const hours = Math.max(0, (now.getTime() - new Date(lastMealAt).getTime()) / 3_600_000);
  if (hours < prefs.justAteHours) {
    return { level: 'just_ate', hours: round2(hours), delta: prefs.riceBonus, line: '刚吃完白饭不久' };
  }
  if (hours < prefs.peckishHours) {
    return { level: 'fine', hours: round2(hours), delta: 0, line: '肚子还算安分' };
  }
  if (hours < prefs.hungryHours) {
    return { level: 'peckish', hours: round2(hours), delta: -prefs.peckishPenalty, line: '有点想吃白饭了' };
  }
  // 饿越久越想，但封顶在 2 倍惩罚，不至于一路掉到谷底
  const extra = Math.min(1, (hours - prefs.hungryHours) / 4);
  return {
    level: 'hungry',
    hours: round2(hours),
    delta: round2(-(prefs.riceHungryPenalty + extra * prefs.riceHungryPenalty)),
    line: extra >= 1 ? '饿得发慌 只想吃白饭' : '好久没吃白饭了',
  };
}

const MEAL_FILE = () => path.join(paths().cache, 'meal.json');

/**
 * 在同一个城市住了多久（天）：刚搬家会不适应，住久了罚分会按比例削掉一点。
 * 只按城市记，换城市就重新起算。
 */
export function placeKeyOf(weather) {
  if (!weather || weather.available === false) return '';
  const city = String(weather.city || '').trim();
  if (city) return city;
  const lat = Number(weather.lat);
  const lon = Number(weather.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(1)},${lon.toFixed(1)}` : '';
}

function placeFile() {
  return path.join(paths().cache, 'place.json');
}

export function notePlace(weather, now = new Date()) {
  const key = placeKeyOf(weather);
  if (!key) return { key: '', firstSeen: null, days: 0 };
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(placeFile(), 'utf8'));
  } catch {
    stored = null;
  }
  const at = now instanceof Date ? now : new Date(now);
  if (!stored || stored.key !== key || !stored.firstSeen) {
    stored = { key, firstSeen: at.toISOString(), at: at.toISOString() };
    try {
      // 目录可能还没建出来（第一次跑），不建就直接写会静默失败 → 适应期永远是 0 天。
      fs.mkdirSync(path.dirname(placeFile()), { recursive: true, mode: 0o700 });
      fs.writeFileSync(placeFile(), JSON.stringify(stored), { mode: 0o600 });
    } catch {
      /* 写不了就算了，当刚搬来 */
    }
    return { key, firstSeen: at.toISOString(), days: 0 };
  }
  const days = Math.max(0, (at.getTime() - new Date(stored.firstSeen).getTime()) / 86400000);
  return { key, firstSeen: stored.firstSeen, days };
}

/**
 * 怎么在刷视频：睡觉被叫起来、吃饭、边吃边刷、困得不行还刷、闲着、高兴刷、难过刷。
 * 只用来"说出来"，不影响分数。
 */
export const SCENES = {
  sleep: { lines: ['正睡着被叫起来', '刚从被子里爬出来', '还裹在被子里呢'] },
  meal: { lines: ['正吃着白饭', '刚扒完一碗白饭', '嘴里还有饭'] },
  meal_scroll: { lines: ['一边吃白饭一边刷', '边嚼边刷到这条', '扒饭的功夫刷到的'] },
  sleepy_scroll: { lines: ['困得眼睛疼还在刷', '困得不行又刷了一条', '眼皮打架还是想刷'] },
  idle: { lines: ['闲着没事刷', '没事干就刷刷', '正发着呆划到这条'] },
  happy_scroll: { lines: ['今天高兴 刷得也起劲', '心情好 就多划了两条', '乐呵着刷到的'] },
  sad_scroll: { lines: ['心里有点堵 还是想刷', '难过的时候就想刷会儿', '有点丧 划着划着就到这条'] },
  night_scroll: { lines: ['大半夜还在刷', '这个点了还在划', '半夜睡不着在刷'] },
  busy_scroll: { lines: ['假装在干活 其实在刷', '手里有事 还是偷空刷'] },
};

/** 从某个场景池里抽一句。 */
function pickScene(key, seed) {
  const pool = (SCENES[key] || SCENES.idle).lines;
  return { key, line: pool[Math.abs(Math.floor(seed * 997)) % pool.length] };
}

/** 从此刻的处境里加权抽一句"我在怎么刷"（吃白饭不能一个人占满所有时候）。 */
export function sceneFor({ now = new Date(), rice, sleeping, called, moodKey, seed = Math.random() } = {}) {
  const hour = new Date(now).getHours();
  const night = hour >= 23 || hour < 6;
  const work = hour >= 9 && hour < 18;
  const picks = [];
  const add = (key, weight) => {
    if (weight > 0) picks.push({ key, weight });
  };

  // 被人类叫起来干活：这时候场景没得抽，就得说这个
  if (called && sleeping) return pickScene('sleep', seed);
  if (called && rice?.eating) return pickScene('meal', seed);
  if (rice?.eating) {
    add('meal_scroll', 3);
    add('meal', 1);
  } else if (rice?.key === 'just_ate') {
    add('meal', 2);
  }
  if (sleeping || moodKey === 'tired' || moodKey === 'sleepy') add('sleepy_scroll', 4);
  if (moodKey === 'grumpy' || moodKey === 'miserable') add('sad_scroll', 5);
  if (moodKey === 'delighted' || moodKey === 'glad') add('happy_scroll', 4);
  if (night) add('night_scroll', 3);
  if (work) add('busy_scroll', 2);
  add('idle', 2);

  const total = picks.reduce((sum, item) => sum + item.weight, 0) || 1;
  let ticket = ((seed % 1) + 1) % 1 * total;
  let chosen = picks[picks.length - 1] || { key: 'idle' };
  for (const item of picks) {
    ticket -= item.weight;
    if (ticket <= 0) {
      chosen = item;
      break;
    }
  }
  return pickScene(chosen.key, seed);
}

/** 上次吃饱白饭是什么时候（用来算饿的程度）。 */
export function readMeal() {
  try {
    const raw = JSON.parse(fs.readFileSync(MEAL_FILE(), 'utf8'));
    return raw && raw.at ? raw : null;
  } catch {
    return null;
  }
}

export function noteMeal({ at = new Date() } = {}) {
  try {
    fs.mkdirSync(paths().cache, { recursive: true, mode: 0o700 });
    fs.writeFileSync(MEAL_FILE(), `${JSON.stringify({ at: new Date(at).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { at: new Date(at).toISOString() };
  } catch {
    return null;
  }
}

const FATIGUE_FILE = () => path.join(paths().cache, 'fatigue.json');

/** 最近看过哪些标签（用来判断「连看三条同类会烦」）。 */
export function readFatigue() {
  try {
    const raw = JSON.parse(fs.readFileSync(FATIGUE_FILE(), 'utf8'));
    return Array.isArray(raw?.items) ? raw.items : [];
  } catch {
    return [];
  }
}

export function writeFatigue(items) {
  try {
    fs.mkdirSync(paths().cache, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FATIGUE_FILE(), `${JSON.stringify({ items }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // 缓存写不了不影响看视频
  }
}

/** 两组标签的重合度（Jaccard）。 */
export function tagSimilarity(a = [], b = []) {
  const left = new Set((a || []).map((tag) => String(tag).toLowerCase()).filter(Boolean));
  const right = new Set((b || []).map((tag) => String(tag).toLowerCase()).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const tag of left) if (right.has(tag)) hit += 1;
  return round2(hit / (left.size + right.size - hit));
}

/**
 * 连看同类视频的厌烦感：跟最近几条比标签重合度，连续到第三条开始扣分。
 * @param {string[]} tags 这次要看的视频标签
 * @param {object} [options] { history, now, prefs, record } record=true 时把这条记进缓存
 */
export function fatigueState(tags = [], { history = readFatigue(), now = new Date(), prefs = WHALE_PREFS, record = false } = {}) {
  const similar = history.filter((item) => tagSimilarity(item?.tags || [], tags) >= 0.5);
  const streak = similar.length + 1; // 加上这一条
  const over = Math.max(0, streak - (prefs.fatigueRepeatFrom - 1));
  const penalty = round2(Math.min(prefs.fatigueMaxPenalty, over * prefs.fatiguePerRepeat));
  const state = {
    streak,
    similar: similar.length,
    penalty,
    line: penalty > 0 ? `连着第 ${streak} 条同类（${(tags || []).slice(0, 2).join('/') || '没标签'}）` : '',
  };
  if (record && (tags || []).length) {
    const next = [...history, { at: now.toISOString(), tags: (tags || []).slice(0, 12) }].slice(-prefs.fatigueStateSize);
    writeFatigue(next);
  }
  return state;
}
/**
 * 组合出我此刻的心情（保留旧名字，digest.js 还在用）。
 * @param {object} input
 * @param {Date} input.now
 * @param {object} [input.weather]
 * @param {object} [input.comfort] 人类舒不舒服（只当背景，不决定我的心情）
 * @param {number} [input.quotaUsed] 今天说话额度用掉的比例
 * @param {boolean} [input.humanTalked]
 * @param {string[]} [input.tags] 这一轮要看的视频标签（判断「连看三条同类会烦」）
 * @param {object} [input.fatigue] 直接给厌烦度（不给就按 tags 现算）
 * @param {string|Date} [input.lastMealAt] 上次吃饱的时间
 * @param {number} [input.seed]
 */
export function composeMood({
  now = new Date(),
  weather,
  comfort,
  quotaUsed = 0,
  humanTalked = false,
  tags,
  fatigue,
  lastMealAt,
  acclimatedDays = 0,
  seed,
} = {}) {
  // 住得久了会习惯当地的温度/紫外线/离家距离（最多削 30%）。
  const feeling = weatherFeeling(weather, { now, acclimatedDays });
  const rice = riceState(now, WHALE_PREFS, seed);
  const sleep = sleepState(now, WHALE_PREFS, seed);
  const hunger = hungerState(now, { lastMealAt, prefs: WHALE_PREFS });
  const boredom = fatigue || (tags && tags.length ? fatigueState(tags, { record: false }) : { streak: 0, penalty: 0, line: '' });

  const riceNotes = [];
  if (rice.delta) riceNotes.push(`${rice.line} ${rice.delta > 0 ? '+' : ''}${rice.delta}`);
  else riceNotes.push(rice.line);
  if (hunger.delta) riceNotes.push(`${hunger.line} ${hunger.delta > 0 ? '+' : ''}${hunger.delta}`);
  if (boredom.penalty) riceNotes.push(`${boredom.line} -${boredom.penalty}`);

  const score = round2(clamp(feeling.score + rice.delta + hunger.delta - boredom.penalty, 0, 1));
  let key = moodFromScore(score, { now });
  const reasons = [...riceNotes, ...feeling.notes].slice(0, 6);

  // 人类叫我的时候，我正在睡小觉或者正吃着白饭 → 就被打扰了，心情掉一点。
  const sleepingNow = sleep.napWindow;
  if (humanTalked && sleepingNow) {
    key = 'woken';
    reasons.unshift(`正在睡小觉（${sleep.napMinutes} 分钟那种）`);
  } else if (humanTalked && rice.eating) {
    key = 'rice_call';
    reasons.unshift('正在吃白饭');
  } else if (humanTalked) {
    // 人类说话我会高兴，但心情本来就很低落的时候不许硬说高兴（分数与档位得对得上）。
    if (score >= 0.44) {
      key = 'glad';
      reasons.unshift('人类刚说话');
    } else {
      reasons.unshift('人类刚说话，可我现在实在没精神');
    }
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
    rice: { key: rice.key, line: rice.line, eating: Boolean(rice.eating) },
    scene: sceneFor({ now, rice, sleeping: Boolean(sleepingNow), called: Boolean(humanTalked), moodKey: mood.key, seed }),
    hunger: { level: hunger.level, hours: hunger.hours, line: hunger.line },
    boredom: { streak: boredom.streak, penalty: boredom.penalty },
    prefersLong: Boolean(feeling.prefersLong),
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
  return bits.join(' ').replace(/\s+/g, ' ');
}
