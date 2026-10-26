// 大陆各地的经典场景：从东北 −30℃ 到广东 40℃，心情要讲得通，
// 既不能一冷就崩、也不能热到全是坏心情，普通天还要落在 0.55–0.6 那一档。
//
// 人类 m07012：顶峰要跟普通分开，温度别太敏感。

import assert from 'node:assert/strict';
import test from 'node:test';

import { weatherFeeling, moodFromScore, WHALE_PREFS, HOME_SEA } from '../lib/core/persona.js';

const weather = (patch = {}) => ({
  available: true,
  city: '测试城',
  temp: 16,
  humidity: 70,
  cloud: 70,
  rain: 0,
  code: 3,
  uv: 0,
  wind: 8,
  gust: 14,
  pressure: 1012,
  isDay: true,
  text: '多云',
  ...patch,
});

const at = (patch, place = HOME_SEA) => weatherFeeling(weather(patch), { place });
const score = (patch, place = HOME_SEA) => at(patch, place).score;
const NOON = new Date('2026-10-26T15:00:00');
const level = (value) => moodFromScore(value, { now: NOON });

// 各地典型天气（坐标用于算离家多远）
const CITIES = {
  哈尔滨冬天: [{ temp: -18, humidity: 45, cloud: 20, code: 0, uv: 1 }, { lat: 45.8, lon: 126.6 }],
  漠河极寒: [{ temp: -30, humidity: 40, cloud: 30, code: 0, uv: 0 }, { lat: 52.9, lon: 122.5 }],
  北京晴天: [{ temp: 5, humidity: 30, cloud: 10, code: 0, uv: 4 }, { lat: 39.9, lon: 116.4 }],
  上海秋天: [{ temp: 14, humidity: 65, cloud: 60 }, { lat: 31.2, lon: 121.5 }],
  杭州潮秋: [{ temp: 16, humidity: 85, cloud: 40 }, { lat: 30.3, lon: 120.2 }],
  成都阴天: [{ temp: 18, humidity: 80, cloud: 90 }, { lat: 30.7, lon: 104.1 }],
  拉萨高原: [{ temp: 8, humidity: 35, cloud: 30, uv: 9 }, { lat: 29.7, lon: 91.1 }],
  广州潮热: [{ temp: 28, humidity: 80, cloud: 50 }, { lat: 23.1, lon: 113.3 }],
  三亚湿热: [{ temp: 30, humidity: 88, cloud: 40 }, { lat: 18.3, lon: 109.5 }],
  武汉闷热: [{ temp: 36, humidity: 75, cloud: 30 }, { lat: 30.6, lon: 114.3 }],
  广东酷暑: [{ temp: 40, humidity: 60, cloud: 20, uv: 10 }, { lat: 23.1, lon: 113.3 }],
  理想顶峰: [{ temp: -3, humidity: 95, cloud: 100, rain: 2, code: 63, uv: 0, wind: 4, gust: 8 }, HOME_SEA],
};

const scores = Object.fromEntries(Object.entries(CITIES).map(([name, [patch, place]]) => [name, score(patch, place)]));

test('每个地方都在 0–1 之间，没有哪个城市直接掉到 0', () => {
  for (const [name, value] of Object.entries(scores)) {
    assert.ok(value >= 0 && value <= 1, `${name} 越界：${value}`);
    assert.ok(value > 0.05, `${name} 掉得太狠：${value}`);
  }
});

test('普通天落在 0.6–0.78 这一档，顶峰明显高过普通天', () => {
  assert.ok(scores.杭州潮秋 >= 0.6 && scores.杭州潮秋 <= 0.78, `普通天应该 0.6–0.78，实际 ${scores.杭州潮秋}`);
  assert.ok(scores.理想顶峰 >= scores.杭州潮秋 + 0.1, `顶峰要拉开差距：${scores.理想顶峰} vs ${scores.杭州潮秋}`);
  assert.equal(level(scores.理想顶峰), 'delighted');
});

test('大部分地方都是"不错以上"，只有真极端才掉到很差', () => {
  const good = Object.entries(scores).filter(([, value]) => level(value) === 'content' || level(value) === 'delighted');
  const bad = Object.entries(scores).filter(([, value]) => level(value) === 'miserable');
  assert.ok(good.length >= 7, `不错以上至少 7 个，实际 ${good.length}：${good.map(([name]) => name).join('、')}`);
  assert.equal(bad.length, 0, `不该有谷底：${bad.map(([name, value]) => `${name} ${value}`).join('、')}`);
});

test('大陆温度跨度：−30℃ 和 40℃ 都难受，但都不归零', () => {
  assert.ok(scores.漠河极寒 < 0.45, `−30℃ 不该舒服：${scores.漠河极寒}`);
  assert.ok(scores.漠河极寒 > 0.05, `−30℃ 也别归零：${scores.漠河极寒}`);
  assert.ok(scores.广东酷暑 < 0.4, `40℃ 不该舒服：${scores.广东酷暑}`);
  assert.ok(scores.广东酷暑 > 0.05, `40℃ 也别归零：${scores.广东酷暑}`);
  assert.notEqual(level(scores.漠河极寒), 'delighted');
  assert.notEqual(level(scores.广东酷暑), 'delighted');
});

test('温度带 −12–22℃ 不扣分', () => {
  for (const temp of [-12, -5, 0, 8, 15, 22]) {
    const parts = at({ temp, humidity: 70, cloud: 70 }).parts.map((part) => part.label);
    assert.ok(!parts.some((label) => label.includes('偏热') || label.includes('偏冷')), `${temp}℃ 不该被扣分：${parts.join(' / ')}`);
  }
  const cold = at({ temp: -20 }).parts.map((part) => part.label);
  assert.ok(cold.some((label) => label.includes('偏冷')), '−20℃ 要说明是冷');
});

test('朝向冷水区一路变好，过了舒服点再往上就一路变差', () => {
  const rising = [-30, -20, -12, -5, 0, 8, 12].map((temp) => score({ temp }));
  for (let i = 1; i < rising.length; i += 1) {
    assert.ok(rising[i] >= rising[i - 1] - 1e-9, `暖和一点不该更差：${rising.join(' < ')}`);
  }
  const falling = [15, 22, 26, 30, 36, 40].map((temp) => score({ temp }));
  for (let i = 1; i < falling.length; i += 1) {
    assert.ok(falling[i] <= falling[i - 1] + 1e-9, `更热不该更好：${falling.join(' > ')}`);
  }
});

test('城市排序合乎体感：顶峰 > 杭州/上海 > 北京/成都 > 广州/三亚 > 武汉', () => {
  assert.ok(scores.杭州潮秋 >= scores.北京晴天, `杭州 ${scores.杭州潮秋} 应该不低于北京 ${scores.北京晴天}`);
  assert.ok(scores.北京晴天 >= scores.广州潮热, `北京 ${scores.北京晴天} 应该不低于广州 ${scores.广州潮热}`);
  assert.ok(scores.广州潮热 >= scores.武汉闷热, `广州 ${scores.广州潮热} 应该不低于武汉 ${scores.武汉闷热}`);
  assert.ok(scores.拉萨高原 < scores.成都阴天, '高原强紫外要扣在成都阴天之下');
  assert.ok(WHALE_PREFS.tempMin <= -10 && WHALE_PREFS.tempMax >= 20, '舒服区间要够宽，能覆盖大陆常见温度');
});
