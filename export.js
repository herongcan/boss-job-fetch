// 数据页脚本 - 扩展页面有完整 DOM 生命周期，导出在这里做才不会像 Service Worker 那样静默失败

const STORAGE_KEY = 'jobs';
const PREVIEW_LIMIT = 200;
const CSV_COLUMNS = [
  ['id', '岗位ID'],
  ['title', '职位名称'],
  ['salary', '薪资'],
  ['salaryMin', '月薪下限K'],
  ['salaryMax', '月薪上限K'],
  ['salaryMonths', '薪资月数'],
  ['salaryStatus', '薪资校验'],
  ['company', '公司'],
  ['location', '地点'],
  ['experience', '经验'],
  ['education', '学历'],
  ['skills', '技能标签'],
  ['industry', '行业'],
  ['scale', '公司规模'],
  ['description', '岗位描述'],
  ['url', '链接'],
  ['detailSource', '详情来源'],
  ['detailError', '失败原因'],
  ['detailAttempts', '失败次数'],
  ['crawlTime', '采集时间']
];

// 与 content.js 的 classifyPage 返回码对应
const FAIL_REASON = {
  security: '安全验证拦截',
  'rate-limit': '请求被限流',
  login: '需要登录',
  closed: '岗位已关闭',
  empty: '页面无 JD 正文',
  short: '返回内容为空',
  network: '网络异常',
  'iframe-timeout': '加载超时'
};

let jobs = [];

// ---- 表格排序 ----
// sortKey 为空 = 保持存储顺序（先采集在前）；点一次升序，再点降序，第三次取消排序
let sortKey = '';
let sortDir = '';

const SOURCE_RANK = { 'detail-page': 3, 'click-panel': 2, api: 1, failed: 0 };

// 列定义：key 对应排序字段，label 是表头文案；空 key 表示不可排序的列
const COLUMNS = [
  ['title', '职位'],
  ['salary', '薪资'],
  ['company', '公司'],
  ['location', '地点'],
  ['experience', '经验/学历'],
  ['skills', '技能'],
  ['description', '详情'],
  ['source', '来源'],
  ['', '']
];

// 数字列首次点击按降序（薪资、完整度这类默认想看高的）
const DESC_FIRST = new Set(['salary', 'description', 'source']);

// 取值函数：返回 null 表示该字段为空，排序时永远沉底，不随升降序翻转
const SORT_VALUE = {
  title: (job) => job.title || null,
  salary: (job) => (typeof job.salaryMin === 'number' ? job.salaryMin : null),
  company: (job) => job.company || null,
  location: (job) => job.location || null,
  experience: (job) => job.experience || job.education || null,
  skills: (job) => (Array.isArray(job.skills) && job.skills.length ? job.skills.join(' / ') : null),
  description: (job) => (job.description ? job.description.length : null),
  source: (job) => SOURCE_RANK[job.detailSource] ?? 0
};

function compareBySort(a, b) {
  const read = SORT_VALUE[sortKey];
  const va = read(a);
  const vb = read(b);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;   // 空值固定沉底
  if (vb === null) return -1;
  const result =
    typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), 'zh-CN', { numeric: true });
  return sortDir === 'desc' ? -result : result;
}

function sortedJobs() {
  if (!sortKey) return jobs;
  return jobs.slice().sort(compareBySort);
}

function sortLabel() {
  const column = COLUMNS.find(([key]) => key === sortKey);
  return column ? `按${column[1]}${sortDir === 'desc' ? '降序' : '升序'}` : '';
}

function $(id) {
  return document.getElementById(id);
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node.__timer);
  node.__timer = setTimeout(() => node.classList.remove('show'), 2000);
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

const SALARY_OK_RE = /(\d+(?:\.\d+)?)\s*[-~－]\s*(\d+(?:\.\d+)?)\s*K(?:\s*[·.．]\s*(\d+)\s*薪)?/i;

