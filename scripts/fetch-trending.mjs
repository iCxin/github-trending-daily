#!/usr/bin/env node
/**
 * 抓取 GitHub Trending 每日榜单。
 * 主数据源：https://github.com/trending（官方页面，含“今日新增 star”数据）
 * 兜底数据源：GitHub Search API（页面结构变化或抓取失败时启用）
 *
 * 输出：
 *   data/trending.json  供程序读取
 *   data/trending.js    供静态页面直接加载（支持 file:// 本地预览）
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const SINCE = 'daily';
const REQUEST_TIMEOUT = 25000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 github-trending-daily';

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
      cleanText(
        firstGroup(chunk, /href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i),
      ),
    );

  // fork：优先 forks 链接里的文本，其次 aria-label
  const forks =
    toRepoCount(
      cleanText(
        firstGroup(
          chunk,
          /href="\/[^"]+\/(?:forks|network\/members)"[^>]*>([\s\S]*?)<\/a>/i,
        ),
      ),
    ) ??
    toRepoCount(
      firstGroup(chunk, /aria-label="([\d,]+)\s+users\s+forked\s+this\s+repository"/i),
    );

  const starsToday = toCount(firstGroup(chunk, /([\d,]+)\s*stars?\s+today/i));

  const languageTag = chunk.match(
    /<span[^>]*class="[^"]*repo-language-color[^"]*"[^>]*>/i,
  );
  const languageColor = languageTag
    ? (firstGroup(languageTag[0], /background-color:\s*([^;"']+)/i) || '').trim() || null
    : null;
  const language =
    cleanText(
      firstGroup(chunk, /itemprop="programmingLanguage"[^>]*>([^<]+)</i),
    ) ||
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
    starsToday,
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

async function fetchHtml(path) {
  const url = `https://github.com${path}?since=${SINCE}`;
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

async function fetchHtmlWithRetry(path) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchHtml(path);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1500);
    }
  }
  throw lastError;
}

async function fetchFromApi(board, token) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
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
    starsToday: null,
  }));
}

async function fetchBoard(board, token) {
  let items = [];
  let source = 'html';

  try {
    const html = await fetchHtmlWithRetry(board.path);
    items = parseTrendingHtml(html, board);
    if (items.length === 0) throw new Error('页面解析结果为空，可能页面结构已变化');
  } catch (error) {
    console.warn(`[warn] ${board.label} 页面抓取失败：${error.message}，改用 GitHub API`);
    items = await fetchFromApi(board, token);
    source = 'api';
  }

  if (items.length === 0) throw new Error('未获取到任何项目');

  return {
    id: board.id,
    label: board.label,
    url: `https://github.com${board.path}?since=${SINCE}`,
    source,
    items,
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN || '';
  const boards = [];

  for (const board of BOARDS) {
    try {
      boards.push(await fetchBoard(board, token));
      console.log(`[ok] ${board.label}：${boards.at(-1).items.length} 个项目`);
    } catch (error) {
      console.error(`[error] ${board.label} 抓取失败：${error.message}`);
    }
    await sleep(700);
  }

  if (!boards.some((board) => board.id === 'all')) {
    throw new Error('总榜抓取失败，保留上一次数据，不写入文件');
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    since: SINCE,
    source: 'https://github.com/trending',
    boards,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    join(DATA_DIR, 'trending.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(DATA_DIR, 'trending.js'),
    `window.__TRENDING_DATA__ = ${JSON.stringify(payload)};\n`,
    'utf8',
  );

  const total = boards.reduce((sum, board) => sum + board.items.length, 0);
  console.log(`[done] 已写入 ${boards.length} 个榜单、${total} 个项目`);
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
