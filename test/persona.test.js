import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 两个人在同一个仓库里，各写各的：鲸鲸的心情不写盘，人类档案写 cache/human.json。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-persona-'));
process.env.BILI_DIGEST_HOME = HOME;

const { HUMAN_DEFAULTS, comfortReport, humanProfile, noteHumanSaid, readHumanSaid, describeHuman } = await import('../lib/core/human.js');
const { composeMood, dayPart, renderMoodLine, MOODS } = await import('../lib/core/persona.js');

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

test('鲸鲸的心情：深夜犯困、潮湿黏、天冷缩着、额度用完累、人类说话就美滋滋', () => {
  const night = new Date('2026-10-26T23:40:00');
  assert.equal(dayPart(night), 'night');
  assert.equal(composeMood({ now: night, seed: 0 }).key, 'sleepy');

  const noon = new Date('2026-10-26T12:10:00');
  assert.equal(composeMood({ now: noon, weather: weather({ humidity: 88 }), seed: 0 }).key, 'sticky');
  assert.equal(composeMood({ now: noon, weather: weather({ temp: 9 }), seed: 0 }).key, 'cold');
  assert.equal(composeMood({ now: noon, weather: weather({ pressure: 998 }), seed: 0 }).key, 'heavy');
  assert.equal(composeMood({ now: noon, weather: weather(), quotaUsed: 0.9, seed: 0 }).key, 'tired');
  assert.equal(composeMood({ now: noon, weather: weather(), humanTalked: true, seed: 0 }).key, 'glad');
});

test('心情带自称与理由，理由与天气对得上', () => {
  const mood = composeMood({ now: new Date('2026-10-26T12:10:00'), weather: weather({ humidity: 88 }), seed: 1 });
  assert.ok(['困鲸鲸', '困困鲸', '鲸鲸'].includes(mood.self));
  assert.equal(MOODS[mood.key].label, mood.label);
  assert.ok(mood.line.includes(mood.self), 'line 里要换成自称');
  assert.ok(!mood.line.includes('{name}'), '占位符必须被替换掉');
  assert.ok(mood.reasons.some((reason) => reason.includes('88')), '理由里要有湿度数值');
  assert.ok(mood.energy >= 0 && mood.energy <= 1);
});

test('日记开头那句同时交代鲸鲸与天气', () => {
  const mood = composeMood({ now: new Date('2026-10-26T12:10:00'), weather: weather(), seed: 0 });
  const line = renderMoodLine(mood, weather());
  assert.ok(line.includes('此刻'), line);
  assert.ok(line.includes('杭州'));
  assert.ok(line.includes('湿度 60%'));
  assert.equal(renderMoodLine(undefined, weather()), '');
});