// 兜底：后台不可用时自己算一遍结构化薪资（与 background.js 规则一致）
function structureLocal(job) {
  const text = typeof job.salary === 'string' ? job.salary.trim() : '';
  if (!text) return { ...job, salaryStatus: 'empty' };
  if (text.indexOf('面议') !== -1) return { ...job, salaryStatus: 'negotiable' };
  const matched = SALARY_OK_RE.exec(text);
  if (!matched) {
    const next = { ...job, salaryStatus: 'invalid' };
    delete next.salaryMin;
    delete next.salaryMax;
    delete next.salaryMonths;
    return next;
  }
  return {
    ...job,
    salaryStatus: 'ok',
    salaryMin: Number(matched[1]),
    salaryMax: Number(matched[2]),
    salaryMonths: matched[3] ? Number(matched[3]) : 12
  };
}

async function loadJobs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getJobs' });
    if (response && response.success && Array.isArray(response.jobs)) {
      jobs = response.jobs;
      render();
      return;
    }
    throw new Error((response && response.error) || '后台无响应');
  } catch (error) {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const raw = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
      jobs = raw.map(structureLocal);
      render();
    } catch (inner) {
      jobs = [];
      renderError((inner && inner.message) || inner);
    }
  }
}

function renderError(message) {
  const wrap = $('tableWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="empty">读取本地数据失败：${escapeHtml(message)}<br>请确认该页面是从扩展入口打开的（chrome-extension:// 协议）。</div>`;
  $('previewNote').textContent = '';
}

function render() {
  const total = jobs.length;
  const withDesc = jobs.filter((job) => job.description).length;

  $('statTotal').textContent = total;
  $('statDesc').textContent = withDesc;
  $('statCoverage').textContent = total === 0 ? '0%' : Math.round((withDesc / total) * 100) + '%';

  let updatedAt = '';
  for (const job of jobs) {
    if (job.updateTime && job.updateTime > updatedAt) updatedAt = job.updateTime;
  }
  $('statUpdated').textContent = updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : '—';

  const downloadDisabled = total === 0;
  $('btnJson').disabled = downloadDisabled;
  $('btnCsv').disabled = downloadDisabled;
  $('btnCopy').disabled = downloadDisabled;
  $('btnClear').disabled = downloadDisabled;

  const wrap = $('tableWrap');
  if (total === 0) {
    wrap.innerHTML =
      '<div class="empty">暂无数据<br>打开 BOSS 直聘职位列表页，扩展会自动采集；<br>或回到弹窗点击「补全岗位详情」。</div>';
    $('previewNote').textContent = '';
    return;
  }

  const rows = sortedJobs().slice(0, PREVIEW_LIMIT);
  const sortedNote = sortKey ? ` · ${sortLabel()}` : '';
  $('previewNote').textContent =
    (total > PREVIEW_LIMIT ? `共 ${total} 条，预览前 ${PREVIEW_LIMIT} 条` : `共 ${total} 条`) + sortedNote;

  const body = rows
    .map((job) => {
      const desc = job.description ? `${job.description.length} 字` : '待补';
      let source;
      if (job.detailSource === 'detail-page') {
        source = '<span class="tag detail">详情页</span>';
      } else if (job.detailSource === 'click-panel') {
        source = '<span class="tag detail">面板</span>';
      } else if (job.detailSource === 'failed') {
        const reason = FAIL_REASON[job.detailError] || '原因未知';
        const times = job.detailAttempts ? ' ×' + job.detailAttempts : '';
        const tip = job.detailError === 'closed' ? '岗位已下架，补不到 JD' : `连续失败 ${job.detailAttempts || 0} 次`;
        const label = job.detailError === 'closed' ? `已关闭` : `失败·${escapeHtml(reason)}${times}`;
        source = `<span class="tag warn" title="${escapeAttr(tip)}">${label}</span>`;
      } else {
        source = '<span class="tag api">列表摘要</span>';
      }
      const skills = Array.isArray(job.skills) && job.skills.length ? job.skills.slice(0, 3).join(' / ') : '—';
      const link = job.url
        ? `<a href="${escapeAttr(job.url)}" target="_blank" rel="noreferrer">打开</a>`
        : '—';
      const salaryBadge = job.salaryStatus === 'invalid' ? ' <span class="tag warn">异常</span>' : '';
      return `<tr>
        <td class="title">${escapeHtml(job.title || '(无标题)')}</td>
        <td class="salary">${escapeHtml(job.salary || '—')}${salaryBadge}</td>
        <td>${escapeHtml(job.company || '—')}</td>
        <td class="dim">${escapeHtml(job.location || '—')}</td>
        <td class="dim">${escapeHtml([job.experience, job.education].filter(Boolean).join(' / ') || '—')}</td>
        <td class="dim">${escapeHtml(skills)}</td>
        <td class="dim">${desc}</td>
        <td>${source}</td>
        <td class="dim">${link}</td>
      </tr>`;
    })
    .join('');

  const head = COLUMNS.map(([key, label]) => {
    if (!key) return '<th></th>';
    const active = sortKey === key;
    const arrow = active ? `<span class="arrow">${sortDir === 'desc' ? '↓' : '↑'}</span>` : '';
    const tip = active ? '再点切换升降序，第三次恢复采集顺序' : '点击排序';
    return `<th class="sortable${active ? ' active' : ''}" data-key="${key}" title="${tip}">${label}${arrow}</th>`;
  }).join('');

  wrap.innerHTML = `<table>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

// 关键：在扩展页面里创建 blob URL 才是可靠的。Service Worker 没有 DOM，createObjectURL 直接不可用。
function download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 30000);
}

function toCsv(rows) {
  const header = CSV_COLUMNS.map(([, label]) => label);
  const lines = [header.map(csvCell).join(',')];
  for (const job of rows) {
    const line = CSV_COLUMNS.map(([key]) => {
      const value = job[key];
      if (Array.isArray(value)) return csvCell(value.join(' / '));
      return csvCell(value === undefined || value === null ? '' : value);
    });
    lines.push(line.join(','));
  }
  // 加 BOM，避免 Excel 打开中文乱码
  return '\uFEFF' + lines.join('\r\n');
}

function csvCell(value) {
  const text = String(value).replace(/\r?\n/g, ' ').trim();
  return '"' + text.replace(/"/g, '""') + '"';
}

// 私有区码位：字体反爬把 0-9 换成 U+E000–U+F8FF 的字符，视觉上仍是数字，文本里却不是
const PUA_RE = /[\uE000-\uF8FF]/;

function codepoints(text) {
  return Array.from(String(text))
    .map((char) => char.codePointAt(0).toString(16).padStart(4, '0'))
    .join(' ');
}

function runDiagnostics() {
  const panel = $('diagPanel');
  panel.style.display = 'block';
  const body = $('diagBody');

  if (jobs.length === 0) {
    $('diagSummary').textContent = '';
    body.innerHTML = '暂无数据，先去采集岗位。';
    return;
  }

  const ok = jobs.filter((job) => job.salaryStatus === 'ok' || job.salaryStatus === 'negotiable');
  const invalid = jobs.filter((job) => job.salaryStatus === 'invalid');
  const empty = jobs.filter((job) => job.salaryStatus === 'empty');
  const puaCount = invalid.filter((job) => PUA_RE.test(job.salary || '')).length;

  $('diagSummary').textContent = `可解析 ${ok.length} · 异常 ${invalid.length} · 空 ${empty.length}`;

  const parts = [];
  parts.push(
    `<div>共 <b>${jobs.length}</b> 条：可解析 <b style="color:#237804">${ok.length}</b> 条，` +
      `异常 <b style="color:#cf1322">${invalid.length}</b> 条，空 <b>${empty.length}</b> 条。</div>`
  );

  if (invalid.length > 0) {
    const conclusion =
      puaCount > 0
        ? `有 <b>${puaCount}</b> 条薪资含私有区字符（U+E000–U+F8FF）。这类码位靠页面字体映射成数字显示，` +
          `字符串本身不是 0-9，复制粘贴时会被整段丢弃，看起来就像"数字凭空消失"。` +
          `修法：从详情页 JSON-LD 结构化数据取薪，或重新执行「补全岗位详情」。`
        : `未检测到私有区字符，说明拿到手的原文本身就是残缺的（如 "-K"），不是显示问题。` +
          `对这批记录重新执行「补全岗位详情」，会从详情页结构化数据取真实薪资并覆盖。`;
    parts.push(
      `<div style="margin-top:8px; padding:10px 12px; background:#fff7e6; border-left:3px solid #fa8c16; border-radius:4px;">${conclusion}</div>`
    );

    const rows = invalid
      .slice(0, 10)
      .map((job, index) => {
        const raw = job.salary || '';
        const hasPua = PUA_RE.test(raw);
        const badge = hasPua ? '<span class="tag warn">私有区字符</span>' : '<span class="tag">纯 ASCII 残缺</span>';
        return `<div style="margin-top:10px; padding:9px 11px; background:#fafafa; border-radius:6px;">
          <div><b>${index + 1}. ${escapeHtml(job.title || '(无标题)')}</b> ${badge}</div>
          <div style="font-family:ui-monospace,monospace; font-size:12px; color:#595959;">
            原文 ${escapeHtml(JSON.stringify(raw))} ｜ 字符数 ${Array.from(raw).length}
          </div>
          <div style="font-family:ui-monospace,monospace; font-size:12px; color:#8c8c8c; word-break:break-all;">
            码位 ${escapeHtml(codepoints(raw))}
          </div>
        </div>`;
      })
      .join('');
    parts.push(
      `<div style="margin-top:12px;"><b>异常明细</b>${
        invalid.length > 10 ? `（前 10 条，共 ${invalid.length} 条）` : ''
      }${rows}</div>`
    );
  } else {
    parts.push('<div style="margin-top:8px; color:#237804;">薪资字段全部可解析，无需处理。</div>');
  }

  body.innerHTML = parts.join('');
}

document.addEventListener('DOMContentLoaded', () => {
  loadJobs().catch((error) => toast('读取失败：' + ((error && error.message) || error)));

  $('btnJson').addEventListener('click', () => {
    const rows = sortedJobs();
    download(JSON.stringify(rows, null, 2), `boss_jobs_${stamp()}.json`, 'application/json;charset=utf-8');
    toast(`已导出 ${rows.length} 条 JSON${sortKey ? `（${sortLabel()}）` : ''}`);
  });

  $('btnCsv').addEventListener('click', () => {
    const rows = sortedJobs();
    download(toCsv(rows), `boss_jobs_${stamp()}.csv`, 'text/csv;charset=utf-8');
    toast(`已导出 ${rows.length} 条 CSV${sortKey ? `（${sortLabel()}）` : ''}`);
  });

  $('btnCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(sortedJobs(), null, 2));
      toast('已复制到剪贴板');
    } catch (error) {
      toast('复制失败，请改用下载');
    }
  });

  // 表头排序：升序 → 降序 → 取消
  $('tableWrap').addEventListener('click', (event) => {
    const th = event.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    if (sortKey !== key) {
      sortKey = key;
      sortDir = DESC_FIRST.has(key) ? 'desc' : 'asc';
    } else if (sortDir === (DESC_FIRST.has(key) ? 'desc' : 'asc')) {
      sortDir = DESC_FIRST.has(key) ? 'asc' : 'desc';
    } else {
      sortKey = '';
      sortDir = '';
    }
    render();
  });

  $('btnReload').addEventListener('click', () => {
    loadJobs().then(() => toast('已刷新'));
  });

  $('btnDiag').addEventListener('click', runDiagnostics);

  $('btnClear').addEventListener('click', async () => {
    if (!confirm(`确定清空全部 ${jobs.length} 条数据？此操作不可撤销。`)) return;
    await chrome.storage.local.remove(STORAGE_KEY);
    await loadJobs();
    toast('数据已清空');
  });

  // 保持和其他标签页/弹窗的写入同步
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) loadJobs();
    });
  } catch (error) {
    // 非扩展上下文（例如本地直接打开该文件）时忽略
  }
});
