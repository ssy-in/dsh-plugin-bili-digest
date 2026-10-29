// 配置与凭据：SESSDATA 只从环境变量或权限 0600 的私有文件读取，永不进仓库、永不打印。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = {
  minCharsPerMinute: 60,
  limit: 20,
  days: 0,
  maxK: 14,
  minK: 4,
  segmentChars: 120,
  maxSegmentChars: 3600,
  concurrency: 1,
  keepReports: 30,
  subtitleCacheHours: 24,
  // 0 = 按时长自动（见 frames.js 的 frameCountFor）
  frameCount: 0,
  autoFrames: true,
  // 心情模式：最近多少天内推过的视频不再重复推；日记保留份数。
  seenDays: 14,
  skipSeen: true,
  // 短于这个秒数的视频基本没有 AI 字幕轨，心情模式直接跳过（0 = 不筛）。
  minDuration: 180,
  maxVideos: 1,
  autoEveryMinutes: 30,
  autoMoodText: '随便看看',
  // 自动刷时直接按关键词找工作（比如 deepseek），留空则用上面的心情句
  autoKeywords: '',
  // 天气：人类填了城市坐标就按他的，没填就按出口 IP 猜（ipwho.is）。
  weatherCity: '',
  weatherLat: 0,
  weatherLon: 0,
  autoOrder: 'mix',
  autoDays: 7,
  lastAutoAt: '',
  // 空 = <dataDir>/我看视频（日记、速览、截图都放这一个能直接翻的目录里）
  outputDir: '',
  keepDiaries: 180,
  // —— @ 人类：人类 m06243「别太激进 减少」→ 每天长 2 + 短 3，两次 @ 至少隔 60 分钟 ——
  // 小号等级低，@ 太勤会被当营销号；过了测试期再降到后面那组数。
  pushDailyLong: 2,
  pushDailyShort: 3,
  pushDailyLongLater: 2,
  pushDailyShortLater: 2,
  pushReduceAfterDays: 10,
  pushMinGapMinutes: 60,
  // 「值得 @ 人类」的口味分门槛：低于它只吐槽不 @（冷启动阶段权重偏低，所以门槛不设太高）
  pushTasteBar: 0.35,
  // —— 首页推荐：首页轮占 6 成；一页存成队列慢慢读，过 3 小时或读完才再调 ——
  feedEnabled: true,
  feedRefreshHours: 3,
  feedMaxDuration: 7200,
  feedPerRound: 4,
  // —— 冷启动：前 N 天先攒数据，到期还冷就在评审里请人类加几个关键词 ——
  coldStartDays: 3,
  // 测试期倒计时从「某一天真发够 totalLimit × 这个比例」那天开始算（默认一半），只发一两条的那天不算
  pushStartAfterRatio: 0.5,
  // 作息：睡觉时间不刷、饭点更勤、上班时段更懒（详见 lib/core/schedule.js）
  scheduleEnabled: true,
  activeFrom: '08:00',
  activeTo: '01:30',
  scheduleJitter: 0.35,
  scheduleSkipChance: 0.1,
  // 短视频（秒）：短于这个数不进字幕管线，只抓画面 + 看标签随便总结。
  // 5 分钟这个界是拍的：cos/游戏/二创/资讯 99% 落在 5 分钟内，而且这些视频基本没有 AI 字幕轨。
  shortVideoMax: 300,
  // 短视频抓几帧画面（0 = 不抓，只看标签）
  shortFrames: 3,
  shortFramesNoSub: 6,
  shortProbeSubtitle: true,
  shortMinCharsPerMinute: 20,
  learnTitleTokens: true,
  titleTokenWeight: 0,
  // —— 回话额度：人类不限额；其他人共用一个池子，同一人最多几次 ——
  ownerUnlimited: true,
  // 人类回我的话按心情接：默认一半回一句，一半不回（他已经回过了）
  ownerReplyChance: 0.5,
  // 一轮里最多接人类几条（他一天能回十来条，别一次全刷完）；超过 72 小时的老消息不追着回。
  ownerPerRound: 2,
  messageMaxAgeHours: 72,
  otherReplyPerHour: 6,
  otherReplyPerDay: 24,
  otherPerPerson: 2,
  // —— 我自己的收藏夹：按人设选片，公开短评有日上限，其余只写本地 ——
  ownFavoriteEnabled: true,
  ownFavoriteCommentPerDay: 3,
  ownFavoriteFolderTitle: '鲸鲸自己收藏的',
  ownFavoriteBar: 0.5,
  lowWeightJoke: true,
  lowWeightThreshold: 0.12,
  lowWeightPushChance: 0.15,
  // —— 口味权重：快层短、慢层长，两边加权 ——
  weightCapFast: 0.8,
  weightCapSlow: 1.2,
  halfLifeFastDays: 8,
  halfLifeSlowDays: 90,
  fastWeight: 0.7,
  slowWeight: 0.3,
  exploreRate: 0.2,
  // 每隔几天生成一份「评审」，让他看我把语境判断歪了没有
  reviewEveryDays: 3,
};

