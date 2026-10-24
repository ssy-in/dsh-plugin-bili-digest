// 离线单测：不联网，覆盖切段打分、渲染转义、配置校验、URL 白名单、门槛判定。
import test from 'node:test';
import assert from 'node:assert/strict';

import { splitText, mergeCues, scoreSegments, pickSegments, expandKeywords, stamp } from '../lib/core/segment.js';
import { escapeMarkdown, renderReport, videoUrl } from '../lib/core/render.js';
import { validateSessdata } from '../lib/core/config.js';
import { assertAllowedUrl } from '../lib/core/http.js';
import { readVideo, VERDICT } from '../lib/core/gate.js';

test('splitText 在标点处切分且不超长', () => {
  const text = '第一句话。第二句话，还有第三句话！';
  const chunks = splitText(text, 8);
  assert.ok(chunks.every((chunk) => chunk.length <= 8));
  assert.equal(chunks.join(''), text);
});

test('mergeCues 合并相邻小块、按句末断开', () => {
  const cues = [
    { from: 0, to: 2, text: '这是第一句' },
    { from: 2.2, to: 4, text: '接着第二句。' },
    { from: 4.3, to: 6, text: '换段的第三句。' },
    { from: 20, to: 22, text: '间隔很大的一句。' },
  ];
  const segments = mergeCues(cues, { maxChars: 200, maxGap: 1.4, maxDur: 28 });
  assert.ok(segments.length >= 3, `期望至少 3 段，实际 ${segments.length}`);
  assert.equal(segments[0].from, 0);
  assert.ok(segments.at(-1).from >= 20);
});

test('scoreSegments 关键词与数字提高得分', () => {
  const segments = [
    { from: 0, to: 10, text: '这里只是随意的开场白，没有任何信息' },
    { from: 10, to: 20, text: '所以结论是成本下降了 70%，这是关键' },
  ];
  const scored = scoreSegments(segments, { keywords: ['成本'] });
  assert.ok(scored[1].score > scored[0].score);
  assert.equal(scored[1].keywordHits, 1);
  assert.ok(scored[1].numberHits >= 1);
});

test('pickSegments 控制段数与字数上限', () => {
  const segments = Array.from({ length: 30 }, (_, index) => ({
    from: index * 10,
    to: index * 10 + 10,
    text: `第 ${index} 段内容，关键点很多，数字 ${index * 3}%`,
  }));
  const scored = scoreSegments(segments, { keywords: ['关键'] });
  const picked = pickSegments(scored, { k: 5, maxChars: 1000 });
  assert.ok(picked.length <= 5 && picked.length > 0);
  const chars = picked.reduce((sum, segment) => sum + segment.chars, 0);
  assert.ok(chars <= 1000);
  assert.deepEqual(picked, [...picked].sort((a, b) => a.index - b.index));
});

test('expandKeywords 给中文标题拆 2-gram、保留英文单词', () => {
  const keywords = expandKeywords(['deepseek'], '我把蓝色大肥鱼养进 DeepSeek 之后');
  assert.ok(keywords.includes('deepseek'));
  assert.ok(keywords.includes('蓝色'));
  assert.ok(keywords.every((keyword) => keyword.length >= 2));
});

test('escapeMarkdown 干掉结构字符和控制字符', () => {
  const out = escapeMarkdown('标题 [链接](http://x) `code` *粗* \u0000\u0007换行\n第二行', { maxLength: 80 });
  assert.ok(!out.includes(']('), '不留下可点击的链接结构');
  assert.ok(out.includes('\\`'), '反引号被反斜杠转义');
  assert.ok(out.includes('\\*'), '星号被转义');
  assert.ok(!out.includes('\n'), '换行被折叠');
  assert.ok(!/[\u0000-\u001f]/.test(out), '没有控制字符');
  assert.ok(out.length <= 80);
});

