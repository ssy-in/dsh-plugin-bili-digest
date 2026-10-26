#!/usr/bin/env node
// 命令行入口：不装 DSH 也能用。子命令 run / read / recall / status / login。
import fs from 'node:fs';
import { run, runAndSave, runMood, createApi, loadConfig } from '../lib/core/digest.js';
import { readVideo, VERDICT } from '../lib/core/gate.js';
import { saveConfig, configPath, dataDir, refreshBuvid } from '../lib/core/config.js';
import { readLastDigest, paths } from '../lib/core/store.js';
import { stamp } from '../lib/core/segment.js';
import { collectFrames, saveFrames } from '../lib/core/visual.js';
import { frameCountFor, MAX_FRAMES } from '../lib/core/frames.js';
import { PRESETS } from '../lib/core/mood.js';
import { listFolders, resolveFolders, dealFavorite, postComment, buildComment, roleForVideo, pushState, recordPush, pushPlan, vetoVideo, FOLDER_ROLES } from '../lib/core/write.js';
import { runInbox, noteUnclear, readReview, LIMITS } from '../lib/core/inbox.js';
import { readTagBook, syncTagBook } from '../lib/core/tagbook.js';
import { reviewState, syncReview } from '../lib/core/review.js';
import { renderTalks, syncTalks } from '../lib/core/talks.js';
import { summarizeTitles, resetTitleLog } from '../lib/core/titles.js';

const USAGE = `bili-digest — 字幕优先的 B 站视频阅读器

用法：
  bili-digest run [--kw 关键词1,关键词2] [--days 7] [--limit 20] [--k 8] [--mincpm 60]
                  [--order pubdate|totalrank|click|dm|stow|scores] [--print] [--all]
  bili-digest mood "今天有点累，想看点轻松的" [--preset relax|learn|rant|hype|random]
                  [--days 7] [--limit 20] [--videos 1] [--mindur 180] [--print]
  bili-digest presets                                # 看看有哪几档心情
  bili-digest read BV1xxxxxxxxx [--k 8] [--frames 6]   # --frames 顺带存几帧画面
  bili-digest frames BV1xxxxxxxxx [--count 12] [--at 12,95,400]  # 分镜截图（不需要 ffmpeg）
  bili-digest recall BV1xxxxxxxxx 起始秒 结束秒       # 回看原始字幕
  bili-digest status                                # 登录态与配置位置
  bili-digest login --sessdata <值> [--jct <bili_jct>]  # 写入私有配置（0600）；--jct 才解锁写操作
  bili-digest folders                               # 看看收藏夹，以及四个角色对上了没有
  bili-digest fav BV1xxxxxxxxx --role mood|deepseek|misc|liked   # 收藏进对应收藏夹
  bili-digest push BV1xxxxxxxxx --at-name 昵称 --at-mid 12345 [--text "..."]  # 收藏 + 发一条 @ 人类的评论（每天最多 3 条）
  bili-digest inbox [--send] [--limit 3]            # 谁回复/@ 了我：回一句（人类不限、其他人每人 2 次、6/小时、24/天）
  bili-digest review [sync]                         # 待评审清单（sync = 立刻写一份到「我看视频/评审/」）
  bili-digest talks [--limit 50]                    # 对话流水（我说了什么、人类说了什么）
  bili-digest tags                                  # 重建标签库文档：我喜欢的 / 人类喜欢的
  bili-digest titles [--limit 500] [--reset]         # 标题拆词的记录与可行性汇总（目前只记录、不参与排序）
  bili-digest last                                  # 上次结果摘要

环境变量：
  BILI_SESSDATA        B 站网页 Cookie 里的 SESSDATA（优先于配置文件）
  BILI_DIGEST_HOME     数据目录（默认 $DSH_HOME/bili-digest）
  BILI_DIGEST_CONFIG   配置文件路径

说明：没有字幕的视频不会进入阅读范围（用 frames 抓画面看它）；有字幕的只把打分最高的若干段交给模型。
mood 会同时写两份：reports/ 下给你的速览，diary/ 下给自己看的心情日记。
`;

