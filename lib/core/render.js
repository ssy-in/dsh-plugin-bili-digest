// 报告渲染：所有来自 B 站的文本都要转义，防止标题/字幕里的 Markdown 语法破坏报告或注入链接。
import { stamp } from './segment.js';

/** 去掉控制字符、折叠换行、转义 Markdown 结构字符。 */
export function escapeMarkdown(value, { maxLength = 300 } = {}) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/([\\`*_[\]()<>#|~])/g, '\\$1');
}

export function videoUrl(bvid, seconds) {
  const base = `https://www.bilibili.com/video/${bvid}`;
  return seconds === undefined ? base : `${base}?t=${Math.max(0, Math.floor(seconds))}`;
}

export function renderVideo(section) {
  const { meta, picked, chars, track, charsPerMinute } = section;
  const lines = [];
  lines.push(`### ${escapeMarkdown(meta.title, { maxLength: 120 })}`);
  lines.push('');
  lines.push(
    `UP ${escapeMarkdown(meta.up, { maxLength: 40 })} ｜ ${stamp(meta.duration)} ｜ ${section.short ? '短视频（有字幕）｜ ' : ''}${meta.videoCount > 1 ? `${meta.videoCount} P ｜ ` : ''}` +
      `字幕 ${chars} 字（${Math.round(charsPerMinute)} 字/分，${escapeMarkdown(track?.label || track?.lan || '未知')}${track?.ai ? '，AI 生成' : ''}）`,
  );
  lines.push('');
  lines.push(`[▶ 打开视频](${videoUrl(meta.bvid)}) ｜ [📄 原字幕](https://www.bilibili.com/video/${meta.bvid}/)`);
  if (section.frames?.length) {
    lines.push(`画面 ${section.frames.length} 帧：${section.frames.map((item) => stamp(item.second)).join('、')}`);
  }
  lines.push('');
  for (const segment of picked) {
    lines.push(`- [${stamp(segment.from)}](${videoUrl(meta.bvid, segment.from)}) ${escapeMarkdown(segment.text, { maxLength: 400 })}`);
  }
  lines.push('');
  lines.push(`回查：` + '`' + `bili-digest recall ${meta.bvid} ${Math.floor(picked[0]?.from ?? 0)} ${Math.ceil(picked.at(-1)?.to ?? 0)}` + '`');
  return lines.join('\n');
}

/** 短视频（不看字幕，只看标签和画面）的一行摘要。 */
export function renderShort(short) {
  const meta = short?.meta || {};
  const tags = (short?.tags || meta.tags || []).slice(0, 8).join('、') || '（没拿到标签）';
  const mmss = `${Math.floor((meta.duration || 0) / 60)}:${String(Math.round((meta.duration || 0) % 60)).padStart(2, '0')}`;
  const frames = short?.frames?.length ? `｜画面 ${short.frames.length} 帧` : '';
  return `- [${escapeMarkdown(meta.title || meta.bvid || '', { maxLength: 60 })}](${videoUrl(meta.bvid, 0)}) ｜ ${mmss} ｜ 标签：${escapeMarkdown(tags, { maxLength: 90 })}${frames}`;
}

export function renderReport({ sections, skipped, shorts = [], stats, generatedAt = new Date() }) {
  const lines = [];
  lines.push(`# B 站速览 · ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push('');
  lines.push(
    `关键词：${stats.keywords.map((keyword) => escapeMarkdown(keyword, { maxLength: 30 })).join('、') || '（单条模式）'} ｜ ` +
      `候选 ${stats.candidates} ｜ 可读 ${sections.length} ｜ 丢弃 ${skipped.length} ｜ ` +
      `字幕 ${stats.charsIn} 字 → 入模 ${stats.charsOut} 字（省 ${stats.saved}%）`,
  );
  lines.push('');
  if (!sections.length) {
    lines.push('> 本轮没有可用字幕的视频。没有字幕的视频不会进入阅读范围。');
    lines.push('');
  }
  for (const section of sections) {
    lines.push(renderVideo(section));
    lines.push('---');
    lines.push('');
  }
  if (shorts.length) {
    lines.push('### 短视频（不看字幕，看标签 + 画面）');
    lines.push('');
    for (const short of shorts) lines.push(renderShort(short));
    lines.push('');
  }
  if (skipped.length) {
    lines.push('### 被丢弃');
    lines.push('');
    for (const item of skipped) {
      lines.push(`- ${escapeMarkdown(item.bvid, { maxLength: 20 })} ｜ ${escapeMarkdown(item.title || '', { maxLength: 60 })} ｜ ${escapeMarkdown(item.reason || item.verdict, { maxLength: 120 })}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** 给模型看的紧凑文本（工具返回值），一屏一条视频。 */
export function renderBrief({ sections, skipped, shorts = [], stats }) {
  const lines = [];
  if (stats?.login && stats.login.isLogin === false) {
    lines.push('⚠️ SESSDATA 缺失或已失效：匿名态下 B 站不下发字幕清单，这一轮基本读不到东西。更新 SESSDATA 后再刷。');
  }
  lines.push(`候选 ${stats.candidates}，可读 ${sections.length}，丢弃 ${skipped.length}，字幕 ${stats.charsIn} 字 → 入模 ${stats.charsOut} 字（省 ${stats.saved}%）。`);
  for (const section of sections) {
    lines.push('');
    lines.push(`【${section.meta.bvid}】${section.meta.title}`);
    lines.push(`UP ${section.meta.up} ｜ ${stamp(section.meta.duration)} ｜ 字幕 ${section.chars} 字（${Math.round(section.charsPerMinute)} 字/分）｜ ${videoUrl(section.meta.bvid)}`);
    for (const segment of section.picked) lines.push(`- [${stamp(segment.from)}] ${segment.text}`);
  }
  if (shorts.length) {
    lines.push('');
    lines.push('短视频（不看字幕，看标签 + 画面）：');
    for (const short of shorts) lines.push(renderShort(short));
  }
  if (skipped.length) {
    lines.push('');
    lines.push(`丢弃：${skipped.map((item) => `${item.bvid}(${item.verdict})`).join(' ')}`);
  }
  return lines.join('\n');
}
