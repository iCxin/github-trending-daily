#!/usr/bin/env node
/**
 * 抓取 GitHub Trending，生成可追溯的数据快照。
 *
 * 输出：
 *   data/trending.json          页面读取的最新快照（含趋势与详情）
 *   data/trending.js            同上，供 file:// 直接打开
 *   data/history/YYYY-MM-DD.json 每日历史快照（趋势基线）
 *   data/history/index.json     历史索引与保留期
 *   data/run-report.json        本次运行的校验结果与降级记录
 *   feed.xml                    每日总榜 RSS（仅成功快照生成）
 *
 * 用法：
 *   node scripts/fetch-trending.mjs
 *   node scripts/fetch-trending.mjs --windows=daily,weekly --boards=all,python
 *   node scripts/fetch-trending.mjs --dry-run        # 仅校验，不写任何文件
 *   node scripts/fetch-trending.mjs --migrate-legacy # 把旧版数据迁移到快照结构
 */

import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const HISTORY_DIR = join(DATA_DIR, 'history');
const SNAPSHOT_FILE = join(DATA_DIR, 'trending.json');
const HISTORY_INDEX_FILE = join(HISTORY_DIR, 'index.json');
const FEED_FILE = join(ROOT, 'feed.xml');
const RUN_REPORT_FILE = join(DATA_DIR, 'run-report.json');

const SCHEMA_VERSION = 2;
const REQUEST_TIMEOUT = 25000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 github-trending-daily';

const WINDOWS = [
  { id: 'daily', label: '今日', since: 'daily', growthLabel: '今日新增' },
  { id: 'weekly', label: '本周', since: 'weekly', growthLabel: '本周新增' },
  { id: 'monthly', label: '本月', since: 'monthly', growthLabel: '本月新增' },
];

