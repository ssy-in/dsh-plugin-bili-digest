import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 两个人在同一个仓库里，各写各的：鲸鲸的心情不写盘，人类档案写 cache/human.json。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-persona-'));
process.env.BILI_DIGEST_HOME = HOME;

const { HUMAN_DEFAULTS, comfortReport, humanProfile, noteHumanSaid, readHumanSaid, describeHuman } = await import('../lib/core/human.js');
const { composeMood, dayPart, renderMoodLine, MOODS, WHALE_PREFS, weatherFeeling, distanceKm, riceState, sleepState, RICE_STATES } = await import(
  '../lib/core/persona.js'
);

const weather = (patch = {}) => ({
  available: true,
  city: '杭州',
  temp: 24,
  humidity: 60,
  pressure: 1012,
  uv: 0,
  uvMax: 5,
  gust: 8,
  isDay: true,
  text: '晴',
  ...patch,
});

test('人类区间内算舒服，出界会写清理由', () => {
  const good = comfortReport(weather(), HUMAN_DEFAULTS);
  assert.equal(good.ok, true);
  assert.equal(good.level, '舒服');
  assert.deepEqual(good.notes, []);

  const humid = comfortReport(weather({ humidity: 89 }), HUMAN_DEFAULTS);
  assert.ok(humid.notes.some((note) => note.includes('偏潮')), '湿度 89% 应该被点出来');
  assert.ok(humid.score < good.score);

  const cold = comfortReport(weather({ temp: 10 }), HUMAN_DEFAULTS);
  assert.ok(cold.notes.some((note) => note.includes('低了')), '10° 应该被判偏冷');

  const unknown = comfortReport({ available: false }, HUMAN_DEFAULTS);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.level, '不知道');
});

test('配置能改人类的舒适区间，且分数始终夹在 0–1', () => {
  const profile = humanProfile({ comfortTempMax: 20 });
  assert.equal(profile.comfortTempMax, 20);
  const harsh = comfortReport(weather({ temp: 40, humidity: 95, pressure: 990, gust: 40, uvMax: 11 }), profile);
  assert.ok(harsh.score >= 0 && harsh.score <= 1);
  assert.ok(harsh.score < 0.35, `全指标崩坏时分数应该很低，实际 ${harsh.score}`);
});

test('人类说过的话按行记，读回来只有最后几条', () => {
  noteHumanSaid({ text: '  我喜欢这个   视频  ', kind: 'like', bvid: 'BV1AAAAAAA' });
  noteHumanSaid({ text: '这个不好看', kind: 'dislike', bvid: 'BV1BBBBBBB' });
  const said = readHumanSaid(10);
  assert.equal(said.length, 2);
  assert.equal(said[0].text, '我喜欢这个 视频', '多余空白要压掉');
  assert.equal(said[0].kind, 'like');
  assert.equal(readHumanSaid(1).length, 1);
  noteHumanSaid({ text: '   ' });
  assert.equal(readHumanSaid(10).length, 2, '空话不该记');
});

test('describeHuman 说人话', () => {
  const line = describeHuman(weather({ humidity: 89 }), HUMAN_DEFAULTS);
  assert.ok(line.startsWith('人类主人：'));
  assert.ok(line.includes('偏潮'));
  assert.ok(describeHuman({ available: false }, HUMAN_DEFAULTS).includes('天气没拿到'));
});

test('鲸鲸的心情：深夜犯困、额度用完累、人类说话就美滋滋', () => {
  const night = new Date('2026-10-26T23:40:00');
  assert.equal(dayPart(night), 'night');
  const sleepy = composeMood({ now: night, seed: 2 });
  assert.ok(['sleepy', 'snug'].includes(sleepy.key), `深夜应该是困或窝着，实际 ${sleepy.key}`);

  const noon = new Date('2026-10-26T12:10:00');
  assert.equal(composeMood({ now: noon, weather: weather(), quotaUsed: 0.9, seed: 2 }).key, 'tired');

  // 下午没人打扰、也没在吃白饭（seed 2 = 想吃白饭那个）→ 人类一说话就美滋滋
  const afternoon = new Date('2026-10-26T16:30:00');
  assert.equal(composeMood({ now: afternoon, weather: weather(), humanTalked: true, seed: 2 }).key, 'glad');
});

