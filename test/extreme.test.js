// 极端情况测试：心情往下掉和往上升的两头都要有，且分数不能越界。
//
// 这些用例是给「海洋动物心情」这类软规则上保险的：天气好到离谱不能超过 1，
// 天气差到离谱不能低于 0，而且各种条件叠起来要顺着人类的口味单调变化。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { weatherFeeling, composeMood, WHALE_PREFS, hungerState, fatigueState, tagSimilarity, moodFromScore, distanceKm } from '../lib/core/persona.js';

const HOME = { lat: 30.0, lon: 125.0 }; // 东海中心
const FAR = { lat: 39.9, lon: 116.4 }; // 北京，离家很远

function w(patch = {}) {
  return {
    available: true,
    city: '测试城',
    temp: 8,
    humidity: 70,
    cloud: 80,
    rain: 0,
    code: 3,
    uv: 0,
    wind: 6,
    gust: 10,
    pressure: 1015,
    isDay: true,
    text: '多云',
    ...patch,
  };
}

// 钉死时刻：白天/黄昏有加分，不钉的话同一份天气换个钟点跑出的分不一样（真 bug）。
const PIN = new Date('2026-10-26T10:00:00');
const score = (patch, place = HOME) => weatherFeeling(w(patch), { place, now: PIN }).score;

test('谷底：热 + 暴晒 + 干 + 大风 + 雷 + 离家两千公里 → 分数落到底', () => {
  const worst = score(
    { temp: 40, humidity: 10, cloud: 0, rain: 20, code: 95, uv: 11, wind: 70, gust: 120, isDay: true },
    FAR,
  );
  assert.ok(worst >= 0, '不能是负的');
  // 加了"待久了会适应"的补分之后，谷底不再钉在 0 附近，但仍要明显低于任何舒服区间。
  assert.ok(worst <= 0.15, `谷底应该落到底，实际 ${worst}`);
  assert.equal(moodFromScore(worst, { now: new Date('2026-10-26T10:00:00') }), 'miserable');
});

test('峰顶：−3℃ + 满云 + 中雨 + 零紫外线 + 微风 + 就在东海 → 接近满分', () => {
  const best = score({ temp: -3, humidity: 95, cloud: 100, rain: 2, code: 63, uv: 0, wind: 3, gust: 6 });
  assert.ok(best <= 1, '不能超过 1');
  assert.ok(best >= 0.75, `峰顶应该明显高过普通天（0.55–0.6），实际 ${best}`);
  const mood = composeMood({ now: new Date('2026-10-26T10:00:00'), weather: w({ temp: -3, humidity: 95, cloud: 100, rain: 2, code: 63, uv: 0, wind: 3, gust: 6 }), seed: 1, lastMealAt: new Date('2026-10-26T09:50:00') });
  assert.equal(mood.key, 'delighted');
  assert.ok(mood.score >= 0.78, `心情分应该很高，实际 ${mood.score}`);
});

test('两头之间的单调性：越热越差、越晒越差、离家越远越差、越潮越好', () => {
  const temps = [0, 8, 16, 20, 26, 32].map((temp) => score({ temp }));
  for (let i = 1; i < temps.length; i += 1) {
    assert.ok(temps[i] <= temps[i - 1] + 1e-9, `温度升高不该变好：${temps.join(' > ')}`);
  }
  const uvs = [0, 2, 4, 8, 11].map((uv) => score({ uv }));
  for (let i = 1; i < uvs.length; i += 1) assert.ok(uvs[i] <= uvs[i - 1], `紫外线变强不该变好：${uvs.join(' > ')}`);
  const places = [HOME, { lat: 30.3, lon: 120.2 }, { lat: 39.9, lon: 116.4 }, { lat: 34.0, lon: 108.9 }];
  // 先按真实距离排一遍，再看分数是不是一路往下（离家越远越不高兴）
  const ranked = places
    .map((place) => ({ place, km: distanceKm(HOME, place) }))
    .sort((a, b) => a.km - b.km)
    .map((item) => score({}, item.place));
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i] <= ranked[i - 1] + 1e-9, `离家越远不该变好：${ranked.join(' > ')}`);
  }
  const humid = [30, 60, 70, 85, 95, 100].map((humidity) => score({ humidity }));
  for (let i = 1; i < humid.length; i += 1) assert.ok(humid[i] >= humid[i - 1] - 1e-9, `越潮不该变差：${humid.join(' < ')}`);
  assert.equal(humid[4], humid[5], '95% 之后封顶');
});