const BOARDS = [
  { id: 'all', label: '总榜', path: '/trending' },
  { id: 'python', label: 'Python', path: '/trending/python', language: 'Python' },
  { id: 'javascript', label: 'JavaScript', path: '/trending/javascript', language: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript', path: '/trending/typescript', language: 'TypeScript' },
  { id: 'go', label: 'Go', path: '/trending/go', language: 'Go' },
  { id: 'rust', label: 'Rust', path: '/trending/rust', language: 'Rust' },
  { id: 'java', label: 'Java', path: '/trending/java', language: 'Java' },
];

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function envInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const RETENTION_DAYS = envInt('SNAPSHOT_RETENTION_DAYS', 30, 1, 365);
const CYCLE_HOURS = envInt('UPDATE_CYCLE_HOURS', 24, 1, 168);
const MIN_ITEMS_ALL = envInt('MIN_ITEMS_ALL', 8, 1, 100);
const MIN_ITEMS_LANGUAGE = envInt('MIN_ITEMS_LANGUAGE', 3, 1, 100);
const MAX_MISSING_RATE = Math.min(
  1,
  Math.max(0, Number(process.env.MAX_MISSING_RATE ?? 0.2) || 0.2),
);
const FETCH_DELAY = envInt('FETCH_DELAY_MS', 500, 0, 5000);
const DETAIL_LIMIT = envInt('DETAIL_LIMIT', 60, 0, 500);
const RELEASE_LIMIT = envInt('RELEASE_LIMIT', 12, 0, 100);

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function cleanText(html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstGroup(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

function toCount(text) {
  if (text == null) return null;
  const match = String(text).match(/(\d[\d,]*)/);
  if (!match) return null;
  const value = Number.parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(value) ? value : null;
}

function toRepoCount(text) {
  const value = toCount(text);
  // 排除解析到 SVG 路径等异常数字的情况
  return value != null && value > 0 && value <= 20000000 ? value : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickDescription(chunk, owner, name) {
  const labelPattern = new RegExp(
    `^(?:Sponsor\\s+)?Star\\s+${escapeRegExp(owner)}\\s*\\/\\s*${escapeRegExp(name)}\\s*`,
    'i',
  );
  let description = null;

  for (const match of chunk.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = cleanText(match[1])
      .replace(labelPattern, '')
      .replace(/^(?:Sponsor\s+)?Star\s+\S+\s*\/\s*\S+\s*/i, '')
      .trim();
    if (text && (!description || text.length > description.length)) {
      description = text;
    }
  }

  return description;
}

function parseRepoRow(chunk, board) {
  // 仓库名取自标题里的第一个链接，避免误匹配页脚或其他链接
  const repoMatch = chunk.match(
    /<h2[\s\S]*?href="\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)"/i,
  );
  if (!repoMatch) return null;

  const [, owner, name] = repoMatch;
  const description = pickDescription(chunk, owner, name);

  // 总 star：优先 aria-label，其次 stargazers 链接里的文本
  const stars =
    toRepoCount(
      firstGroup(chunk, /aria-label="([\d,]+)\s+users\s+starred\s+this\s+repository"/i),
    ) ??
    toRepoCount(
      cleanText(firstGroup(chunk, /href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i)),
    );

  // fork：优先 forks 链接里的文本，其次 aria-label
  const forks =
    toRepoCount(
      cleanText(
        firstGroup(chunk, /href="\/[^"]+\/(?:forks|network\/members)"[^>]*>([\s\S]*?)<\/a>/i),
      ),
    ) ??
    toRepoCount(
      firstGroup(chunk, /aria-label="([\d,]+)\s+users\s+forked\s+this\s+repository"/i),
    );

  // 页面文案随时时间窗变化：stars today / this week / this month
  const growth = toCount(
    firstGroup(chunk, /([\d,]+)\s*stars?\s+(?:today|this\s+week|this\s+month)/i),
  );

  const languageTag = chunk.match(/<span[^>]*class="[^"]*repo-language-color[^"]*"[^>]*>/i);
  const languageColor = languageTag
    ? (firstGroup(languageTag[0], /background-color:\s*([^;"']+)/i) || '').trim() || null
    : null;
  const language =
    cleanText(firstGroup(chunk, /itemprop="programmingLanguage"[^>]*>([^<]+)</i)) ||
    board.language ||
    null;

  return {
    fullName: `${owner}/${name}`,
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    description,
    language,
    languageColor,
    stars,
    forks,
    growth,
    details: null,
  };
}

/**
 * 解析 GitHub Trending 页面，返回按页面顺序排列的仓库列表。
 * 已导出，便于离线用固定 HTML 做解析测试。
 */
export function parseTrendingHtml(html, board = {}) {
  return html
    .split(/<article[\s>]/i)
    .slice(1)
    .map((chunk) => parseRepoRow(chunk, board))
    .filter(Boolean)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

async function fetchHtml(path, since) {
  const url = `https://github.com${path}?since=${since}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchHtmlWithRetry(path, since) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchHtml(path, since);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw lastError;
}

async function fetchFromApi(board, token) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const qualifiers = [`created:>${since}`, 'stars:>10'];
  if (board.language) qualifiers.push(`language:${board.language}`);

  const url =
    'https://api.github.com/search/repositories?q=' +
    `${encodeURIComponent(qualifiers.join(' '))}&sort=stars&order=desc&per_page=25`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  const payload = await response.json();

  return (payload.items || []).map((repo, index) => ({
    rank: index + 1,
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    url: repo.html_url,
    description: repo.description || null,
    language: repo.language || board.language || null,
    languageColor: null,
    stars: repo.stargazers_count ?? null,
    forks: repo.forks_count ?? null,
    growth: null,
    details: null,
  }));
}

function minItemsFor(board) {
  return board.id === 'all' ? MIN_ITEMS_ALL : MIN_ITEMS_LANGUAGE;
}

/**
 * 完整性与去重校验。返回可发布条目或判定失败的原因。
 * 规则见 PRD 9.5：重复条目、条目数不足、必填字段缺失率过高都判为不完整。
 */
export function assessItems(rawItems, board) {
  const items = [];
  const seen = new Set();
  let duplicates = 0;
  let missing = 0;

  for (const item of rawItems) {
    const key = String(item.fullName || '').toLowerCase();
    if (!key) {
      missing += 1;
      continue;
    }
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    const required = [item.fullName, item.owner, item.name, item.url, item.rank];
    if (required.some((value) => value == null || value === '' || value === 0)) {
      missing += 1;
    }
    items.push(item);
  }

  const total = Math.max(1, rawItems.length);
  const missingRate = missing / total;
  const min = minItemsFor(board);

  if (items.length < min) {
    return {
      ok: false,
      code: 'below-min',
      reason: `条目数 ${items.length} 低于下限 ${min}`,
      items: [],
    };
  }
  if (duplicates > 0) {
    return {
      ok: false,
      code: 'duplicates',
      reason: `存在 ${duplicates} 个重复条目`,
      items: [],
    };
  }
  if (missingRate > MAX_MISSING_RATE) {
    return {
      ok: false,
      code: 'missing-fields',
      reason: `必填字段缺失率 ${(missingRate * 100).toFixed(0)}% 超过阈值`,
      items: [],
    };
  }

  return { ok: true, code: 'ok', reason: null, items };
}

async function fetchBoardWindow(board, window, token) {
  let lastError;
  try {
    const html = await fetchHtmlWithRetry(board.path, window.since);
    const parsed = parseTrendingHtml(html, board);
    const assessed = assessItems(parsed, board);
    if (!assessed.ok) throw new Error(`页面数据不完整：${assessed.reason}`);
    return {
      status: 'ok',
      source: 'html',
      items: assessed.items,
      error: null,
    };
  } catch (error) {
    lastError = error;
    console.warn(
      `[warn] ${board.label} · ${window.label} 页面抓取失败：${error.message}，改用 GitHub API`,
    );
  }

  try {
    const items = await fetchFromApi(board, token);
    const assessed = assessItems(items, board);
    if (!assessed.ok) throw new Error(`API 数据不完整：${assessed.reason}`);
    return {
      status: 'ok',
      source: 'api',
      items: assessed.items,
      error: lastError ? lastError.message : null,
    };
  } catch (error) {
    throw new Error(`${lastError?.message || '页面抓取失败'}；API 兜底失败：${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 历史与趋势                                                          */
/* ------------------------------------------------------------------ */

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function loadHistory() {
  let names = [];
  try {
    names = await readdir(HISTORY_DIR);
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const snapshot = await readJsonIfExists(join(HISTORY_DIR, name));
    if (!snapshot || !Array.isArray(snapshot.boards)) continue;
    entries.push({ date: name.slice(0, 10), snapshot });
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  return entries;
}

function isValidSnapshot(snapshot) {
  const all = snapshot.boards?.find((board) => board.id === 'all');
  const daily = all?.windows?.daily;
  return Boolean(daily && daily.status === 'ok' && Array.isArray(daily.items) && daily.items.length);
}

function windowOf(snapshot, boardId, windowId) {
  return snapshot?.boards?.find((board) => board.id === boardId)?.windows?.[windowId] || null;
}

function itemKey(item) {
  return String(item.fullName || '').toLowerCase();
}

export function computeTrend(item, boardId, windowId, baselines) {
  const key = itemKey(item);
  const previous = baselines.find((entry) => isValidSnapshot(entry.snapshot));
  const baselineWindow = previous ? windowOf(previous.snapshot, boardId, windowId) : null;
  if (!baselineWindow?.items?.length) return null;
  const baselineItem = baselineWindow.items.find((entry) => itemKey(entry) === key) || null;
  if (!baselineItem) return { type: 'new', delta: 0, streak: 1 };

  let type = 'same';
  let delta = 0;
  if (Number(item.rank) < Number(baselineItem.rank)) {
    type = 'up';
    delta = Number(baselineItem.rank) - Number(item.rank);
  } else if (Number(item.rank) > Number(baselineItem.rank)) {
    type = 'down';
    delta = Number(item.rank) - Number(baselineItem.rank);
  }

  let streak = 1;
  for (const entry of baselines) {
    if (!isValidSnapshot(entry.snapshot)) continue;
    const win = windowOf(entry.snapshot, boardId, windowId);
    if (!win || win.status !== 'ok') continue;
    if (!win.items.some((candidate) => itemKey(candidate) === key)) break;
    streak += 1;
  }

  return { type, delta, streak };
}

function applyTrends(snapshot, baselines) {
  for (const board of snapshot.boards) {
    for (const window of WINDOWS) {
      const win = board.windows[window.id];
      if (!win || win.status !== 'ok' || win.source === 'api') continue;
      for (const item of win.items) {
        item.trend = computeTrend(item, board.id, window.id, baselines);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 详情补充                                                            */
/* ------------------------------------------------------------------ */

async function mapLimit(items, limit, mapper) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await mapper(items[index]);
      } catch {
        // 单条失败不影响其余条目
      }
    }
  });
  await Promise.all(workers);
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (response.status === 403 || response.status === 429) {
    const error = new Error(`GitHub API 限流或拒绝访问（HTTP ${response.status}）`);
    error.fatal = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function enrichDetails(snapshot, token) {
  if (!token) return { enabled: false, reason: '缺少 GITHUB_TOKEN，跳过详情补充', count: 0 };
  if (DETAIL_LIMIT === 0) return { enabled: false, reason: 'DETAIL_LIMIT 为 0', count: 0 };

  const targets = [];
  const seen = new Set();
  for (const board of snapshot.boards) {
    const win = board.windows.daily;
    if (!win || win.status !== 'ok') continue;
    for (const item of win.items) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(item);
    }
  }

  const pool = targets.slice(0, DETAIL_LIMIT);
  let rateLimited = false;

  await mapLimit(pool, 4, async (item) => {
    if (rateLimited) return;
    try {
      const repo = await githubJson(`/repos/${item.owner}/${item.name}`, token);
      item.details = {
        topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
        license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION'
          ? repo.license.spdx_id
          : repo.license?.name || null,
        homepage: repo.homepage || null,
        archived: Boolean(repo.archived),
        release: null,
      };
    } catch (error) {
      if (error.fatal) rateLimited = true;
      if (error.status === 404) {
        item.details = {
          missing: true,
          topics: [],
          license: null,
          homepage: null,
          archived: false,
          release: null,
        };
      }
    }
  });

  // 只为总榜前 N 名补充 Release，控制 API 用量
  const allDaily = snapshot.boards.find((board) => board.id === 'all')?.windows.daily;
  const releaseTargets = (allDaily?.items || []).slice(0, RELEASE_LIMIT);
  await mapLimit(releaseTargets, 3, async (item) => {
    if (rateLimited || !item.details || item.details.missing) return;
    try {
      const release = await githubJson(`/repos/${item.owner}/${item.name}/releases/latest`, token);
      item.details.release = {
        tag: release.tag_name || release.name || null,
        publishedAt: release.published_at || null,
        url: release.html_url || null,
      };
    } catch (error) {
      if (error.fatal) rateLimited = true;
    }
  });

  // 同一仓库可能出现在多个榜单/时间窗，复用详情
  const byKey = new Map();
  for (const item of targets) {
    if (item.details) byKey.set(itemKey(item), item.details);
  }
  for (const board of snapshot.boards) {
    for (const window of WINDOWS) {
      const win = board.windows[window.id];
      if (!win || win.status !== 'ok') continue;
      for (const item of win.items) {
        const details = byKey.get(itemKey(item));
        if (details) item.details = details;
      }
    }
  }

  return {
    enabled: true,
    count: byKey.size,
    rateLimited,
    requested: pool.length,
  };
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderFeed(snapshot, siteUrl) {
  const all = snapshot.boards?.find((board) => board.id === 'all');
  const daily = all?.windows?.daily;
  if (!snapshot || snapshot.sample || !daily || daily.status !== 'ok' || !daily.items?.length) {
    return null;
  }

  const site = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const items = daily.items
    .map((item) => {
      const extras = [];
      if (item.language) extras.push(`语言：${item.language}`);
      if (item.growth != null) extras.push(`今日新增 Star：${item.growth}`);
      const description = [item.description || '暂无项目简介', extras.join('；')]
        .filter(Boolean)
        .join(' — ');

      return [
        '    <item>',
        `      <title>${xmlEscape(item.fullName)}</title>`,
        `      <link>${xmlEscape(item.url)}</link>`,
        `      <guid isPermaLink="false">github-trending:${xmlEscape(snapshot.date)}:${xmlEscape(item.fullName)}</guid>`,
        `      <description>${xmlEscape(description)}</description>`,
        `      <pubDate>${new Date(snapshot.generatedAt).toUTCString()}</pubDate>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>GitHub 热榜 · 每日开源趋势日报</title>',
    `    <link>${xmlEscape(site)}</link>`,
    `    <atom:link href="${xmlEscape(site)}feed.xml" rel="self" type="application/rss+xml"/>`,
    '    <description>每天自动更新的 GitHub Trending 总榜，含排名、语言与新增 Star。</description>',
    '    <language>zh-CN</language>',
    `    <lastBuildDate>${new Date(snapshot.generatedAt).toUTCString()}</lastBuildDate>`,
    `    <pubDate>${new Date(snapshot.generatedAt).toUTCString()}</pubDate>`,
    `    <generator>github-trending-daily ${SCHEMA_VERSION}</generator>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function historyEntry(snapshot) {
  return {
    schemaVersion: SCHEMA_VERSION,
    date: snapshot.date,
    generatedAt: snapshot.generatedAt,
    sample: Boolean(snapshot.sample),
    cycleHours: snapshot.cycleHours,
    boards: snapshot.boards.map((board) => ({
      id: board.id,
      label: board.label,
      windows: Object.fromEntries(
        WINDOWS.map((window) => {
          const win = board.windows[window.id];
          if (!win) return [window.id, null];
          return [
            window.id,
            {
              status: win.status,
              source: win.source || null,
              generatedAt: win.generatedAt || snapshot.generatedAt,
              items: (win.items || []).map((item) => ({
                rank: item.rank,
                fullName: item.fullName,
                stars: item.stars ?? null,
                growth: item.growth ?? null,
                language: item.language ?? null,
              })),
            },
          ];
        }),
      ),
    })),
  };
}

async function cleanupHistory(today) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);

  const names = await readdir(HISTORY_DIR).catch(() => []);
  const kept = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const date = name.slice(0, 10);
    if (new Date(`${date}T00:00:00Z`) < cutoff) {
      await unlink(join(HISTORY_DIR, name)).catch(() => {});
    } else {
      kept.push(date);
    }
  }
  kept.sort((a, b) => (a < b ? 1 : -1));
  return kept;
}

async function writeOutputs(snapshot, feed, writes, warnings = []) {
  await mkdir(HISTORY_DIR, { recursive: true });

  await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await writeFile(
    join(DATA_DIR, 'trending.js'),
    `window.__TRENDING_DATA__ = ${JSON.stringify(snapshot)};\n`,
    'utf8',
  );
  writes.push('data/trending.json', 'data/trending.js');

  if (!snapshot.sample) {
    await writeFile(
      join(HISTORY_DIR, `${snapshot.date}.json`),
      `${JSON.stringify(historyEntry(snapshot), null, 2)}\n`,
      'utf8',
    );
    writes.push(`data/history/${snapshot.date}.json`);

    if (feed) {
      try {
        await writeFile(FEED_FILE, feed, 'utf8');
        writes.push('feed.xml');
      } catch (error) {
        // RSS 失败不得阻塞页面数据发布，但要在运行摘要与告警中体现
        warnings.push(`RSS 写入失败：${error.message}`);
      }
    }
  }

  const dates = await cleanupHistory(snapshot.date);
  const unique = Array.from(new Set(dates)).sort((a, b) => (a < b ? 1 : -1));
  await writeFile(
    HISTORY_INDEX_FILE,
    `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        retentionDays: RETENTION_DAYS,
        dates: unique,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writes.push('data/history/index.json');
}

function buildSummary(report) {
  const lines = [
    '## GitHub 热榜数据运行摘要',
    '',
    `- 运行时间：${report.generatedAt}（UTC）`,
    `- 快照日期：${report.date} · 结构版本 v${report.schemaVersion}`,
    `- 更新时间窗：${report.windows.join('、')}`,
    `- 榜单范围：${report.boards.join('、')}`,
    `- 模式：${report.dryRun ? '仅校验（不发布）' : '发布'}`,
    `- 结果：${report.fatal ? '失败' : report.degraded ? '部分可用' : '正常'}`,
    `- 耗时：${(report.durationMs / 1000).toFixed(1)} 秒`,
    '',
    '| 榜单 | 时间窗 | 状态 | 条目 | 来源 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.results.map(
      (row) =>
        `| ${row.board} | ${row.window} | ${row.status} | ${row.count} | ${row.source || '-'} | ${
          row.reason || '-'
        } |`,
    ),
    '',
  ];

  if (report.details) {
    lines.push(
      `- 详情补充：${
        report.details.enabled
          ? `${report.details.count} 个仓库${report.details.rateLimited ? '（触发限流，已提前停止）' : ''}`
          : `未启用（${report.details.reason}）`
      }`,
      '',
    );
  }
  if (report.failures.length) {
    lines.push('### 失败与降级', '', ...report.failures.map((f) => `- ${f}`), '');
  }
  if (report.warnings?.length) {
    lines.push('### 警告', '', ...report.warnings.map((w) => `- ${w}`), '');
  }

  return lines.join('\n');
}

async function appendStepSummary(text) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`, 'utf8').catch(() => {});
}

function parseArgs(argv) {
  const options = {
    windows: WINDOWS.map((window) => window.id),
    boards: BOARDS.map((board) => board.id),
    dryRun: false,
    migrateLegacy: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' || arg === '--check') options.dryRun = true;
    else if (arg === '--migrate-legacy') options.migrateLegacy = true;
    else if (arg.startsWith('--windows=')) {
      const value = arg.slice('--windows='.length);
      const ids = value === 'all' ? WINDOWS.map((w) => w.id) : value.split(',').map((s) => s.trim());
      options.windows = WINDOWS.filter((window) => ids.includes(window.id)).map((w) => w.id);
      if (!options.windows.length) throw new Error(`未知的时间窗：${value}`);
    } else if (arg.startsWith('--boards=')) {
      const value = arg.slice('--boards='.length);
      const ids = value === '*' ? BOARDS.map((b) => b.id) : value.split(',').map((s) => s.trim());
      options.boards = BOARDS.filter((board) => ids.includes(board.id)).map((b) => b.id);
      if (!options.boards.length) throw new Error(`未知的榜单：${value}`);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/fetch-trending.mjs [--windows=all|daily,weekly,monthly] [--boards=*|all,python,go] [--dry-run] [--migrate-legacy]\n' +
          '  --boards=*    抓取全部榜单（默认）\n' +
          '  --boards=all  只抓取总榜',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* 旧数据迁移                                                          */
/* ------------------------------------------------------------------ */

async function migrateLegacy() {
  const legacy = await readJsonIfExists(SNAPSHOT_FILE);
  if (!legacy || legacy.schemaVersion >= SCHEMA_VERSION) {
    throw new Error('未找到旧版数据，或数据已是新结构，无需迁移');
  }

  const date = shanghaiDate(new Date(legacy.generatedAt || Date.now()));
  const generatedAt = legacy.generatedAt || new Date().toISOString();
  const boards = BOARDS.map((board) => {
    const source = legacy.boards?.find((entry) => entry.id === board.id);
    const items = (source?.items || []).map((item) => ({
      rank: item.rank,
      fullName: item.fullName,
      owner: item.owner,
      name: item.name,
      url: item.url,
      description: item.description ?? null,
      language: item.language ?? null,
      languageColor: item.languageColor ?? null,
      stars: item.stars ?? null,
      forks: item.forks ?? null,
      growth: item.growth ?? item.starsToday ?? null,
      details: null,
      trend: null,
    }));
    const windows = Object.fromEntries(
      WINDOWS.map((window) => [
        window.id,
        window.id === 'daily' && items.length
          ? { status: 'ok', source: source.source || 'html', generatedAt, items }
          : { status: 'empty', source: null, generatedAt, items: [], error: null },
      ]),
    );
    return {
      id: board.id,
      label: board.label,
      url: `https://github.com${board.path}?since=daily`,
      windows,
    };
  });

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    sample: false,
    generatedAt,
    lastSuccessAt: generatedAt,
    date,
    cycleHours: CYCLE_HOURS,
    source: 'https://github.com/trending',
    migratedFrom: 'legacy-v1',
    boards,
    partial: [],
  };

  const writes = [];
  const warnings = [];
  await writeOutputs(snapshot, renderFeed(snapshot, siteUrl()), writes, warnings);
  console.log(`[migrate] 已把旧数据迁移为快照结构，日期 ${date}`);
  if (warnings.length) console.warn(`[warn] ${warnings.join('；')}`);
  console.log(`[migrate] 写入：${writes.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo) {
    const [owner, name] = repo.split('/');
    return `https://${owner.toLowerCase()}.github.io/${name.toLowerCase()}/`;
  }
  return 'http://localhost:8765/';
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.migrateLegacy) {
    await migrateLegacy();
    return;
  }

  const startedAt = Date.now();
  const token = process.env.GITHUB_TOKEN || '';
  const today = shanghaiDate();
  const history = await loadHistory();
  const baselineHistory = history.filter((entry) => entry.date < today);
  const latestHistory = history[0] || null;

  const selectedWindows = WINDOWS.filter((window) => options.windows.includes(window.id));
  const selectedBoards = BOARDS.filter((board) => options.boards.includes(board.id));

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    sample: false,
    generatedAt: new Date().toISOString(),
    lastSuccessAt: null,
    date: today,
    cycleHours: CYCLE_HOURS,
    source: 'https://github.com/trending',
    boards: [],
    partial: [],
  };

  const results = [];
  const failures = [];

  for (const board of BOARDS) {
    const windows = {};
    for (const window of WINDOWS) {
      const selected = selectedBoards.includes(board) && selectedWindows.includes(window);
      let result;

      if (!selected) {
        const previous = windowOf(latestHistory?.snapshot, board.id, window.id);
        const items = (previous?.items || []).map((item) => ({ ...item, trend: null }));
        result = {
          status: items.length ? previous.status || 'ok' : 'empty',
          source: previous?.source || null,
          items,
          error: null,
          generatedAt: previous?.generatedAt || snapshot.generatedAt,
          preserved: true,
        };
      } else {
        try {
          const fetched = await fetchBoardWindow(board, window, token);
          result = { ...fetched, generatedAt: snapshot.generatedAt };
          console.log(
            `[ok] ${board.label} · ${window.label}：${result.items.length} 个项目（${result.source}）`,
          );
        } catch (error) {
          const previous = windowOf(latestHistory?.snapshot, board.id, window.id);
          const carriedItems = (previous?.items || []).map((item) => ({ ...item, trend: null }));
          result = {
            status: carriedItems.length ? 'carried' : 'empty',
            source: previous?.source || null,
            items: carriedItems,
            error: error.message,
            generatedAt: previous?.generatedAt || null,
            carriedFrom: carriedItems.length ? previous?.generatedAt || latestHistory?.generatedAt : null,
          };
          console.error(`[error] ${board.label} · ${window.label}：${error.message}`);
        }
      }

      windows[window.id] = result;
      if (selected || result.items.length) {
        results.push({
          board: board.label,
          boardId: board.id,
          window: window.label,
          windowId: window.id,
          status: result.status,
          source: result.source,
          count: result.items.length,
          reason:
            result.error ||
            (!selected && result.items.length ? '本次未更新，沿用最近快照' : null),
        });
      }
      if (selected && result.error) {
        failures.push(`${board.label} · ${window.label}：${result.error}`);
      }
      if (result.status === 'carried') {
        snapshot.partial.push({
          board: board.id,
          boardLabel: board.label,
          window: window.id,
          windowLabel: window.label,
          reason: result.error || '本次更新失败',
          carriedFrom: result.carriedFrom,
        });
      }

      if (selected) await sleep(FETCH_DELAY);
    }

    snapshot.boards.push({
      id: board.id,
      label: board.label,
      url: `https://github.com${board.path}?since=daily`,
      windows,
    });
  }

  const usable = snapshot.boards.some((board) =>
    WINDOWS.some((window) => (board.windows[window.id]?.items?.length || 0) > 0),
  );

  if (!usable) {
    const report = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: snapshot.generatedAt,
      date: today,
      dryRun: options.dryRun,
      fatal: true,
      degraded: true,
      durationMs: Date.now() - startedAt,
      windows: selectedWindows.map((w) => w.label),
      boards: selectedBoards.map((b) => b.label),
      results,
      failures,
      writes: [],
    };
    await appendStepSummary(buildSummary(report));
    if (!options.dryRun) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(RUN_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    console.error('[fatal] 没有任何可发布的榜单数据，保留上一次快照');
    process.exitCode = 1;
    return;
  }

  applyTrends(snapshot, baselineHistory);

  // 新鲜度以“最近一次成功更新”为准，失败继承的旧数据不能把快照伪装成新的
  const successTimes = [];
  const carriedTimes = [];
  for (const board of snapshot.boards) {
    for (const window of WINDOWS) {
      const win = board.windows[window.id];
      if (!win) continue;
      if (win.status === 'ok' && win.generatedAt) successTimes.push(win.generatedAt);
      if (win.status === 'carried' && win.carriedFrom) carriedTimes.push(win.carriedFrom);
    }
  }
  const pickLatest = (list) =>
    list.length
      ? list.reduce((latest, value) => (new Date(value) > new Date(latest) ? value : latest))
      : null;
  snapshot.lastSuccessAt = pickLatest(successTimes) || pickLatest(carriedTimes) || null;

  const details = options.dryRun
    ? { enabled: false, reason: '仅校验模式不补充详情', count: 0 }
    : await enrichDetails(snapshot, token);
  if (details.enabled) {
    console.log(
      `[ok] 详情补充：${details.count} 个仓库${details.rateLimited ? '（触发限流，已提前停止）' : ''}`,
    );
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: snapshot.generatedAt,
    date: today,
    dryRun: options.dryRun,
    fatal: false,
    degraded: snapshot.partial.length > 0 || failures.length > 0,
    durationMs: Date.now() - startedAt,
    windows: selectedWindows.map((w) => w.label),
    boards: selectedBoards.map((b) => b.label),
    details,
    results,
    failures,
    writes: [],
  };

  const summary = buildSummary(report);
  if (options.dryRun) {
    await appendStepSummary(summary);
    console.log(summary);
    console.log('[done] 仅校验模式，未写入任何文件');
    return;
  }

  const warnings = [];
  let feed = null;
  try {
    feed = renderFeed(snapshot, siteUrl());
  } catch (error) {
    warnings.push(`RSS 生成失败：${error.message}`);
  }
  report.warnings = warnings;

  await writeOutputs(snapshot, feed, report.writes, warnings);
  report.degraded = report.degraded || warnings.length > 0;
  report.writes.push('data/run-report.json');
  await writeFile(RUN_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const finalSummary = buildSummary(report);
  await appendStepSummary(finalSummary);
  console.log(finalSummary);

  const total = snapshot.boards.reduce(
    (sum, board) =>
      sum +
      WINDOWS.reduce((inner, window) => inner + (board.windows[window.id]?.items?.length || 0), 0),
    0,
  );
  console.log(`[done] 已写入 ${snapshot.boards.length} 个榜单、${total} 条榜单条目`);
  if (snapshot.partial.length) {
    console.warn(`[warn] ${snapshot.partial.length} 个榜单时间窗沿用了上次数据，详见运行报告`);
  }
}

// 仅直接运行时执行抓取；被测试脚本 import 时不产生副作用
const isDirectRun = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[fatal] ${error.message}`);
    process.exitCode = 1;
  });
}