test('温度 −5 到 15℃ 都算舒服，往上往下都掉分', () => {
  const place = { lat: 30.0, lon: 125.0 }; // 就站在东海上，先把距离这一项消掉
  const at = (temp) => weatherFeeling(weather({ temp }), { place }).score;
  const cozy = at(8);
  assert.ok(cozy > at(20), `8° 应比 20° 舒服：${cozy} vs ${at(20)}`);
  assert.ok(cozy > at(24), `8° 应比 24° 舒服：${cozy} vs ${at(24)}`);
  assert.equal(at(-3), cozy, '−3° 也该是满分（人类说 −5 以上都 ok）');
  assert.ok(at(-9) < cozy, '−9° 才该掉分');
  assert.ok(at(32) < at(20), '32° 比 20° 更糟');
});

test('晴天也加分，只是不如阴天', () => {
  const place = { lat: 30.0, lon: 125.0 };
  const base = (patch) => weatherFeeling(weather({ temp: 10, cloud: 0, rain: 0, code: 3, uv: 0, wind: 5, gust: 8, humidity: 50, ...patch }), { place }).score;
  assert.ok(base({ cloud: 0, code: 0 }) > base({ cloud: 0, code: 3 }), '晴天比阴着不晴好');
  assert.ok(base({ cloud: 100, code: 3 }) > base({ cloud: 0, code: 0 }), '满云还是比晴天更舒服');
});

test('云量越多越高兴，小雨中雨加分，大雨和雷扣分', () => {
  const place = { lat: 30.0, lon: 125.0 };
  // 用「阴着但不晴」当基准，避免晴天加成混进来
  const base = (patch) => weatherFeeling(weather({ temp: 10, cloud: 30, rain: 0, code: 3, uv: 0, wind: 5, gust: 8, humidity: 50, ...patch }), { place }).score;
  assert.ok(base({ cloud: 100 }) > base({ cloud: 0 }), '满云量比没云更舒服');
  assert.ok(base({ rain: 0.6, code: 51 }) > base({ rain: 0, code: 3 }), '小雨加分');
  assert.ok(base({ rain: 2, code: 63 }) > base({ rain: 0.6, code: 51 }), '中雨比小雨更高兴');
  assert.ok(base({ rain: 8, code: 65 }) < base({ rain: 0, code: 3 }), '大雨倒扣');
  assert.ok(base({ code: 95, rain: 3 }) < base({ rain: 8, code: 65 }), '打雷比大雨更糟');
});

test('紫外线阈值比人类低：3 以上就开始烦，8 以上很难受', () => {
  const place = { lat: 30.0, lon: 125.0 };
  const at = (uvMax) => weatherFeeling(weather({ uvMax, uv: uvMax, temp: 10 }), { place }).score;
  assert.ok(at(2) > at(5), 'UV 5 应比 UV 2 差');
  assert.ok(at(5) > at(9), 'UV 9 应比 UV 5 更差');
  assert.ok(at(11) <= at(2) - 0.2, 'UV 11 要明显低于 UV 2');
});

test('湿度过 60% 加分，95% 封顶', () => {
  const place = { lat: 30.0, lon: 125.0 };
  const at = (humidity) => weatherFeeling(weather({ humidity, temp: 10 }), { place }).score;
  assert.ok(at(85) > at(65), '85% 比 65% 高兴');
  assert.ok(at(65) > at(40), '过了 60% 才有加分');
  assert.equal(at(100), at(95), '到 95% 就封顶');
});

test('吃白饭：吃着/刚吃完加分，饿了扣分，说法各不一样', () => {
  const afternoon = new Date('2026-10-26T16:00:00');
  const lines = new Set();
  const scores = [];
  for (let seed = 0; seed < 5; seed += 1) {
    const rice = riceState(afternoon, WHALE_PREFS, seed);
    lines.add(rice.line);
    scores.push(rice.delta);
  }
  assert.equal(lines.size, 5, '五种说法都要出现');
  assert.ok(scores.some((delta) => delta > 0), '得有加分的（吃着/刚吃完）');
  assert.ok(scores.some((delta) => delta < 0), '得有扣分的（饿了/好久没吃）');
  assert.ok(riceState(afternoon, WHALE_PREFS, 0).eating, 'seed 0 是正在吃');
});