export function moodUsage() {
  const lines = ['可用的心情档位：'];
  for (const preset of PRESETS) lines.push(`  ${preset.id.padEnd(7)} ${preset.label}（${preset.tone}）→ ${preset.keywords.join('、') || '不限'}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(token);
  }
  return args;
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

async function writeFrames(api, bvid, { count, seconds }) {
  const video = await api.view(bvid);
  const wanted = Math.min(MAX_FRAMES, Math.max(1, Math.round(count || frameCountFor(video.duration))));
  const { frames } = await collectFrames(api, bvid, {
    cid: video.cid,
    duration: video.duration,
    count: seconds?.length ? undefined : wanted,
    seconds: seconds?.length ? seconds : undefined,
  });
  if (frames.length === 0) {
    process.stderr.write(`${bvid}：没有抓到画面\n`);
    return;
  }
  const saved = saveFrames(bvid, frames);
  process.stderr.write(`《${video.title}》（${stamp(video.duration)}）${frames.length} 帧 → ${saved.dir}\n`);
  for (const frame of frames) {
    process.stdout.write(
      `[${stamp(frame.second)}] ${frame.width}x${frame.height} ${frame.buffer.length}B  https://www.bilibili.com/video/${bvid}?t=${Math.round(frame.second)}\n`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0] || 'help';

  if (command === 'help' || args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === 'login') {
    const sessdata = typeof args.sessdata === 'string' ? args.sessdata : process.env.BILI_SESSDATA;
    const jct = typeof args.jct === 'string' ? args.jct : process.env.BILI_JCT;
    if (sessdata) {
      const saved = saveConfig({ sessdata });
      process.stdout.write(`已写入 ${saved.file}\n`);
    }
    if (jct) {
      const saved = saveConfig({ biliJct: jct });
      process.stdout.write(`bili_jct 已写入 ${saved.file}（写操作已解锁）\n`);
    }
    if (!sessdata && !jct) throw new Error('用法：bili-digest login --sessdata <SESSDATA> [--jct <bili_jct>]');
    // 先固定设备指纹，再验登录：指纹每次都变的话 B 站会把登录态当新设备踢掉。
    const fingerprint = await refreshBuvid();
    process.stderr.write(`设备指纹已固定（buvid3 ${fingerprint.buvid3.slice(0, 8)}…）\n`);
    const api = createApi(loadConfig());
    const me = await api.me();
    process.stdout.write(me.isLogin ? `登录成功：${me.uname}（mid ${me.mid}）\n` : 'SESSDATA 无效或已过期\n');
    return me.isLogin ? 0 : 1;
  }

  const needsLogin = !['status', 'last', 'help', 'frames', 'presets', 'review', 'tags', 'talks', 'titles'].includes(command);
  const config = loadConfig({ requireLogin: needsLogin });

  if (command === 'tags') {
    const book = syncTagBook();
    process.stdout.write(`标签库：${book.file}\n我看上的 ${book.mine} 条／人类喜欢的 ${book.his} 条\n`);
    if (!book.mine && !book.his) {
      process.stdout.write('（还没有内容：等下一轮读完视频，或人类在评论里说喜欢，这里就会长出来。）\n');
    }
    return 0;
  }

  if (command === 'presets') {
    process.stdout.write(moodUsage());
    return 0;
  }

  if (command === 'folders') {
    const folders = await listFolders(config);
    process.stdout.write('账号下的收藏夹：\n');
    for (const folder of folders) process.stdout.write(`  ${folder.id}  ${folder.title}  (${folder.count})\n`);
    const roles = await resolveFolders(config, (patch) => saveConfig(patch));
    process.stdout.write('\n五个角色：\n');
    for (const [role, meta] of Object.entries(FOLDER_ROLES)) {
      const id = roles[role];
      process.stdout.write(`  ${role.padEnd(9)} → ${id ? `${meta.title}（${id}）` : `没找到「${meta.title}」，去 B 站建一个同名收藏夹`}  ${meta.hint}\n`);
    }
    return 0;
  }

  if (command === 'fav') {
    const bvid = args._[1];
    if (!bvid) throw new Error('用法：bili-digest fav BV1xxxxxxxxx --role mood|deepseek|misc|liked');
    const role = typeof args.role === 'string' ? args.role : 'misc';
    if (!FOLDER_ROLES[role]) throw new Error(`--role 只能是 ${Object.keys(FOLDER_ROLES).join(' / ')}`);
    const api = createApi(config);
    const video = await api.view(bvid);
    const roles = await resolveFolders(config, (patch) => saveConfig(patch));
    const mediaId = roles[role];
    if (!mediaId) throw new Error(`收藏夹「${FOLDER_ROLES[role].title}」还没对上 media_id，先跑 bili-digest folders`);
    await dealFavorite(config, { aid: video.aid, add: [mediaId] });
    process.stdout.write(`已收藏《${video.title}》→ ${FOLDER_ROLES[role].title}（${mediaId}）\n`);
    return 0;
  }

  if (command === 'push') {
    const bvid = args._[1];
    if (!bvid) throw new Error('用法：bili-digest push BV1xxxxxxxxx --at-name 昵称 --at-mid 12345 [--role mood] [--text "..."] [--dry]');
    const atName = typeof args['at-name'] === 'string' ? args['at-name'] : config.atName || '';
    const atMid = typeof args['at-mid'] === 'string' ? args['at-mid'] : config.atMid || '';
    if (args['at-name'] || args['at-mid']) {
      const patch = {};
      if (args['at-name']) patch.atName = atName;
      if (args['at-mid']) patch.atMid = String(atMid);
      saveConfig(patch);
    }
    const track = args.short ? 'short' : 'long';
    const plan = pushPlan(config);
    const state = pushState(new Date(), config);
    const left = track === 'short' ? state.shortRemaining : state.longRemaining;
    if (left <= 0) {
      throw new Error(
        `今天${track === 'short' ? '短' : '长'}视频已经 @ 了 ${state.tracks[track]} 条（上限 ${track === 'short' ? plan.shortLimit : plan.longLimit}），明天再说`,
      );
    }
    const api = createApi(config);
    const video = await api.view(bvid);
    const last = readLastDigest();
    const section = (last?.sections || []).find((item) => item.bvid === bvid) || { meta: video };
    const role = typeof args.role === 'string' ? args.role : roleForVideo({ mood: last?.mood, title: video.title, summary: video.desc || '', keywords: last?.mood?.keywords });
    const text = typeof args.text === 'string' ? args.text : buildComment({ mood: last?.mood, section, atName });
    process.stderr.write(`角色：${role}（${FOLDER_ROLES[role]?.title || '未知'}）｜${track === 'short' ? '短视频' : '长视频'}档还能 @ ${left} 条｜今天共 ${state.remaining}/${plan.totalLimit}\n`);
    process.stderr.write(`评论草稿：\n${text}\n`);
    if (args.dry) {
      process.stdout.write('（--dry：只打印，不落收藏夹、不发评论）\n');
      return 0;
    }
    const roles = await resolveFolders(config, (patch) => saveConfig(patch));
    const mediaId = roles[role];
    if (mediaId) await dealFavorite(config, { aid: video.aid, add: [mediaId] });
    const posted = await postComment(config, { oid: video.aid, message: text, atName, atMid });
    const after = recordPush({ bvid, role, rpid: posted.rpid, text, track }, new Date(), config, (patch) => saveConfig(patch));
    process.stdout.write(
      `已收藏《${video.title}》→ ${FOLDER_ROLES[role]?.title || role}${atName ? `，并在视频下 @ 了 ${atName}` : ''}｜今天共 ${after.count}/${after.plan.totalLimit} 条（长 ${after.tracks.long}/${after.plan.longLimit}、短 ${after.tracks.short}/${after.plan.shortLimit}）\n`,
    );
    return 0;
  }

  if (command === 'inbox') {
    const send = Boolean(args.send);
    const limit = num(args.limit, 0);
    const result = await runInbox({ config, send, maxPerRun: limit, save: (patch) => saveConfig(patch) });
    process.stderr.write(
      `消息 ${result.total} 条｜其他人这一小时还能回 ${result.quota.hourLeft}/${result.quota.limits.otherPerHour}、今天还能回 ${result.quota.dayLeft}/${result.quota.limits.otherPerDay}｜人类已回 ${result.quota.ownerUsed} 条（不限额）\n`,
    );
    for (const error of result.errors) process.stderr.write(`拉取 ${error.kind} 失败：${error.error}\n`);
    const lines = [];
    for (const item of result.preferences || []) {
      const what = item.pref === 'like' ? '说喜欢' : '说不要';
      lines.push(`人类${what}：${item.applied.bvid || item.bvid} → 「${item.applied.folder}」（收藏请求：${item.applied.favorite || '未发'}，标签库已更新）`);
    }
    for (const item of send ? result.replied : result.drafts) {
      lines.push(`@${item.nickname}（${item.mid}）${item.toOwner ? '·人类' : ''}：${item.text}`);
      if (item.bvid) lines.push(`    ${item.bvid} https://www.bilibili.com/video/${item.bvid}`);
    }
    for (const item of result.skipped) lines.push(`跳过 @${item.nickname || item.mid}：${item.reason}`);
    if (!lines.length) lines.push('没有需要回的消息。');
    if (!send) lines.push('', '（这是草稿：确认没问题后加 --send 真发。）');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  if (command === 'mood') {
    const text = args._.slice(1).join(' ').trim();
    const preset = typeof args.preset === 'string' ? args.preset : undefined;
    const keywords = typeof args.kw === 'string' ? args.kw.split(',').map((word) => word.trim()).filter(Boolean) : undefined;
    if (!text && !preset && !(keywords && keywords.length)) throw new Error(`用法：bili-digest mood "今天有点累" [--preset relax] 或 mood --kw deepseek\n${moodUsage()}`);
    const result = await runMood({
      mood: text,
      preset,
      keywords,
      days: num(args.days, undefined),
      limit: num(args.limit, undefined),
      k: args.k === undefined ? undefined : num(args.k, undefined),
      minCharsPerMinute: num(args.mincpm, undefined),
      minDuration: args.mindur === undefined ? undefined : num(args.mindur, undefined),
      maxVideos: args.videos === undefined ? undefined : num(args.videos, undefined),
      order: typeof args.order === 'string' ? args.order : undefined,
      skipSeen: !args.all,
      config,
      // 价值观不合格的视频：静默归档到「我不喜欢的视频」，不 @、不进日记。
      onVeto: (item) => vetoVideo(config, item.meta, (patch) => saveConfig(patch)),
      onProgress: (event) => {
        if (event.phase === 'gate') process.stderr.write(`  [${event.index}/${event.total}] ${event.bvid} ${event.verdict}${event.cached ? ' (cache)' : ''}\n`);
        else if (event.phase === 'dedupe') process.stderr.write(`  去重：${event.candidates} 条里 ${event.repeated} 条最近已推过\n`);
        else if (event.phase === 'pause') process.stderr.write(`  这一轮先看 ${event.read} 条，还有 ${event.deferred} 条留给下次\n`);
        else process.stderr.write(`  搜索「${event.keyword}」→ ${event.found} 条\n`);
      },
    });
    process.stderr.write(`心情：${result.mood.tone}${result.mood.preset ? `（${result.mood.preset.label}）` : ''}｜关键词：${result.mood.keywords.join('、')}\n`);
    if (result.files && result.files.diary && result.files.diary.length) {
      for (const file of result.files.diary) process.stderr.write(`日记：${file}\n`);
      for (const file of result.files.report) process.stderr.write(`日报：${file}\n`);
    } else {
      process.stderr.write(`速览：${result.report}\n日记：${result.diary}\n`);
    }
    process.stdout.write(`${args.print ? result.diaryMarkdown : result.brief}\n`);
    return 0;
  }

  if (command === 'review') {
    const items = readReview();
    if (!items.length) {
      process.stdout.write('没有待复盘的东西。\n');
      return 0;
    }
    const lines = items.slice(-20).map((item) => `${item.at.slice(0, 16).replace('T', ' ')}｜${item.bvid || '—'}｜他说：${item.comment.slice(0, 60)}｜我猜：${item.guess || '—'}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  if (command === 'status') {
    process.stdout.write(`配置文件：${configPath()}\n数据目录：${dataDir()}\n`);
    if (!config.hasSessdata) {
      process.stdout.write('未配置 SESSDATA：匿名态拿不到字幕清单。用 bili-digest login --sessdata <值>\n');
      return 1;
    }
    const api = createApi(config);
    const me = await api.me();
    process.stdout.write(me.isLogin ? `已登录：${me.uname}（mid ${me.mid}）\n` : 'SESSDATA 已失效，请重新登录\n');
    return me.isLogin ? 0 : 1;
  }

  if (command === 'run') {
    const keywords = typeof args.kw === 'string' ? args.kw.split(',').map((word) => word.trim()).filter(Boolean) : [];
    if (!keywords.length && !args.bv) throw new Error('run 需要 --kw 或 --bv');
    const options = {
      keywords,
      bv: typeof args.bv === 'string' ? args.bv : undefined,
      days: num(args.days, undefined),
      limit: num(args.limit, undefined),
      k: args.k === undefined ? undefined : num(args.k, undefined),
      minCharsPerMinute: num(args.mincpm, undefined),
      order: typeof args.order === 'string' ? args.order : undefined,
      config,
      onProgress: (event) => {
        if (event.phase === 'gate') process.stderr.write(`  [${event.index}/${event.total}] ${event.bvid} ${event.verdict}${event.cached ? ' (cache)' : ''}\n`);
        else process.stderr.write(`  搜索「${event.keyword}」→ ${event.found} 条\n`);
      },
    };
    const result = await runAndSave(options);
    process.stderr.write(`\n报告：${result.report}\n`);
    if (args.print) process.stdout.write(`${result.markdown}\n`);
    else process.stdout.write(`${result.brief}\n`);
    return 0;
  }

  if (command === 'read') {
    const bvid = args._[1];
    if (!bvid) throw new Error('用法：bili-digest read BV1xxxxxxxxx [--frames 6]');
    const framesWanted = args.frames === undefined ? 0 : Math.max(0, Math.min(MAX_FRAMES, num(args.frames, 0)));
    const result = await runAndSave({ bv: bvid, k: args.k === undefined ? undefined : num(args.k, undefined), config });
    process.stderr.write(`\n报告：${result.report}\n`);
    process.stdout.write(`${args.print ? result.markdown : result.brief}\n`);
    if (framesWanted > 0 && result.sections.length > 0) {
      // 优先对准被引用的片段起点：这样每帧都能和上面的某句话对上。
      const picked = result.sections[0].picked.slice(0, framesWanted);
      await writeFrames(createApi(config), bvid, { count: framesWanted, seconds: picked.map((segment) => Math.max(0, Math.floor(segment.from))) });
    }
    return result.sections.length ? 0 : 2;
  }

  if (command === 'frames') {
    const bvid = args._[1];
    if (!bvid) throw new Error('用法：bili-digest frames BV1xxxxxxxxx [--count 12] [--at 12,95,400]');
    const seconds = typeof args.at === 'string'
      ? args.at.split(',').map((value) => num(value, NaN)).filter((value) => Number.isFinite(value) && value >= 0)
      : [];
    await writeFrames(createApi(config), bvid, {
      count: args.count === undefined ? undefined : num(args.count, undefined),
      seconds,
    });
    return 0;
  }

  if (command === 'recall') {
    const [, bvid, fromArg, toArg] = args._;
    if (!bvid) throw new Error('用法：bili-digest recall BV1xxxxxxxxx 起始秒 结束秒');
    const api = createApi(config);
    const gate = await readVideo(api, bvid, { minCharsPerMinute: 0 });
    if (gate.verdict !== VERDICT.OK) throw new Error(`无法读取 ${bvid}：${gate.reason || gate.verdict}`);
    const from = num(fromArg, 0);
    const to = num(toArg, Infinity);
    for (const cue of gate.cues) {
      if (cue.to < from || cue.from > to) continue;
      process.stdout.write(`[${stamp(cue.from)}] ${cue.text}\n`);
    }
    return 0;
  }

  if (command === 'review') {
    const state = reviewState(new Date(), config);
    const wrote = args._[1] === 'sync' ? syncReview({ config, force: true }) : null;
    process.stdout.write(
      `待评审 ${state.pending} 条 ｜ 每 ${state.everyDays} 天一份 ｜ 上次 ${state.lastAt || '（还没有）'} ｜ 下次 ${state.nextAt}\n`,
    );
    if (wrote?.file) process.stdout.write(`已写：${wrote.file}\n`);
    for (const item of state.items) {
      process.stdout.write(`- ${item.bvid || ''} ｜ ${item.guess || item.kind || ''} ｜ ${item.reason || item.comment || ''}\n`);
    }
    return 0;
  }

  if (command === 'talks') {
    const file = syncTalks({});
    process.stdout.write(renderTalks({ limit: num(args.limit, 50) }));
    process.stdout.write(`\n（已写 ${file}）\n`);
    return 0;
  }

  if (command === 'titles') {
    if (args.reset) {
      resetTitleLog();
      process.stdout.write('标题词元日志已清空\n');
      return 0;
    }
    const summary = summarizeTitles({ limit: num(args.limit, 500) });
    if (!summary.entries) {
      process.stdout.write(`还没有标题词元（只记录、不参与排序）。累起来会写在 ${summary.file}\n`);
      return 0;
    }
    process.stdout.write(`标题词元：${summary.entries} 条视频 ｜ 切出 ${summary.distinctTokens} 个不同词 ｜ 命中已有权重 ${summary.hitTokens} 次（${Math.round(summary.hitRate * 100)}% 的视频至少命中一个）\n`);
    process.stdout.write('\n最常见的词：\n');
    for (const [token, count] of summary.top) process.stdout.write(`- ${token} ×${count}\n`);
    if (summary.topEmotion.length) {
      process.stdout.write('\n情绪词（单独一栏，不参与内容口味）：\n');
      for (const [word, count] of summary.topEmotion) process.stdout.write(`- ${word} ×${count}\n`);
    }
    process.stdout.write(`\n日志：${summary.file}\n`);
    return 0;
  }

  if (command === 'last') {
    const last = readLastDigest();
    if (!last) {
      process.stdout.write('还没有运行记录\n');
      return 1;
    }
    process.stdout.write(`上次运行：${last.at}\n报告：${last.report}\n`);
    process.stdout.write(`候选 ${last.stats.candidates} ｜ 可读 ${last.stats.readable} ｜ 丢弃 ${last.stats.dropped} ｜ 省 ${last.stats.saved}%\n`);
    for (const section of last.sections) process.stdout.write(`- ${section.bvid} ｜ ${section.title} ｜ ${section.chars} 字\n`);
    process.stdout.write(`数据目录：${paths().root}\n`);
    return 0;
  }

  process.stderr.write(`未知子命令：${command}\n\n${USAGE}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exit(1);
  });
