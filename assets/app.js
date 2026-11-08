(function () {
  'use strict';

  const data = window.__TRENDING_DATA__ || null;

  const els = {
    tabs: document.getElementById('tabs'),
    boardTitle: document.getElementById('boardTitle'),
    boardSub: document.getElementById('boardSub'),
    list: document.getElementById('list'),
    notice: document.getElementById('notice'),
    updateText: document.getElementById('updateText'),
    badgeDot: document.querySelector('#updateBadge .badge-dot'),
  };

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
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>' +
      '</svg>',
    fork:
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path fill="currentColor" d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.17 2.17 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.17 2.17 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/>' +
      '</svg>',
  };

  let activeBoardId = 'all';

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return number.toLocaleString('en-US');
  }

  function formatCount(value) {
    if (value == null) return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
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

  function makeSpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
  }

  function resolveColor(item) {
    if (item.languageColor && /^#[0-9a-f]{3,8}$/i.test(item.languageColor)) {
      return item.languageColor;
    }
    return LANGUAGE_COLORS[item.language] || '#8b949e';
  }

  function showEmpty(message) {
    els.list.replaceChildren();
    const card = document.createElement('div');
    card.className = 'state-card';
    const title = document.createElement('h2');
    title.textContent = '暂无榜单数据';
    const detail = document.createElement('p');
    detail.textContent = message;
    card.append(title, detail);
    els.list.appendChild(card);
  }

  function createRow(item, fallbackRank) {
    const rank = Number(item.rank) || fallbackRank;
    const row = document.createElement('article');
    row.className = 'repo';
    if (rank <= 3) row.classList.add('top-' + rank);

    const rankEl = document.createElement('span');
    rankEl.className = 'rank';
    rankEl.textContent = String(rank).padStart(2, '0');
    rankEl.setAttribute('aria-label', '第 ' + rank + ' 名');

    const body = document.createElement('div');
    body.className = 'repo-body';

    const title = document.createElement('h3');
    title.className = 'repo-title';
    const link = document.createElement('a');
    link.className = 'repo-link';
    link.href =
      'https://github.com/' +
      encodeURIComponent(String(item.owner || '')) +
      '/' +
      encodeURIComponent(String(item.name || ''));
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(
      makeSpan('repo-owner', String(item.owner || '')),
      makeSpan('repo-sep', '/'),
      makeSpan('repo-name', String(item.name || '')),
    );
    title.appendChild(link);

    const desc = document.createElement('p');
    desc.className = 'repo-desc';
    if (item.description) {
      desc.textContent = item.description;
    } else {
      desc.textContent = '暂无项目简介';
      desc.classList.add('is-empty');
    }

    const meta = document.createElement('div');
    meta.className = 'repo-meta';

    if (item.language) {
      const lang = document.createElement('span');
      lang.className = 'meta-item lang';
      const dot = document.createElement('i');
      dot.className = 'lang-dot';
      dot.style.backgroundColor = resolveColor(item);
      lang.append(dot, makeSpan('lang-name', item.language));
      meta.appendChild(lang);
    }

    if (item.stars != null) {
      const stars = document.createElement('span');
      stars.className = 'meta-item';
      stars.title = 'Star 总数：' + formatNumber(item.stars);
      const icon = document.createElement('span');
      icon.className = 'meta-icon';
      icon.innerHTML = ICONS.star;
      stars.append(icon, makeSpan('meta-text', formatCount(item.stars)));
      meta.appendChild(stars);
    }

    if (item.forks != null) {
      const forks = document.createElement('span');
      forks.className = 'meta-item';
      forks.title = 'Fork 总数：' + formatNumber(item.forks);
      const icon = document.createElement('span');
      icon.className = 'meta-icon';
      icon.innerHTML = ICONS.fork;
      forks.append(icon, makeSpan('meta-text', formatCount(item.forks)));
      meta.appendChild(forks);
    }

    if (item.starsToday != null) {
      const today = document.createElement('span');
      today.className = 'today';
      today.textContent = '今日 +' + formatNumber(item.starsToday);
      today.title = '该仓库今天新增的 Star 数';
      meta.appendChild(today);
    }

    body.append(title, desc, meta);
    row.append(rankEl, body);
    return row;
  }

  function syncTabs() {
    Array.from(els.tabs.children).forEach(function (button) {
      const isActive = button.dataset.board === activeBoardId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function renderBoard(boardId) {
    const board =
      data.boards.find(function (entry) {
        return entry.id === boardId;
      }) || data.boards[0];
    if (!board) return;

    activeBoardId = board.id;
    syncTabs();

    els.boardTitle.textContent =
      board.id === 'all' ? '今日热门总榜' : '今日 ' + board.label + ' 热门';
    const info = ['共 ' + board.items.length + ' 个项目'];
    if (board.source === 'api') info.push('本次使用 GitHub API 兜底数据');
    els.boardSub.textContent = info.join(' · ');
    document.title = board.label + ' · GitHub 热榜';

    els.list.replaceChildren();

    if (!board.items.length) {
      showEmpty('该榜单暂时没有数据，请稍后重试。');
      return;
    }

    const fragment = document.createDocumentFragment();
    board.items.forEach(function (item, index) {
      fragment.appendChild(createRow(item, index + 1));
    });
    els.list.appendChild(fragment);
  }

  function renderTabs() {
    els.tabs.replaceChildren();
    data.boards.forEach(function (board) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tab';
      button.dataset.board = board.id;
      button.textContent = board.label;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        renderBoard(board.id);
      });
      els.tabs.appendChild(button);
    });
  }

  function markNoData() {
    els.badgeDot.classList.add('is-error');
    els.updateText.textContent = '数据不可用';
    showEmpty(
      '没有找到榜单数据。请先在项目根目录运行 node scripts/fetch-trending.mjs，' +
        '或在 GitHub Actions 中手动触发“更新 GitHub 热榜”工作流。',
    );
  }

  if (!data || !Array.isArray(data.boards) || data.boards.length === 0) {
    markNoData();
    return;
  }

  if (data.sample) {
    els.notice.hidden = false;
    els.notice.textContent =
      '当前展示为示例数据，仅用于页面预览；首次 GitHub Actions 运行后会自动替换为真实榜单。';
    els.badgeDot.classList.add('is-sample');
    els.updateText.textContent = '示例数据 · 等待首次自动更新';
  } else {
    els.updateText.textContent = '更新于 ' + formatDate(data.generatedAt);
  }

  renderTabs();
  renderBoard(
    data.boards.some(function (board) {
      return board.id === activeBoardId;
    })
      ? activeBoardId
      : data.boards[0].id,
  );
})();