test('我睡觉或吃白饭的时候被叫干活：心情掉一点，说法也换了', () => {
  const night = new Date('2026-10-26T23:00:00');
  const woken = composeMood({ now: night, weather: weather({ temp: 10 }), humanTalked: true, seed: 0 });
  assert.equal(woken.key, 'woken');
  assert.ok(woken.line.includes('睡觉时间'), woken.line);

  const afternoon = new Date('2026-10-26T16:00:00');
  const riceCall = composeMood({ now: afternoon, weather: weather({ temp: 10 }), humanTalked: true, seed: 0 });
  assert.equal(riceCall.key, 'rice_call');
  assert.ok(riceCall.line.includes('白饭'), riceCall.line);
  assert.ok(riceCall.score < composeMood({ now: afternoon, weather: weather({ temp: 10 }), seed: 0 }).score, '被打扰的要低一点');
});

test('总体心情在均线以上（起手分抬高）', () => {
  const place = { lat: 30.29, lon: 120.16 }; // 杭州，离家 466km
  const score = weatherFeeling(weather({ temp: 16, humidity: 85, cloud: 40, uv: 0 }), { place }).score;
  assert.ok(score >= 0.6, `普通天气应该 0.6 以上，实际 ${score}`);
  const mood = composeMood({ now: new Date('2026-10-26T10:00:00'), weather: weather({ temp: 16, humidity: 85 }), seed: 1 });
  assert.ok(mood.score >= 0.55, `心情分应在均线以上，实际 ${mood.score}`);
});

test('离东海越远越不高兴', () => {
  const near = weatherFeeling(weather({ temp: 10 }), { place: { lat: 30.0, lon: 125.0 } });
  const hangzhou = weatherFeeling(weather({ temp: 10 }), { place: { lat: 30.29, lon: 120.16 } });
  const beijing = weatherFeeling(weather({ temp: 10 }), { place: { lat: 39.9, lon: 116.4 } });
  assert.ok(near.score > hangzhou.score, '东海 > 杭州');
  assert.ok(hangzhou.score > beijing.score, '杭州 > 北京');
  assert.ok(near.parts.some((part) => part.label.includes('东海')));
  assert.equal(distanceKm({ lat: 30, lon: 125 }, { lat: 30, lon: 125 }), 0);
});

test('白饭与睡觉：白天 7 成、晚上 5 成，一次睡 10–20 分钟', () => {
  const day = riceState(new Date('2026-10-26T13:00:00'));
  const night = riceState(new Date('2026-10-26T23:00:00'));
  assert.equal(day.percent, WHALE_PREFS.riceDayPercent);
  assert.equal(night.percent, WHALE_PREFS.riceNightPercent);
  assert.notEqual(day.line, night.line);
  const sleep = sleepState(new Date('2026-10-26T23:00:00'));
  assert.ok(sleep.napMinutes >= 10 && sleep.napMinutes <= 20, `nap=${sleep.napMinutes}`);
  assert.equal(sleep.totalHours, '5–8');
});

test('心情带自称与理由，理由与天气对得上', () => {
  const mood = composeMood({
    now: new Date('2026-10-26T12:10:00'),
    weather: weather({ humidity: 88, temp: 10 }),
    seed: 1,
  });
  assert.ok(['困鲸鲸', '困困鲸', '鲸鲸'].includes(mood.self));
  assert.equal(MOODS[mood.key].label, mood.label);
  assert.ok(mood.line.includes(mood.self), 'line 里要换成自称');
  assert.ok(!mood.line.includes('{name}'), '占位符必须被替换掉');
  assert.ok(mood.reasons.some((reason) => reason.includes('88')), '理由里要有湿度数值');
  assert.ok(mood.energy >= 0 && mood.energy <= 1);
  assert.ok(mood.rice.length > 0);
});

test('日记开头那句同时交代鲸鲸与天气', () => {
  const mood = composeMood({ now: new Date('2026-10-26T12:10:00'), weather: weather(), seed: 0 });
  const line = renderMoodLine(mood, weather());
  assert.ok(line.includes('此刻'), line);
  assert.ok(line.includes('杭州'));
  assert.ok(line.includes('湿度 60%'));
  assert.ok(line.includes('心情分'));
  assert.equal(renderMoodLine(undefined, weather()), '');
});