test('renderReport 转义标题并保留时间戳跳转', () => {
  const markdown = renderReport({
    sections: [
      {
        meta: { bvid: 'BV1aaaaaaaaa', title: '标题 [注入](http://evil) 结尾', up: 'UP主', duration: 125, videoCount: 1 },
        picked: [{ from: 65, to: 90, chars: 20, text: '所以结论是 3 个要点' }],
        chars: 20,
        track: { lan: 'ai-zh', label: '中文（自动生成）', ai: true },
        charsPerMinute: 120,
      },
    ],
    skipped: [{ bvid: 'BV1bbbbbbbbb', title: '无字幕', verdict: 'no-subtitle', reason: '该视频没有字幕轨' }],
    stats: { keywords: ['deepseek'], candidates: 2, readable: 1, dropped: 1, charsIn: 100, charsOut: 20, saved: 80 },
  });
  assert.ok(markdown.includes('?t=65'));
  assert.ok(markdown.includes('https://www.bilibili.com/video/BV1aaaaaaaaa'));
  assert.ok(!markdown.includes('](http://evil)'));
  assert.ok(markdown.includes('被丢弃'));
  assert.equal(videoUrl('BV1aaaaaaaaa', 0), 'https://www.bilibili.com/video/BV1aaaaaaaaa?t=0');
});

test('validateSessdata 拒绝 cookie 注入与空值', () => {
  assert.ok(validateSessdata('abc%2C123_def-ghi'));
  assert.throws(() => validateSessdata('abc; bili_jct=1'));
  assert.throws(() => validateSessdata('abc\r\nSet-Cookie: x=1'));
  assert.throws(() => validateSessdata(''));
  assert.throws(() => validateSessdata('short'));
  assert.throws(() => validateSessdata('x'.repeat(400)));
});

test('assertAllowedUrl 只放行 B 站域名与 https', () => {
  assert.ok(assertAllowedUrl('https://aisubtitle.hdslb.com/bfs/subtitle/1.json'));
  assert.ok(assertAllowedUrl('https://api.bilibili.com/x/web-interface/nav'));
  assert.throws(() => assertAllowedUrl('http://api.bilibili.com/x'));
  assert.throws(() => assertAllowedUrl('https://169.254.169.254/latest/meta-data'));
  assert.throws(() => assertAllowedUrl('https://bilibili.com.evil.tld/x'));
  assert.throws(() => assertAllowedUrl('file:///etc/passwd'));
});

test('readVideo 区分无字幕 / 需登录 / 字幕残缺 / 可读', async () => {
  const baseMeta = { bvid: 'BV1aaaaaaaaa', title: 't', duration: 120, pages: [], videoCount: 1 };
  const cases = [
    {
      name: '无字幕',
      api: { view: async () => baseMeta, subtitleList: async () => ({ needsLogin: false, tracks: [] }) },
      expected: VERDICT.NO_SUBTITLE,
    },
    {
      name: '需要登录',
      api: { view: async () => baseMeta, subtitleList: async () => ({ needsLogin: true, tracks: [] }) },
      expected: VERDICT.NEEDS_LOGIN,
    },
    {
      name: '字幕残缺',
      api: {
        view: async () => baseMeta,
        subtitleList: async () => ({ needsLogin: false, tracks: [{ lan: 'ai-zh', label: 'AI', url: 'https://aisubtitle.hdslb.com/x.json', ai: true }] }),
        fetchSubtitle: async () => [{ from: 0, to: 5, text: '太短' }],
      },
      expected: VERDICT.BAD_SUBTITLE,
    },
    {
      name: '可读',
      api: {
        view: async () => baseMeta,
        subtitleList: async () => ({ needsLogin: false, tracks: [{ lan: 'ai-zh', label: 'AI', url: 'https://aisubtitle.hdslb.com/x.json', ai: true }] }),
        fetchSubtitle: async () => Array.from({ length: 20 }, (_, index) => ({ from: index * 3, to: index * 3 + 3, text: '这是一句足够长的字幕内容用来通过密度门槛' })),
      },
      expected: VERDICT.OK,
    },
  ];
  for (const item of cases) {
    const result = await readVideo(item.api, 'BV1aaaaaaaaa', { minCharsPerMinute: 60 });
    assert.equal(result.verdict, item.expected, item.name);
  }
});

test('stamp 输出 m:ss', () => {
  assert.equal(stamp(0), '0:00');
  assert.equal(stamp(65), '1:05');
  assert.equal(stamp(-5), '0:00');
});
