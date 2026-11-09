# GitHub 热榜 · 每日开源趋势日报

每天自动抓取 GitHub Trending，生成可追溯、可检索、可订阅的开源趋势日报。纯静态站点，无后端、无账号、无第三方统计。

## 功能

- **榜单与时间窗**：总榜 + Python / JavaScript / TypeScript / Go / Rust / Java，支持今日 / 本周 / 本月。
- **趋势标识**：新上榜、排名上升 / 下降、连续在榜天数；无历史基线时隐藏，不猜测。
- **发现效率**：搜索（仓库、简介、主题、语言）、按新增 Star / 总 Star 排序、趋势筛选、总榜语言筛选。
- **项目详情**：内联展开完整简介、Topics、许可证、项目主页、最新 Release 与快捷操作。
- **数据可信**：每日快照、30 天历史、完整性校验、失败不覆盖、过期 / 部分可用 / 严重过期状态。
- **订阅与分享**：每日总榜 RSS、可还原当前视图的分享链接。
- **可访问性**：键盘操作（`/` 搜索、`Esc` 收起、方向键切换分类）、语义标签、对比度与多端布局。

## 本地预览

```bash
python3 -m http.server 8765
# 打开 http://localhost:8765/
```

页面通过 `data/trending.js` 读取快照，因此也可以直接打开 `index.html`（`file://`）预览。

抓取真实数据：

```bash
node scripts/fetch-trending.mjs
```

其他用法：

```bash
node scripts/fetch-trending.mjs --windows=daily,weekly --boards=all,python
node scripts/fetch-trending.mjs --dry-run          # 仅校验，不写任何文件
node scripts/fetch-trending.mjs --migrate-legacy   # 把旧版 v1 数据迁移到快照结构
```

`--boards='*'` 表示全部榜单（默认），`--boards=all` 只抓取总榜。本地无 `GITHUB_TOKEN` 时会跳过详情补充，主列表不受影响。

## 自动更新

工作流：[`.github/workflows/update.yml`](.github/workflows/update.yml)

- 每天 UTC 00:00（北京时间 08:00）自动运行。
- 支持手动触发，可选择时间窗、榜单范围和“仅校验不发布”。
- 抓取采用页面优先、GitHub API 兜底的策略；单榜失败不会影响其它榜单，也不会用空数据覆盖上一份有效快照。
- 数据提交后自动部署到 GitHub Pages。

首次使用时，在仓库 **Settings → Pages** 中把 Source 设为 **GitHub Actions**。

运行结束后，工作流页面会显示摘要（各榜条目数、来源、失败原因、耗时）。若出现失败、降级或延续旧数据，会自动创建 / 更新固定标题的告警 Issue；下一次完整成功后自动关闭。

## 数据文件

| 文件 | 说明 |
| --- | --- |
| `data/trending.json` | 最新快照，供程序读取 |
| `data/trending.js` | 同一份快照，供页面直接加载 |
| `data/history/YYYY-MM-DD.json` | 每日历史快照，用于趋势与连续在榜计算 |
| `data/history/index.json` | 历史索引与保留期 |
| `data/run-report.json` | 最近一次运行的校验结果与降级记录 |
| `feed.xml` | 每日总榜 RSS，仅由成功快照生成 |

快照结构（`schemaVersion: 2`）：

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-11-09T04:50:15.475Z",
  "lastSuccessAt": "2026-11-09T04:50:15.475Z",
  "date": "2026-11-09",
  "cycleHours": 24,
  "boards": [
    {
      "id": "all",
      "label": "总榜",
      "windows": {
        "daily": { "status": "ok", "source": "html", "items": [] },
        "weekly": { "status": "ok", "source": "html", "items": [] },
        "monthly": { "status": "ok", "source": "html", "items": [] }
      }
    }
  ],
  "partial": []
}
```

榜单时间窗状态：`ok`（本次成功）、`carried`（本次失败，沿用上次数据）、`empty`（暂无数据）。

## 可配置项

通过环境变量调整，均有保守默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `UPDATE_CYCLE_HOURS` | `24` | 更新周期，决定新鲜度判定 |
| `SNAPSHOT_RETENTION_DAYS` | `30` | 历史快照保留天数 |
| `MIN_ITEMS_ALL` | `8` | 总榜条目数下限 |
| `MIN_ITEMS_LANGUAGE` | `3` | 语言榜条目数下限 |
| `MAX_MISSING_RATE` | `0.2` | 必填字段缺失率阈值 |
| `DETAIL_LIMIT` | `60` | 每次运行补充详情的仓库数上限 |
| `RELEASE_LIMIT` | `12` | 补充最新 Release 的仓库数上限 |
| `SITE_URL` | 自动推导 Pages 地址 | RSS 与分享链接使用的站点地址 |

## 目录结构

```text
.
├── index.html                 页面结构
├── assets/
│   ├── app.js                 榜单渲染、筛选、URL 状态、详情与分享
│   └── style.css              深色主题与响应式样式
├── scripts/
│   └── fetch-trending.mjs     抓取、校验、快照、趋势、RSS 与运行报告
├── data/                      快照与历史（由工作流写入）
├── feed.xml                   每日总榜 RSS
├── docs/                      产品 PRD 与升级方案
└── .github/workflows/
    └── update.yml             定时抓取与 Pages 部署
```

## 数据与内容边界

- 榜单顺序来自 GitHub Trending 的机器排序，不做人工调整或付费排序。
- 项目简介保留原文，不做自动翻译；界面文案为中文。
- 示例数据、备用数据源、过期数据与沿用数据都会在页面上显式标注。
- 站点不收集访客信息，不接入第三方统计脚本。
