(function () {
  'use strict';

  const DEFAULTS = {
    board: 'all',
    since: 'daily',
    q: '',
    sort: 'rank',
    trend: 'all',
    lang: '',
  };

  const SINCE_META = {
    daily: { label: '今日', growth: '今日新增' },
    weekly: { label: '本周', growth: '本周新增' },
    monthly: { label: '本月', growth: '本月新增' },
  };

  const SORTS = ['rank', 'growth', 'stars'];
  const TRENDS = ['all', 'new', 'up', 'streak'];

  const LANGUAGE_COLORS = {
    Python: '#3572A5',
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Go: '#00ADD8',
    Rust: '#dea584',
    Java: '#b07219',
    C: '#555555',
    'C++': '#f34b7d',
    'C#': '#178600',
    HTML: '#e34c26',
    CSS: '#563d7c',
    Shell: '#89e051',
    Swift: '#F05138',
    Kotlin: '#A97BFF',
    Ruby: '#701516',
    PHP: '#4F5D95',
    Zig: '#ec915c',
  };

  const ICONS = {
    star:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>' +
      '</svg>',
    fork:
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path fill="currentColor" d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.17 2.17 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.17 2.17 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/>' +
      '</svg>',
  };

  const els = {
    tabs: document.getElementById('tabs'),
    sinceSeg: document.getElementById('sinceSeg'),
    search: document.getElementById('search'),
    clearSearch: document.getElementById('clearSearch'),
    sort: document.getElementById('sort'),
    shareBtn: document.getElementById('shareBtn'),
    sharePanel: document.getElementById('sharePanel'),
    shareUrl: document.getElementById('shareUrl'),
    copyShare: document.getElementById('copyShare'),
    closeShare: document.getElementById('closeShare'),
    trendChips: document.getElementById('trendChips'),
    langWrap: document.getElementById('langWrap'),
    langFilter: document.getElementById('langFilter'),
    resultCount: document.getElementById('resultCount'),
    notice: document.getElementById('notice'),
    updateText: document.getElementById('updateText'),
    badgeDot: document.getElementById('badgeDot'),
    reloadBtn: document.getElementById('reloadBtn'),
    boardPanel: document.getElementById('boardPanel'),
    boardTitle: document.getElementById('boardTitle'),
    boardMeta: document.getElementById('boardMeta'),
    boardFlag: document.getElementById('boardFlag'),
    boardBanner: document.getElementById('boardBanner'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyText: document.getElementById('emptyText'),
    resetFilters: document.getElementById('resetFilters'),
    toast: document.getElementById('toast'),
    controls: document.querySelector('.controls'),
  };

  let data = normalizeData(window.__TRENDING_DATA__);
  let state = { ...DEFAULTS };
  let openKey = null;
  let searchTimer = null;
  let composing = false;
  let toastTimer = null;

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  function normalizeData(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.schemaVersion) < 2 || !Array.isArray(raw.boards)) return null;

    const boards = raw.boards
      .filter((board) => board && board.id && board.windows && typeof board.windows === 'object')
      .map((board) => ({
        ...board,
        label: String(board.label || board.id),
        windows: Object.fromEntries(
          Object.entries(board.windows).map(([key, win]) => [
            key,
            win && typeof win === 'object'
              ? {
                  ...win,
                  items: Array.isArray(win.items) ? win.items : [],
                }
              : { status: 'empty', items: [] },
          ]),
        ),
      }));

    if (!boards.length) return null;

    if (raw.sample) {
      for (const board of boards) {
        for (const win of Object.values(board.windows)) {
          for (const item of win.items) item.trend = null;
        }
      }
    }

    return { ...raw, boards };
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return number.toLocaleString('en-US');
  }

  function formatCompact(value) {
    if (value == null || value === '') return '';
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    if (number >= 10000) {
      const wan = number / 10000;
      const text = wan >= 100 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, '');
      return text + ' 万';
    }
    return formatNumber(number);
  }

  function formatDate(iso) {
    const timestamp = new Date(iso);
    if (Number.isNaN(timestamp.getTime())) return '未知时间';
    const text = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(timestamp);
    return text.replace(/\//g, '-') + '（北京时间）';
  }

  function formatShortDate(iso) {
    const timestamp = new Date(iso);
    if (Number.isNaN(timestamp.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(timestamp)
      .replace(/\//g, '-');
  }

  function relativeTime(iso) {
    const timestamp = new Date(iso).getTime();
    if (!Number.isFinite(timestamp)) return '时间未知';
    const diff = timestamp - Date.now();
    const abs = Math.abs(diff);
    if (abs < 60 * 1000) return '刚刚';
    const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (abs < 60 * 60 * 1000) return rtf.format(Math.round(diff / 60000), 'minute');
    if (abs < 24 * 60 * 60 * 1000) return rtf.format(Math.round(diff / 3600000), 'hour');
    return rtf.format(Math.round(diff / 86400000), 'day');
  }

  function sanitizeId(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function resolveColor(item) {
    if (item.languageColor && /^#[0-9a-f]{3,8}$/i.test(item.languageColor)) {
      return item.languageColor;
    }
    return LANGUAGE_COLORS[item.language] || '#8b949e';
  }

  function safeUrl(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (/^https?:\/\//i.test(text)) return text;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(text)) return 'https://' + text;
    return null;
  }

  function itemKey(item) {
    return String(item.fullName || '').toLowerCase();
  }

  function getBoard(id) {
    return data.boards.find((board) => board.id === id) || null;
  }

  function getWindow(board, since) {
    if (!board) return null;
    const win = board.windows[since];
    if (win && typeof win === 'object') {
      return { ...win, items: Array.isArray(win.items) ? win.items : [] };
    }
    return { status: 'empty', source: null, items: [], generatedAt: null, error: null };
  }

  function windowLabel(since) {
    return SINCE_META[since]?.label || '今日';
  }

  /* ------------------------------------------------------------------ */
  /* URL 状态                                                            */
  /* ------------------------------------------------------------------ */

  function readStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const boardId = params.get('board');
    const since = params.get('since');
    const sort = params.get('sort');
    const trend = params.get('trend');
    const lang = params.get('lang');

    return {
      board: getBoard(boardId) ? boardId : DEFAULTS.board,
      since: SINCE_META[since] ? since : DEFAULTS.since,
      q: (params.get('q') || '').slice(0, 80),
      sort: SORTS.includes(sort) ? sort : DEFAULTS.sort,
      trend: TRENDS.includes(trend) ? trend : DEFAULTS.trend,
      lang: lang && (!boardId || boardId === DEFAULTS.board) ? lang.slice(0, 60) : '',
    };
  }

  function buildQuery(next = state) {
    const params = new URLSearchParams();
    if (next.board !== DEFAULTS.board) params.set('board', next.board);
    if (next.since !== DEFAULTS.since) params.set('since', next.since);
    const q = next.q.trim().slice(0, 80);
    if (q) params.set('q', q);
    if (next.sort !== DEFAULTS.sort) params.set('sort', next.sort);
    if (next.trend !== DEFAULTS.trend) params.set('trend', next.trend);
    if (next.lang && next.board === 'all') params.set('lang', next.lang);
    return params.toString();
  }

  function syncUrl(mode) {
    const query = buildQuery();
    const url = window.location.pathname + (query ? '?' + query : '');
    try {
      if (mode === 'push') window.history.pushState({}, '', url);
      else window.history.replaceState({}, '', url);
    } catch {
      // file:// 或受限环境不支持 History API 时忽略，页面仍可正常使用
    }
  }

  function currentUrl() {
    const query = buildQuery();
    const url = new URL(window.location.href);
    url.search = query ? '?' + query : '';
    url.hash = '';
    return url.href;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：静态控件                                                      */
  /* ------------------------------------------------------------------ */

  function renderTabs() {
    els.tabs.innerHTML = data.boards
      .map(
        (board) =>
          '<button class="tab" type="button" role="tab" id="tab-' +
          esc(board.id) +
          '" data-board="' +
          esc(board.id) +
          '" aria-controls="boardPanel" aria-selected="false" tabindex="-1">' +
          esc(board.label) +
          '</button>',
      )
      .join('');
  }

  function renderSinceSeg() {
    els.sinceSeg.innerHTML = Object.entries(SINCE_META)
      .map(
        ([id, meta]) =>
          '<button type="button" data-since="' +
          esc(id) +
          '" aria-pressed="false">' +
          esc(meta.label) +
          '</button>',
      )
      .join('');
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：列表与详情                                                    */
  /* ------------------------------------------------------------------ */

  function badgesHTML(item) {
    const trend = item.trend;
    if (!trend || trend.type === null) return '';
    const parts = [];

    if (trend.type === 'new') {
      parts.push('<span class="badge new">新上榜</span>');
    } else if (trend.type === 'up' && trend.delta > 0) {
      parts.push('<span class="badge up">↑' + trend.delta + '</span>');
    } else if (trend.type === 'down' && trend.delta > 0) {
      parts.push('<span class="badge down">↓' + trend.delta + '</span>');
    }

    if (trend.type !== 'new' && Number(trend.streak) >= 3) {
      parts.push('<span class="badge streak">连续 ' + Number(trend.streak) + ' 天</span>');
    }

    return parts.length ? '<span class="badges">' + parts.join('') + '</span>' : '';
  }

  function detailHTML(item) {
    const key = itemKey(item);
    const id = 'detail-' + sanitizeId(key);
    const details = item.details || {};
    const topics = Array.isArray(details.topics) ? details.topics.slice(0, 8) : [];
    const license = details.license ? String(details.license) : '未标注';
    const homepage = safeUrl(details.homepage);
    const release = details.release;
    const releaseText = release
      ? [release.tag, release.publishedAt ? formatShortDate(release.publishedAt) : null]
          .filter(Boolean)
          .join(' · ')
      : '暂无 Release 信息';
    const description = item.description
      ? esc(item.description)
      : '<span class="muted">暂无项目简介</span>';

    const fields = [
      '<div class="field wide"><span class="label">完整简介</span><p class="value">' +
        description +
        '</p></div>',
    ];

    if (topics.length) {
      fields.push(
        '<div class="field wide"><span class="label">主题 Topics</span><ul class="topics">' +
          topics.map((topic) => '<li>' + esc(topic) + '</li>').join('') +
          '</ul></div>',
      );
    }

    fields.push(
      '<div class="field"><span class="label">许可证</span><p class="value">' +
        esc(license) +
        '</p></div>',
      '<div class="field"><span class="label">最新 Release</span><p class="value">' +
        esc(releaseText) +
        '</p></div>',
    );

    if (homepage) {
      fields.push(
        '<div class="field wide"><span class="label">项目主页</span><p class="value"><a href="' +
          esc(homepage) +
          '" target="_blank" rel="noopener noreferrer">' +
          esc(homepage.replace(/^https?:\/\//i, '')) +
          '</a></p></div>',
      );
    }

    const archived = details.archived
      ? '<p class="notice-line">该仓库已归档，仍可浏览但不再维护。</p>'
      : '';
    const missing = details.missing
      ? '<p class="notice-line">该仓库可能已迁移或删除，GitHub 链接仍保留。</p>'
      : '';

    return (
      '<div class="detail" id="' +
      esc(id) +
      '" role="region" aria-label="' +
      esc(item.fullName) +
      ' 详情">' +
      '<div class="detail-inner">' +
      '<div class="detail-grid">' +
      fields.join('') +
      '</div>' +
      archived +
      missing +
      '<div class="detail-actions">' +
      '<a class="action-btn primary" href="' +
      esc(item.url) +
      '" target="_blank" rel="noopener noreferrer">打开 GitHub</a>' +
      '<button class="action-btn" type="button" data-copy="' +
      esc(item.url) +
      '">复制仓库链接</button>' +
      '<button class="action-btn" type="button" data-share-repo="' +
      esc(item.url) +
      '" data-share-title="' +
      esc(item.fullName) +
      '">分享</button>' +
      '</div></div></div>'
    );
  }

  function rowHTML(item, index) {
    const key = itemKey(item);
    const rank = Number(item.rank) || index + 1;
    const expanded = openKey === key;
    const detailId = 'detail-' + sanitizeId(key);
    const language = item.language || null;
    const growth = item.growth;
    const meta = [];

    meta.push(
      '<span class="meta-item"><i class="lang-dot" style="background:' +
        esc(resolveColor(item)) +
        '"></i>' +
        esc(language || '未知语言') +
        '</span>',
    );

    if (growth != null && growth !== '') {
      meta.push(
        '<span class="today" title="' +
          esc((SINCE_META[state.since]?.growth || '新增') + ' Star：' + formatNumber(growth)) +
          '">' +
          esc(SINCE_META[state.since]?.growth || '新增') +
          ' +' +
          esc(formatNumber(growth)) +
          '</span>',
      );
    }
    if (item.stars != null) {
      meta.push(
        '<span class="meta-item" title="Star 总数：' +
          esc(formatNumber(item.stars)) +
          '"><span class="meta-icon">' +
          ICONS.star +
          '</span>' +
          esc(formatCompact(item.stars)) +
          '</span>',
      );
    }
    if (item.forks != null) {
      meta.push(
        '<span class="meta-item" title="Fork 总数：' +
          esc(formatNumber(item.forks)) +
          '"><span class="meta-icon">' +
          ICONS.fork +
          '</span>' +
          esc(formatCompact(item.forks)) +
          '</span>',
      );
    }

    return (
      '<article class="repo' +
      (rank <= 3 ? ' top-' + rank : '') +
      '">' +
      '<span class="rank" aria-label="第 ' +
      rank +
      ' 名">' +
      String(rank).padStart(2, '0') +
      '</span>' +
      '<div class="repo-main">' +
      '<h3 class="repo-title"><a class="repo-link" href="' +
      esc(item.url) +
      '" target="_blank" rel="noopener noreferrer"><span class="repo-owner">' +
      esc(item.owner) +
      '</span><span class="repo-sep">/</span><span class="repo-name">' +
      esc(item.name) +
      '</span></a>' +
      badgesHTML(item) +
      '</h3>' +
      '<p class="repo-desc' +
      (item.description ? '' : ' is-empty') +
      '">' +
      esc(item.description || '暂无项目简介') +
      '</p>' +
      '<div class="repo-meta">' +
      meta.join('') +
      '</div></div>' +
      '<button class="detail-btn" type="button" data-detail="' +
      esc(key) +
      '" aria-expanded="' +
      String(expanded) +
      '" aria-controls="' +
      esc(detailId) +
      '">' +
      (expanded ? '收起' : '详情') +
      ' <span aria-hidden="true">' +
      (expanded ? '▴' : '▾') +
      '</span></button>' +
      '</article>' +
      (expanded ? detailHTML(item) : '')
    );
  }

  function trendCounts(items) {
    const counts = { all: items.length, new: 0, up: 0, streak: 0 };
    for (const item of items) {
      const trend = item.trend;
      if (!trend) continue;
      if (trend.type === 'new') counts.new += 1;
      else if (trend.type === 'up') counts.up += 1;
      if (trend.type !== 'new' && Number(trend.streak) >= 3) counts.streak += 1;
    }
    return counts;
  }

  function renderChips(items) {
    const counts = trendCounts(items);
    const labels = { all: '全部', new: '新上榜', up: '排名上升', streak: '连续在榜' };
    els.trendChips.innerHTML = TRENDS.map(
      (id) =>
        '<button class="chip" type="button" data-trend="' +
        id +
        '" aria-pressed="' +
        String(state.trend === id) +
        '" data-empty="' +
        String(counts[id] === 0 && id !== 'all') +
        '">' +
        labels[id] +
        '<span class="c">' +
        counts[id] +
        '</span></button>',
    ).join('');
  }

  function renderLangOptions(items, board) {
    if (board.id !== 'all') {
      els.langWrap.hidden = true;
      state.lang = '';
      return;
    }

    const counts = new Map();
    for (const item of items) {
      if (!item.language) continue;
      counts.set(item.language, (counts.get(item.language) || 0) + 1);
    }

    if (state.lang && !counts.has(state.lang)) {
      state.lang = '';
      syncUrl('replace');
    }

    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    els.langWrap.hidden = entries.length === 0;
    els.langFilter.innerHTML =
      '<option value="">全部语言</option>' +
      entries
        .map(
          ([language, count]) =>
            '<option value="' +
            esc(language) +
            '">' +
            esc(language) +
            '（' +
            count +
            '）</option>',
        )
        .join('');
    els.langFilter.value = state.lang;
  }

  function matchesQuery(item, query) {
    if (!query) return true;
    const topics = item.details?.topics || [];
    const haystack = [
      item.owner,
      item.name,
      item.description,
      item.language,
      ...topics,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  function filteredItems(items) {
    const query = state.q.trim().toLowerCase();
    let result = items.filter((item) => matchesQuery(item, query));

    if (state.trend === 'new') result = result.filter((item) => item.trend?.type === 'new');
    else if (state.trend === 'up') result = result.filter((item) => item.trend?.type === 'up');
    else if (state.trend === 'streak') {
      result = result.filter(
        (item) => item.trend && item.trend.type !== 'new' && Number(item.trend.streak) >= 3,
      );
    }

    const board = getBoard(state.board);
    if (board?.id === 'all' && state.lang) {
      result = result.filter((item) => item.language === state.lang);
    }

    return result.slice().sort((a, b) => {
      if (state.sort === 'growth') {
        const left = a.growth == null ? -1 : Number(a.growth);
        const right = b.growth == null ? -1 : Number(b.growth);
        const diff = right - left;
        if (diff) return diff;
      } else if (state.sort === 'stars') {
        const left = a.stars == null ? -1 : Number(a.stars);
        const right = b.stars == null ? -1 : Number(b.stars);
        const diff = right - left;
        if (diff) return diff;
      }
      return (Number(a.rank) || 0) - (Number(b.rank) || 0);
    });
  }

  function showEmpty(title, text, options = {}) {
    els.list.hidden = true;
    els.empty.hidden = false;
    els.emptyTitle.textContent = title;
    els.emptyText.textContent = text;
    els.resetFilters.dataset.action = options.reload ? 'reload' : 'reset';
    els.resetFilters.textContent = options.reload ? '重新加载' : '清除筛选';
    els.resetFilters.hidden = options.hideAction === true;
  }

  function updateBoardChrome(board, win, total) {
    const label = windowLabel(state.since);
    els.boardTitle.textContent =
      board.id === 'all' ? label + '热门总榜' : label + ' · ' + board.label + ' 热门';

    const meta = ['共 ' + total + ' 个项目'];
    if (!total) {
      meta.push('暂无可用快照 · 快照生成于 ' + formatDate(data.generatedAt));
    } else if (win.status === 'carried' && win.carriedFrom) {
      meta.push('沿用 ' + formatDate(win.carriedFrom) + ' 的数据');
    } else if (win.generatedAt) {
      meta.push('更新于 ' + formatDate(win.generatedAt));
    }
    if (win.source === 'api') meta.push('备用数据源');
    els.boardMeta.textContent = meta.join(' · ');

    const carried = win.status === 'carried';
    els.boardFlag.hidden = !carried && win.status !== 'empty';
    els.boardFlag.textContent = carried ? '沿用上次数据' : win.status === 'empty' ? '暂无数据' : '';

    if (carried) {
      const reason = win.error ? '原因：' + win.error : '原因：本次抓取或校验未通过';
      els.boardBanner.hidden = false;
      els.boardBanner.innerHTML =
        '<b>本榜本次更新失败。</b>' +
        esc(reason) +
        ' 当前展示 ' +
        esc(win.carriedFrom ? formatDate(win.carriedFrom) : '上一次') +
        ' 的数据。<button type="button" data-reload>重新加载</button>';
    } else if (win.source === 'api') {
      els.boardBanner.hidden = false;
      els.boardBanner.innerHTML =
        '<b>备用数据源：</b>本次页面抓取未通过校验，已使用 GitHub API 兜底；新增 Star 与排名趋势可能缺失。';
    } else {
      els.boardBanner.hidden = true;
      els.boardBanner.innerHTML = '';
    }

    els.boardPanel.setAttribute('aria-labelledby', 'tab-' + board.id);
    document.title = board.label + ' · ' + label + ' · GitHub 热榜';
  }

  function updateControls() {
    Array.from(els.tabs.children).forEach((button) => {
      const selected = button.dataset.board === state.board;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });

    Array.from(els.sinceSeg.querySelectorAll('[data-since]')).forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.since === state.since));
    });

    if (els.sort.value !== state.sort) els.sort.value = state.sort;
    if (els.search.value !== state.q) els.search.value = state.q;
    els.clearSearch.hidden = !els.search.value;
  }

  function revealActiveTab() {
    if (els.tabs.scrollWidth <= els.tabs.clientWidth + 1) return;
    const active = els.tabs.querySelector('.tab[aria-selected="true"]');
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < els.tabs.scrollLeft) {
      els.tabs.scrollLeft = Math.max(0, left - 8);
    } else if (right > els.tabs.scrollLeft + els.tabs.clientWidth) {
      els.tabs.scrollLeft = right - els.tabs.clientWidth + 8;
    }
  }

  function render() {
    const board = getBoard(state.board) || data.boards[0];
    if (!board) return renderFatal('没有可用的榜单数据。');
    if (state.board !== board.id) state.board = board.id;

    const win = getWindow(board, state.since);
    const total = win.items.length;

    updateBoardChrome(board, win, total);
    renderChips(win.items);
    renderLangOptions(win.items, board);
    updateControls();
    revealActiveTab();

    if (!total) {
      openKey = null;
      els.resultCount.textContent = '共 0 个项目';
      showEmpty(
        '本时间窗暂无数据',
        '本次更新没有获得「' +
          windowLabel(state.since) +
          ' · ' +
          board.label +
          '」的有效数据，下次更新会自动补齐。你也可以手动触发一次数据更新。',
        { reload: true },
      );
      return;
    }

    const items = filteredItems(win.items);
    if (openKey && !items.some((item) => itemKey(item) === openKey)) {
      openKey = null;
    }

    els.empty.hidden = true;
    els.list.hidden = false;

    const filtered = items.length !== total;
    els.resultCount.textContent = '共 ' + items.length + ' 个项目' + (filtered ? ' · 已筛选' : '');

    if (!items.length) {
      els.list.innerHTML = '';
      els.list.hidden = true;
      showEmpty(
        '没有符合条件的项目',
        '当前筛选条件下没有结果，可清除筛选后查看全部 ' + total + ' 个项目。',
      );
      return;
    }

    els.list.innerHTML = items.map(rowHTML).join('');
  }

  function renderFatal(message) {
    els.badgeDot.classList.add('is-error');
    els.updateText.textContent = '数据不可用';
    els.notice.hidden = true;
    if (els.controls) els.controls.hidden = true;
    els.boardTitle.textContent = '数据暂不可用';
    els.boardMeta.textContent = '未找到可用的榜单快照。';
    els.boardFlag.hidden = true;
    els.boardBanner.hidden = true;
    els.list.hidden = true;
    els.list.innerHTML = '';
    showEmpty(
      '暂无榜单数据',
      message ||
        '页面还没有可展示的快照。请先运行 node scripts/fetch-trending.mjs，或在 GitHub Actions 中手动触发更新工作流。',
      { hideAction: true },
    );
    document.title = '数据不可用 · GitHub 热榜';
  }

  /* ------------------------------------------------------------------ */
  /* 状态与横幅                                                          */
  /* ------------------------------------------------------------------ */

  function freshness() {
    if (!data) return 'unavailable';
    if (data.sample) return 'sample';
    const last = data.lastSuccessAt || data.generatedAt;
    if (!last) return 'unavailable';
    const cycle = (Number(data.cycleHours) || 24) * 3600 * 1000;
    const age = Date.now() - new Date(last).getTime();
    if (!Number.isFinite(age)) return 'unavailable';
    if (age <= cycle) return 'normal';
    if (age <= cycle * 2) return 'stale';
    return 'severe';
  }

  function renderNotice() {
    const status = freshness();
    const messages = [];
    let level = 'info';

    if (data.sample) {
      level = 'partial';
      messages.push(
        '<b>示例数据：</b>当前列表仅用于交互预览，不代表真实 GitHub 数据，也不会生成历史或 RSS。',
      );
    }

    const last = data.lastSuccessAt || data.generatedAt;
    if (status === 'stale') {
      level = 'partial';
      messages.push(
        '<b>数据已过期：</b>最近一次成功更新是 ' +
          esc(formatDate(last)) +
          '（' +
          esc(relativeTime(last)) +
          '），当前展示最近一次可用数据。',
      );
    } else if (status === 'severe') {
      level = 'severe';
      messages.push(
        '<b>数据严重过期：</b>最近一次成功更新是 ' +
          esc(formatDate(last)) +
          '（' +
          esc(relativeTime(last)) +
          '），请检查更新工作流或手动触发一次运行。',
      );
    }

    if (Array.isArray(data.partial) && data.partial.length) {
      if (level !== 'severe') level = 'partial';
      const names = data.partial
        .slice(0, 4)
        .map((entry) => (entry.boardLabel || entry.board) + ' · ' + (entry.windowLabel || entry.window));
      const more = data.partial.length > 4 ? ' 等 ' + data.partial.length + ' 个榜单时间窗' : '';
      messages.push(
        '<b>部分可用：</b>' +
          esc(names.join('、') + more) +
          ' 本次更新失败，已沿用上次数据；其它榜单不受影响。',
      );
    }

    if (!messages.length) {
      els.notice.hidden = true;
      els.notice.className = 'notice';
      els.notice.innerHTML = '';
      return;
    }

    els.notice.hidden = false;
    els.notice.className = 'notice is-' + level;
    els.notice.innerHTML = messages.join(' ');
  }

  const narrowQuery = window.matchMedia('(max-width: 640px)');

  function updateStatus() {
    if (!data) {
      renderFatal();
      return;
    }

    const status = freshness();
    const last = data.lastSuccessAt || data.generatedAt;
    const dot = els.badgeDot;
    const narrow = narrowQuery.matches;
    dot.className = 'badge-dot';

    if (status === 'sample') {
      dot.classList.add('is-sample');
      els.updateText.textContent = '示例数据 · 等待首次更新';
    } else if (status === 'normal') {
      els.updateText.textContent =
        '数据正常 · ' +
        (narrow ? relativeTime(last) : '更新于 ' + formatDate(last) + ' · ' + relativeTime(last));
    } else if (status === 'stale') {
      dot.classList.add('is-stale');
      els.updateText.textContent =
        '数据过期 · ' +
        (narrow ? relativeTime(last) : '最近成功 ' + formatDate(last) + ' · ' + relativeTime(last));
    } else if (status === 'severe') {
      dot.classList.add('is-severe');
      els.updateText.textContent =
        '严重过期 · ' +
        (narrow ? relativeTime(last) : '最近成功 ' + formatDate(last) + ' · ' + relativeTime(last));
    } else {
      dot.classList.add('is-error');
      els.updateText.textContent = '数据不可用';
    }

    updateBadgeTitle(last);
    renderNotice();
  }

  function updateBadgeTitle(last) {
    const badge = document.getElementById('updateBadge');
    if (!badge) return;
    badge.title =
      '最近成功更新：' +
      (last ? formatDate(last) : '未知') +
      '\n快照生成：' +
      (data?.generatedAt ? formatDate(data.generatedAt) : '未知') +
      '\n更新周期：' +
      (data?.cycleHours || 24) +
      ' 小时';
  }

  /* ------------------------------------------------------------------ */
  /* 交互                                                                */
  /* ------------------------------------------------------------------ */

  function setBoard(id) {
    if (id === state.board || !getBoard(id)) return;
    state.board = id;
    state.lang = '';
    openKey = null;
    syncUrl('push');
    render();
  }

  function setSince(id) {
    if (id === state.since || !SINCE_META[id]) return;
    state.since = id;
    openKey = null;
    syncUrl('push');
    render();
  }

  function applySearch(raw) {
    window.clearTimeout(searchTimer);
    state.q = String(raw || '').slice(0, 80);
    openKey = null;
    syncUrl('replace');
    render();
  }

  function scheduleSearch() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => applySearch(els.search.value), 300);
  }

  function resetFilters() {
    window.clearTimeout(searchTimer);
    els.search.value = '';
    state.q = '';
    state.trend = 'all';
    state.lang = '';
    state.sort = 'rank';
    openKey = null;
    syncUrl('replace');
    render();
    els.search.focus();
  }

  function toggleDetail(key) {
    openKey = openKey === key ? null : key;
    render();
    const buttons = Array.from(els.list.querySelectorAll('[data-detail]'));
    const target = buttons.find((button) => button.dataset.detail === key);
    if (target) target.focus();
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('copy-failed');
  }

  function openSharePanel(url) {
    els.sharePanel.hidden = false;
    els.shareUrl.value = url;
    els.shareUrl.focus();
    els.shareUrl.select();
  }

  function closeSharePanel() {
    els.sharePanel.hidden = true;
  }

  async function copyOrPanel(url, message) {
    try {
      await copyText(url);
      toast(message);
    } catch {
      openSharePanel(url);
      toast('无法自动复制，请手动复制链接');
    }
  }

  async function shareView() {
    const url = currentUrl();
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    await copyOrPanel(url, '视图链接已复制');
  }

  async function shareRepo(url, title) {
    if (navigator.share) {
      try {
        await navigator.share({ title: title || 'GitHub 仓库', url });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    await copyOrPanel(url, '仓库链接已复制');
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target.isContentEditable === true
    );
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-board]');
    if (button) setBoard(button.dataset.board);
  });

  els.tabs.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(els.tabs.querySelectorAll('[data-board]'));
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    setBoard(buttons[next].dataset.board);
    buttons[next].focus();
  });

  els.sinceSeg.addEventListener('click', (event) => {
    const button = event.target.closest('[data-since]');
    if (button) setSince(button.dataset.since);
  });

  els.sinceSeg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = Array.from(els.sinceSeg.querySelectorAll('[data-since]'));
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % buttons.length
        : (index - 1 + buttons.length) % buttons.length;
    setSince(buttons[next].dataset.since);
    buttons[next].focus();
  });

  els.search.addEventListener('compositionstart', () => {
    composing = true;
  });

  els.search.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch();
  });

  els.search.addEventListener('input', () => {
    els.clearSearch.hidden = !els.search.value;
    if (composing) return;
    scheduleSearch();
  });

  els.clearSearch.addEventListener('click', () => {
    applySearch('');
    els.search.focus();
  });

  els.sort.addEventListener('change', () => {
    state.sort = SORTS.includes(els.sort.value) ? els.sort.value : DEFAULTS.sort;
    openKey = null;
    syncUrl('replace');
    render();
  });

  els.trendChips.addEventListener('click', (event) => {
    const button = event.target.closest('[data-trend]');
    if (!button || !TRENDS.includes(button.dataset.trend)) return;
    state.trend = button.dataset.trend;
    openKey = null;
    syncUrl('replace');
    render();
    const next = els.trendChips.querySelector('[data-trend="' + state.trend + '"]');
    if (next) next.focus();
  });

  els.langFilter.addEventListener('change', () => {
    state.lang = els.langFilter.value;
    openKey = null;
    syncUrl('replace');
    render();
  });

  els.list.addEventListener('click', (event) => {
    const detailButton = event.target.closest('[data-detail]');
    if (detailButton) {
      event.preventDefault();
      toggleDetail(detailButton.dataset.detail);
      return;
    }

    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      event.preventDefault();
      copyOrPanel(copyButton.dataset.copy, '仓库链接已复制');
      return;
    }

    const shareButton = event.target.closest('[data-share-repo]');
    if (shareButton) {
      event.preventDefault();
      shareRepo(shareButton.dataset.shareRepo, shareButton.dataset.shareTitle);
    }
  });

  els.boardBanner.addEventListener('click', (event) => {
    if (event.target.closest('[data-reload]')) window.location.reload();
  });

  els.resetFilters.addEventListener('click', () => {
    if (els.resetFilters.dataset.action === 'reload') window.location.reload();
    else resetFilters();
  });

  els.shareBtn.addEventListener('click', shareView);

  els.copyShare.addEventListener('click', async () => {
    try {
      await copyText(els.shareUrl.value);
      toast('链接已复制');
    } catch {
      els.shareUrl.focus();
      els.shareUrl.select();
      toast('请按 Ctrl/Cmd+C 复制');
    }
  });

  els.closeShare.addEventListener('click', closeSharePanel);
  els.reloadBtn.addEventListener('click', () => window.location.reload());

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      els.search.focus();
      return;
    }

    if (event.key !== 'Escape') return;

    if (!els.sharePanel.hidden) {
      closeSharePanel();
      els.shareBtn.focus();
      return;
    }

    if (openKey) {
      const key = openKey;
      openKey = null;
      render();
      const buttons = Array.from(els.list.querySelectorAll('[data-detail]'));
      const target = buttons.find((button) => button.dataset.detail === key);
      if (target) target.focus();
      return;
    }

    if (state.q) {
      applySearch('');
      els.search.focus();
    }
  });

  window.addEventListener('popstate', () => {
    window.clearTimeout(searchTimer);
    state = readStateFromUrl();
    els.search.value = state.q;
    els.clearSearch.hidden = !state.q;
    openKey = null;
    render();
    updateStatus();
  });

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  if (!data) {
    renderFatal();
    return;
  }

  state = readStateFromUrl();
  if (state.lang && !getBoard(state.board)?.windows[state.since]) {
    state.lang = '';
  }

  renderTabs();
  renderSinceSeg();
  els.search.value = state.q;
  els.clearSearch.hidden = !state.q;
  render();
  updateStatus();
  syncUrl('replace');

  if (typeof narrowQuery.addEventListener === 'function') {
    narrowQuery.addEventListener('change', updateStatus);
  }
  window.setInterval(updateStatus, 10 * 60 * 1000);
})();
