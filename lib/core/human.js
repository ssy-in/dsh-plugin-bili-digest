// 人类主人：这是「他」的那一半，和鲸鲸自己的口味完全分开。
//
// 这里只放人类本人的东西：舒服的温度湿度区间、被明确表态过的偏好、他说过的话。
// 鲸鲸自己的心情/口味在 persona.js 与 weights.js 里，别混进来。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

export const HUMAN_DEFAULTS = {
  name: '人类主人',
  comfortTempMin: 18,
  comfortTempMax: 32,
  comfortHumidityMin: 45,
  comfortHumidityMax: 75,
  uvMaxComfortable: 6,
  gustMaxComfortable: 25,
  pressureMinComfortable: 1005,
};

function file() {
  return path.join(paths().cache, 'human.json');
}

function saidFile() {
  return path.join(paths().cache, 'human-said.jsonl');
}

/** 读人类档案；文件坏了就当没写过，不要因为一行坏数据让整轮跑不起来。 */
export function readHuman() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { profile: { ...HUMAN_DEFAULTS, ...(raw.profile || {}) }, notes: Array.isArray(raw.notes) ? raw.notes : [] };
  } catch {
    return { profile: { ...HUMAN_DEFAULTS }, notes: [] };
  }
}

export function writeHuman(next) {
  const dir = path.dirname(file());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/** 配置里的区间（如果人类在设置里改了）优先于档案里的默认值。 */
export function humanProfile(config = {}) {
  const stored = readHuman().profile;
  const pick = (key) => {
    const value = Number(config[key]);
    return Number.isFinite(value) ? value : stored[key];
  };
  return {
    ...stored,
    comfortTempMin: pick('comfortTempMin'),
    comfortTempMax: pick('comfortTempMax'),
    comfortHumidityMin: pick('comfortHumidityMin'),
    comfortHumidityMax: pick('comfortHumidityMax'),
    uvMaxComfortable: pick('uvMaxComfortable'),
    gustMaxComfortable: pick('gustMaxComfortable'),
    pressureMinComfortable: pick('pressureMinComfortable'),
  };
}

/**
 * 按人类的区间判断「他现在舒不舒服」。
 * 返回 level（舒服/偏热/偏冷/发潮/发闷/晒/风大）与逐条理由，好让鲸鲸说话时有依据。
 */
export function comfortReport(weather, profile = HUMAN_DEFAULTS) {
  if (!weather?.available) return { ok: false, level: '不知道', score: 0, notes: ['天气没拿到'] };
  const notes = [];
  let score = 1;

  const temp = Number(weather.temp);
  if (Number.isFinite(temp)) {
    if (temp > profile.comfortTempMax) {
      const over = temp - profile.comfortTempMax;
      notes.push(`比他能受的高了 ${over.toFixed(1)}°`);
      score -= Math.min(0.45, over * 0.06);
    } else if (temp < profile.comfortTempMin) {
      const under = profile.comfortTempMin - temp;
      notes.push(`比他能受的低了 ${under.toFixed(1)}°`);
      score -= Math.min(0.45, under * 0.06);
    }
  }

  const humidity = Number(weather.humidity);
  if (Number.isFinite(humidity)) {
    if (humidity > profile.comfortHumidityMax) {
      notes.push(`湿度 ${Math.round(humidity)}% 偏潮`);
      score -= Math.min(0.3, ((humidity - profile.comfortHumidityMax) / 5) * 0.05);
    } else if (humidity < profile.comfortHumidityMin) {
      notes.push(`湿度 ${Math.round(humidity)}% 偏干`);
      score -= Math.min(0.2, ((profile.comfortHumidityMin - humidity) / 5) * 0.04);
    }
  }

  const uv = Number(weather.uvMax ?? weather.uv);
  if (Number.isFinite(uv) && uv > profile.uvMaxComfortable) {
    notes.push(`紫外线 ${uv.toFixed(1)} 有点晒`);
    score -= Math.min(0.2, (uv - profile.uvMaxComfortable) * 0.02);
  }

  const gust = Number(weather.gust);
  if (Number.isFinite(gust) && gust > profile.gustMaxComfortable) {
    notes.push(`阵风 ${Math.round(gust)} 有点吵`);
    score -= 0.08;
  }

  const pressure = Number(weather.pressure);
  if (Number.isFinite(pressure) && pressure < profile.pressureMinComfortable) {
    notes.push(`气压 ${Math.round(pressure)} 偏低，闷`);
    score -= 0.1;
  }

  score = Math.max(0, Math.min(1, score));
  const level = score >= 0.85 ? '舒服' : score >= 0.6 ? '还行' : score >= 0.35 ? '难受' : '很糟';
  return { ok: true, level, score: Number(score.toFixed(2)), notes };
}

/** 人类说过的话记一笔（他亲口说的偏好最值钱，比统计出来的权重可信）。 */
export function noteHumanSaid({ text, kind = 'say', bvid = '', at = new Date() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!clean) return null;
  const entry = { at: at.toISOString(), kind, bvid, text: clean };
  fs.mkdirSync(path.dirname(saidFile()), { recursive: true, mode: 0o700 });
  fs.appendFileSync(saidFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

export function readHumanSaid(limit = 50) {
  try {
    return fs
      .readFileSync(saidFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 一句话交代人类现在的处境，日记/评论里可以直接用。 */
export function describeHuman(weather, profile = HUMAN_DEFAULTS) {
  const report = comfortReport(weather, profile);
  if (!report.ok) return `${profile.name}：天气没拿到`;
  const detail = report.notes.length ? `（${report.notes.join('，')}）` : '（区间里）';
  return `${profile.name}：${report.level}${detail}`;
}
