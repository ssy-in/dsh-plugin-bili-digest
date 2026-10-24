// 硬门槛：一条视频要么"有可用字幕"进入 L2，要么当场丢弃（无字幕/字幕残缺/取不到/价值观不合格）。
import { pickTrack } from './api.js';
import { assess, fetchAtmosphereSample } from './tone.js';

export const VERDICT = {
  OK: 'ok',
  NO_SUBTITLE: 'no-subtitle',
  NEEDS_LOGIN: 'needs-login',
  BAD_SUBTITLE: 'bad-subtitle',
  REJECTED: 'rejected',
  ERROR: 'error',
};

/**
 * 判定一条视频能否读。
 * @param {ReturnType<import('./api.js').createApi>} api
 * @param {string} bvid
 * @param {{minCharsPerMinute?: number, page?: number, checkTone?: boolean, toneOptions?: object}} [options]
 * @returns {Promise<{meta: object, verdict: string, reason?: string, assessment?: object, track?: object, cues?: Array, chars?: number, charsPerMinute?: number}>}
 */
export async function readVideo(api, bvid, options = {}) {
  const { minCharsPerMinute = 60, page, checkTone = true, toneOptions } = options;
  let meta;
  try {
    meta = await api.view(bvid);
  } catch (error) {
    return { meta: { bvid }, verdict: VERDICT.ERROR, reason: error.message };
  }
  const target = page ? meta.pages.find((item) => item.page === page) : undefined;
  const cid = target ? target.cid : meta.cid;
  const duration = target ? target.duration : meta.duration;

  // 先看它值不值得看：话术 + 评论区氛围。不合格的直接归档，不花 token 读字幕。
  if (checkTone) {
    const samples = await fetchAtmosphereSample(api, meta.aid).catch(() => []);
    const assessment = assess({ title: meta.title, desc: meta.desc || '', tags: meta.tags || [], samples }, toneOptions);
    if (assessment.reject) {
      return {
        meta,
        assessment,
        verdict: VERDICT.REJECTED,
        reason: `内容不推：${assessment.reasons.join('；')}`,
      };
    }
  }

  let listing;
  try {
    listing = await api.subtitleList(meta.bvid, cid);
  } catch (error) {
    return { meta, verdict: VERDICT.ERROR, reason: error.message };
  }
  if (!listing.tracks.length) {
    return {
      meta,
      verdict: listing.needsLogin ? VERDICT.NEEDS_LOGIN : VERDICT.NO_SUBTITLE,
      reason: listing.needsLogin ? '需要登录态才能看到字幕清单（SESSDATA 缺失或已失效）' : '该视频没有字幕轨',
    };
  }

  const track = pickTrack(listing.tracks);
  let cues;
  try {
    cues = await api.fetchSubtitle(track.url);
  } catch (error) {
    return { meta, verdict: VERDICT.ERROR, reason: `字幕下载失败：${error.message}` };
  }
  if (!cues.length) return { meta, verdict: VERDICT.NO_SUBTITLE, reason: '字幕轨是空的' };

  const chars = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  const minutes = Math.max(0.2, duration / 60);
  const charsPerMinute = chars / minutes;
  if (charsPerMinute < minCharsPerMinute) {
    return {
      meta,
      track,
      cues,
      chars,
      charsPerMinute,
      verdict: VERDICT.BAD_SUBTITLE,
      reason: `字幕残缺：${chars} 字 / ${Math.round(minutes)} 分钟 = ${charsPerMinute.toFixed(0)} 字每分钟 < ${minCharsPerMinute}`,
    };
  }
  return { meta, track, cues, chars, charsPerMinute, verdict: VERDICT.OK };
}