test('极端组合下心情分始终夹在 0–1，且带得动档位', () => {
  const cases = [
    { temp: 45, humidity: 5, cloud: 0, code: 95, rain: 30, uv: 12, wind: 90, gust: 150 },
    { temp: -20, humidity: 100, cloud: 100, code: 63, rain: 2, uv: 0, wind: 0, gust: 0 },
    { temp: 15, humidity: 60, cloud: 50, code: 3, rain: 0, uv: 3, wind: 25, gust: 40 },
  ];
  for (const patch of cases) {
    for (const place of [HOME, FAR]) {
      const mood = composeMood({ now: new Date('2026-10-26T10:00:00'), weather: w(patch), seed: 2, lastMealAt: new Date('2026-10-26T09:00:00') });
      assert.ok(mood.score >= 0 && mood.score <= 1, `分数越界：${mood.score}`);
      assert.ok(mood.label.length > 0);
    }
  }
});

test('饿久了更想白饭：越久扣得越多，但有上限', () => {
  const now = new Date('2026-10-26T18:00:00');
  const at = (hours) => hungerState(now, { lastMealAt: new Date(now.getTime() - hours * 3600_000) });
  assert.ok(at(0.2).delta > 0, '刚吃完要加分');
  assert.equal(at(1.5).delta, 0, '不饿不饱是零');
  assert.ok(at(3).delta < 0, '有点饿要扣');
  assert.ok(at(6).delta <= at(3).delta, '越久越扣');
  assert.ok(at(30).delta >= -2 * WHALE_PREFS.riceHungryPenalty - 1e-9, '扣分要封顶');
  assert.equal(at(30).level, 'hungry');
});

test('连看三条同类会烦，不同类不烦，且扣分有上限', () => {
  const now = new Date('2026-10-26T12:00:00');
  const tags = ['DeepSeek', '大肥鱼', 'AI'];
  assert.equal(tagSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(tagSimilarity(['a'], ['b']), 0);

  const history = [
    { at: now.toISOString(), tags },
    { at: now.toISOString(), tags },
  ];
  const third = fatigueState(tags, { history, now });
  assert.equal(third.streak, 3);
  assert.ok(third.penalty > 0, '第三条开始烦');
  const second = fatigueState(tags, { history: history.slice(0, 1), now });
  assert.equal(second.penalty, 0, '第二条还不烦');

  const many = Array.from({ length: 10 }, () => ({ at: now.toISOString(), tags }));
  const capped = fatigueState(tags, { history: many, now });
  assert.equal(capped.penalty, WHALE_PREFS.fatigueMaxPenalty, '烦到顶就不再涨');

  const other = fatigueState(['美食', '探店'], { history, now });
  assert.equal(other.penalty, 0, '换了口味就不烦');
});

test('下雨天想窝着看长视频', () => {
  assert.equal(weatherFeeling(w({ rain: 1.2, code: 51 }), { place: HOME }).prefersLong, true, '小雨想看长的');
  assert.equal(weatherFeeling(w({ rain: 0, code: 3 }), { place: HOME }).prefersLong, false, '阴天不强制');
  assert.equal(weatherFeeling(w({ code: 95, rain: 5 }), { place: HOME }).prefersLong, true, '雷雨也想窝着');
  const mood = composeMood({ now: new Date('2026-10-26T12:00:00'), weather: w({ rain: 2, code: 63 }), seed: 1 });
  assert.equal(mood.prefersLong, true);
});

test('被打扰的极端情形：又困又饿又被叫，心情明显掉但不会掉到负', () => {
  const night = new Date('2026-10-26T23:30:00');
  const mood = composeMood({
    now: night,
    weather: w({ temp: 30, humidity: 30, code: 95, rain: 6, uv: 0 }),
    humanTalked: true,
    seed: 4,
    lastMealAt: new Date('2026-10-26T12:00:00'),
  });
  assert.equal(mood.key, 'woken');
  assert.ok(mood.score >= 0, `不能掉成负数：${mood.score}`);
  assert.ok(mood.score < 0.45, `应该明显不高兴：${mood.score}`);
});