/** SESSDATA 只允许 URL-safe 的 cookie 字符，且不得含分隔符/控制字符（否则可注入额外 cookie 头）。 */
const SESSDATA_RE = /^[A-Za-z0-9%*_.-]{8,300}$/;

/** bili_jct 是写操作（评论、收藏）必需的 csrf token，同样不打印、不进仓库。 */
const CSRF_RE = /^[A-Za-z0-9%*_.-]{8,120}$/;

export function validateCsrf(value) {
  if (typeof value !== 'string') throw new Error('bili_jct 必须是字符串');
  const trimmed = value.trim();
  if (!CSRF_RE.test(trimmed)) throw new Error('bili_jct 含非法字符（仅允许 A-Z a-z 0-9 % * _ . -）');
  return trimmed;
}

export function validateSessdata(value) {
  if (typeof value !== 'string') throw new Error('SESSDATA 必须是字符串');
  const trimmed = value.trim();
  if (!SESSDATA_RE.test(trimmed)) throw new Error('SESSDATA 含非法字符（长度 8-300，仅允许 A-Z a-z 0-9 % * _ . -）');
  return trimmed;
}

export function dataDir() {
  if (process.env.BILI_DIGEST_HOME) return path.resolve(process.env.BILI_DIGEST_HOME);
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'bili-digest');
}

export function configPath() {
  return process.env.BILI_DIGEST_CONFIG || path.join(dataDir(), 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`配置文件不是合法 JSON：${file}`);
    throw error;
  }
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位，忽略 */
  }
}

/**
 * 读取配置。优先级：环境变量 > 私有配置文件 > 内置默认值。
 * 不读取仓库内的 *.local.json，避免把凭据写进工作区/提交记录。
 */
export function loadConfig({ requireLogin = true } = {}) {
  const file = configPath();
  const stored = readJson(file) || {};
  const envSessdata = process.env.BILI_SESSDATA;
  let sessdata;
  if (envSessdata) sessdata = validateSessdata(envSessdata);
  else if (stored.sessdata) sessdata = validateSessdata(stored.sessdata);
  else if (requireLogin) {
    throw new Error(
      `未配置 SESSDATA。请设置环境变量 BILI_SESSDATA，或在 ${file} 写入 {"sessdata":"..."}（B 站网页版 Cookie 里的 SESSDATA 值）。` +
        '没有登录态时 B 站不返回字幕清单，本插件无法工作。',
    );
  }
  // 写操作（评论 @ 你、收藏到收藏夹）另外需要 csrf；缺它时只读功能照常工作。
  const envJct = process.env.BILI_JCT;
  let csrf;
  if (envJct) csrf = validateCsrf(envJct);
  else if (stored.biliJct) csrf = validateCsrf(stored.biliJct);
  // 设备指纹必须稳定：每次换一个 buvid3，B 站会当成新设备，登录态很容易被踢掉。
  const buvid3 = stored.buvid3 || ensureBuvid3();
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(stored).filter(([k]) => k !== 'sessdata' && k !== 'biliJct')),
    sessdata,
    csrf,
    buvid3,
    configFile: file,
    hasSessdata: Boolean(sessdata),
    hasCsrf: Boolean(csrf),
  };
}

/** 保存配置（只写非敏感字段时也走同一个 0600 文件）。 */
export function saveConfig(patch) {
  const file = configPath();
  const stored = readJson(file) || {};
  const next = { ...stored, ...patch };
  if (patch.sessdata !== undefined) next.sessdata = patch.sessdata ? validateSessdata(patch.sessdata) : undefined;
  if (next.sessdata === undefined) delete next.sessdata;
  if (patch.biliJct !== undefined) next.biliJct = patch.biliJct ? validateCsrf(patch.biliJct) : undefined;
  if (next.biliJct === undefined) delete next.biliJct;
  writePrivateJson(file, next);
  return { file, hasSessdata: Boolean(next.sessdata), hasCsrf: Boolean(next.biliJct) };
}

export function ensureBuvid3() {
  const file = configPath();
  const stored = readJson(file) || {};
  if (stored.buvid3) return stored.buvid3;
  const buvid3 = crypto.randomBytes(8).toString('hex').toUpperCase() + 'infoc';
  writePrivateJson(file, { ...stored, buvid3 });
  return buvid3;
}

/**
 * 向 B 站要一套真实的设备指纹（buvid3/buvid4）并存下来。
 * 一直用同一套指纹，登录态才不会被当成「新设备」踢掉。
 */
export async function refreshBuvid() {
  const file = configPath();
  const stored = readJson(file) || {};
  const current = stored.buvid3 || crypto.randomBytes(8).toString('hex').toUpperCase() + 'infoc';
  const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      referer: 'https://www.bilibili.com/',
      cookie: `buvid3=${current}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  const buvid3 = payload?.data?.b_3 ? `${payload.data.b_3}infoc` : current;
  const buvid4 = payload?.data?.b_4 || stored.buvid4 || '';
  writePrivateJson(file, { ...stored, buvid3, buvid4 });
  return { buvid3, buvid4, code: payload.code };
}

export { DEFAULTS };
