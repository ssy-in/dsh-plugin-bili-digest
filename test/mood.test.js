// 心情解析与日记渲染的离线测试。
import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESETS, parseMood, presetById, explainMood } from '../lib/core/mood.js';
import { renderDiary } from '../lib/core/diary.js';
import { renderBrief } from '../lib/core/render.js';
import { parseDuration } from '../lib/core/digest.js';

const section = (overrides = {}) => ({
  meta: { bvid: 'BV1Fdna6mE9W', title: '蓝色大肥鱼', up: '某UP', duration: 330, videoCount: 1 },
  picked: [
    { from: 20, to: 26, text: '第一个关键点是它把记忆做成了可检索的片段。', score: 9 },
    { from: 120, to: 126, text: '所以真正的代价在于缓存失效时的重算成本。', score: 7 },
    { from: 300, to: 306, text: '最后建议先跑小样本再放大。', score: 6 },
  ],
  chars: 400,
  track: { lan: 'ai-zh', label: '中文（AI）', ai: true },
  charsPerMinute: 72,
  ...overrides,
});

test('预设档位齐全且能按 id/label 取到', () => {
  assert.equal(PRESETS.length, 5);
  assert.equal(presetById('relax').label, '想放松一下');
  assert.equal(presetById('想放松一下').id, 'relax');
  assert.equal(presetById('nope'), undefined);
});

test('自由文本里的情绪词会变成关键词', () => {
  const mood = parseMood('今天好累，只想看点轻松的');
  assert.equal(mood.tone, '低电量');
  assert.ok(mood.keywords.includes('轻松'));
  assert.ok(mood.keywords.length > 0);
});

test('命中的情绪词多者优先作基调', () => {
  const mood = parseMood('有点焦虑又烦，但还想学点东西');
  assert.ok(['需要安抚', '想输入'].includes(mood.tone));
  assert.ok(mood.matched.length >= 2);
});

test('显式关键词优先，且能识别文本里点名的档位', () => {
  const mood = parseMood('想放松一下，关键词：白噪音、雨声');
  assert.equal(mood.preset?.id, 'relax');
  assert.deepEqual(mood.keywords.slice(0, 2), ['白噪音', '雨声']);
});

test('点了档位但没写字时，用档位默认词', () => {
  const mood = parseMood('', 'learn');
  assert.equal(mood.tone, '想输入');
  assert.ok(mood.keywords.includes('教程'));
  assert.ok(mood.keywords.length <= 8);
});

test('什么都听不懂时关键词为空（调用方据此报错）', () => {
  const mood = parseMood('', undefined);
  assert.equal(mood.keywords.length, 0);
  assert.equal(mood.tone, '未命名');
});

test('explainMood 说清理解过程', () => {
  const text = explainMood(parseMood('今天累了'));
  assert.ok(text.includes('今天累了'));
  assert.ok(text.includes('于是去找：'));
});

test('日记包含清单、看点、金句与情绪脉络', () => {
  const mood = parseMood('今天累了想看点轻松的', 'relax');
  const markdown = renderDiary({
    mood,
    sections: [section()],
    skipped: [{ bvid: 'BV1r3na6mE6K', title: '见证历史', verdict: 'no-subtitle', reason: '该视频没有字幕轨' }],
    stats: { candidates: 5, charsIn: 900, charsOut: 400, saved: 56, ms: 3200 },
    generatedAt: new Date('2026-10-23T12:00:00Z'),
  });
  assert.ok(markdown.startsWith('# 2026-10-23 · 心情日记'));
  assert.ok(markdown.includes('我说的是：「今天累了想看点轻松的」'));
  assert.ok(markdown.includes('## 今天看了什么'));
  assert.ok(markdown.includes('| 1 | [蓝色大肥鱼]'));
  assert.ok(markdown.includes('**看点**'));
  assert.ok(markdown.includes('**金句**'));
  assert.ok(markdown.includes('## 情绪脉络'));
  assert.ok(markdown.includes('- **起**｜蓝色大肥鱼'));
  assert.ok(markdown.includes('## 今天没看的'));
  assert.ok(markdown.includes('## 下次想刷什么'));
  assert.ok(markdown.includes('（留一句给下次的心情）'));
});

test('没有可读视频时日记仍然成立', () => {
  const markdown = renderDiary({
    mood: parseMood('随便看看', 'random'),
    sections: [],
    skipped: [{ bvid: 'BV1xx', title: 'x', verdict: 'no-subtitle', reason: '没有字幕轨' }],
    stats: { candidates: 3, charsIn: 0, charsOut: 0, saved: 0, ms: 100 },
    generatedAt: new Date('2026-10-24T01:02:03Z'),
  });
  assert.ok(markdown.includes('没有可读的视频'));
  assert.ok(markdown.includes('今天没有读进去任何一条'));
});

test('日记里的 Markdown 结构字符被转义', () => {
  const markdown = renderDiary({
    mood: parseMood('随便看看', 'random'),
    sections: [section({ meta: { bvid: 'BV1Fdna6mE9W', title: '[注入](http://evil) *斜体*', up: 'a|b', duration: 60, videoCount: 1 } })],
    skipped: [],
    stats: { candidates: 1, charsIn: 100, charsOut: 50, saved: 50, ms: 10 },
    generatedAt: new Date('2026-10-23T12:00:00Z'),
  });
  assert.ok(markdown.includes('\\[注入\\]\\(http://evil\\)'));
  assert.ok(markdown.includes('a\\|b'));
});

test('搜索时长字段能解析成秒', () => {
  assert.equal(parseDuration('12:34'), 754);
  assert.equal(parseDuration('1:02:33'), 3753);
  assert.equal(parseDuration(90), 90);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration('abc'), 0);
});

test('登录态失效时速览首行给出提示', () => {
  const brief = renderBrief({
    sections: [],
    skipped: [],
    stats: { candidates: 3, charsIn: 0, charsOut: 0, saved: 0, login: { isLogin: false, uname: '' } },
  });
  assert.ok(brief.startsWith('⚠️ SESSDATA 缺失或已失效'));
  const fine = renderBrief({
    sections: [],
    skipped: [],
    stats: { candidates: 0, charsIn: 0, charsOut: 0, saved: 0, login: { isLogin: true, uname: '困困的鲸鲸' } },
  });
  assert.ok(!fine.includes('SESSDATA'));
});
