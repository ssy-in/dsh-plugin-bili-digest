// 天气：鲸鲸的心情要用到「外面冷不冷、潮不潮」。
//
// 两个公开接口，都不需要 key，也不带任何个人凭据：
//   ip-api.com       → 大概在哪个城市（按出口 IP，精确到城市级别）
//   open-meteo.com   → 温度 / 湿度 / 体感 / 紫外线 / 风 / 气压 / 日出日落
//
// 缓存策略：定位结果存 7 天，天气存 1 小时（这两个接口免费，但没必要每轮都问）。

import fs from 'node:fs';
import path from 'node:path';
import { getJson } from './http.js';
import { paths } from './store.js';

const GEO_TTL_MS = 7 * 24 * 3600_000;
const WEATHER_TTL_MS = 60 * 60_000;

function cacheFile(name) {
  return path.join(paths().cache, name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** WMO 天气代码 → 中文（只挑鲸鲸会提的那几种，其余归到「多云」一类）。 */
export function weatherText(code) {
  const table = {
    0: '晴',
    1: '大致晴',
    2: '多云',
    3: '阴',
    45: '有雾',
    48: '雾凇',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '浓毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    80: '阵雨',
    81: '强阵雨',
    82: '暴雨',
    95: '雷阵雨',
    96: '雷阵雨带冰雹',
  };
  return table[code] ?? '多云';
}

/** 定位：按出口 IP 猜城市，失败就说不知道，不阻塞别的功能。 */
export async function locate({ now = new Date(), force = false } = {}) {
  const file = cacheFile('geo.json');
  const cached = readJson(file);
  if (!force && cached && now.getTime() - (Date.parse(cached.at || '') || 0) < GEO_TTL_MS) return cached;
  try {
    // ipwho.is 支持 https 且不用 key；ip-api 免费版只给 http，https 要付费，所以只作备选。
    const payload = await getJson('https://ipwho.is/?fields=success,city,region,country,latitude,longitude,timezone', {
      timeoutMs: 8000,
    });
    if (payload?.success === false) throw new Error(payload?.message || '定位失败');
    if (!Number.isFinite(payload?.latitude)) throw new Error('定位结果没有经纬度');
    const next = {
      at: now.toISOString(),
      country: payload.country || '',
      region: payload.region || '',
      city: payload.city || '',
      lat: payload.latitude,
      lon: payload.longitude,
      timezone: payload.timezone?.id || payload.timezone || '',
    };
    writeJson(file, next);
    return next;
  } catch (error) {
    // 定位不到就用上次的结果，实在没有就返回空，天气那步会跳过。
    if (cached) return { ...cached, stale: true };
    return { at: now.toISOString(), city: '', error: String(error?.message || error) };
  }
}

/** 如果人类在设置里填了城市坐标，就直接用他的，不猜 IP。 */
export function placeFromConfig(config = {}) {
  const lat = Number(config.weatherLat);
  const lon = Number(config.weatherLon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
    return { at: new Date().toISOString(), city: config.weatherCity || '你填的地方', lat, lon };
  }
  return undefined;
}

/** 取当前天气（带缓存）。 */
export async function weatherNow({ now = new Date(), place, force = false } = {}) {
  const file = cacheFile('weather.json');
  const cached = readJson(file);
  // 人类填了坐标就只认这个坐标的缓存，别拿按 IP 猜出来的旧结果顶替。
  const placeKey = place ? `${place.lat},${place.lon}` : 'ip';
  const cacheValid =
    cached &&
    (cached.placeKey || 'ip') === placeKey &&
    now.getTime() - (Date.parse(cached.at || '') || 0) < WEATHER_TTL_MS;
  if (!force && cacheValid) return cached;
  const geo = place || (await locate({ now }));
  if (!Number.isFinite(geo?.lat) || !Number.isFinite(geo?.lon)) {
    return { at: now.toISOString(), city: geo?.city || '', available: false, error: '不知道在哪个城市' };
  }
  const fields = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'is_day',
    'precipitation',
    'weather_code',
    'cloud_cover',
    'pressure_msl',
    'wind_speed_10m',
    'wind_gusts_10m',
    'uv_index',
    'dew_point_2m',
    'visibility',
  ].join(',');
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${geo.lat}&longitude=${geo.lon}` +
    `&current=${fields}` +
    '&daily=sunrise,sunset,uv_index_max,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=1';
  try {
    const payload = await getJson(url, { timeoutMs: 10_000 });
    const current = payload?.current || {};
    const daily = payload?.daily || {};
    const next = {
      at: now.toISOString(),
      placeKey,
      city: geo.city || '',
      region: geo.region || '',
      available: true,
      temp: current.temperature_2m,
      feels: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      dew: current.dew_point_2m,
      isDay: current.is_day === 1,
      code: current.weather_code,
      text: weatherText(current.weather_code),
      cloud: current.cloud_cover,
      rain: current.precipitation,
      pressure: current.pressure_msl,
      wind: current.wind_speed_10m,
      gust: current.wind_gusts_10m,
      uv: current.uv_index,
      uvMax: Array.isArray(daily.uv_index_max) ? daily.uv_index_max[0] : undefined,
      visibility: current.visibility,
      sunrise: Array.isArray(daily.sunrise) ? daily.sunrise[0] : '',
      sunset: Array.isArray(daily.sunset) ? daily.sunset[0] : '',
      high: Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : undefined,
      low: Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : undefined,
      rainChance: Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : undefined,
    };
    writeJson(file, next);
    return next;
  } catch (error) {
    if (cached?.available) return { ...cached, stale: true };
    return { at: now.toISOString(), city: geo.city || '', available: false, error: String(error?.message || error) };
  }
}

/** 一句话描述天气，给日记和评论用。 */
export function describeWeather(weather) {
  if (!weather?.available) return '';
  const bits = [];
  if (weather.city) bits.push(weather.city);
  if (Number.isFinite(weather.temp)) bits.push(`${Math.round(weather.temp)}°`);
  if (Number.isFinite(weather.humidity)) bits.push(`湿度 ${Math.round(weather.humidity)}%`);
  if (weather.text) bits.push(weather.text);
  if (Number.isFinite(weather.wind)) bits.push(`风 ${Math.round(weather.wind)}`);
  return bits.join(' ');
}
