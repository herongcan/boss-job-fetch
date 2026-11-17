// 隔离世界脚本 - 采集引擎 v5
// 职责：1) 中转 interceptor.js 的接口数据；2) 按 jobId 补全 JD 正文。

(function () {
  'use strict';

  const CHANNEL = '__bzpCollector';
  const MAX_SEEN = 5000;

  // 节奏控制：比 v4 更慢，避免触发频控
  const DELAY_MIN = 700;
  const DELAY_MAX = 1500;
  const COOLDOWN_EVERY = 10;   // 每处理 N 条休息一次
  const COOLDOWN_MIN = 5000;
  const COOLDOWN_MAX = 9000;
  const IFRAME_TIMEOUT = 12000;

  // 连续出现这类失败说明环境被拦，继续跑只会把重试次数烧光
  const BREAKER_THRESHOLD = 3;
  // 环境类失败不消耗重试次数（不是岗位本身的问题）。
  // empty（页面能打开但没有 JD）不在此列：多半是模板变了，重试也没用，需计数熔断。
  const ENV_REASONS = new Set(['security', 'login', 'rate-limit', 'network', 'iframe-timeout', 'short']);

  const seen = new Set();
  const state = {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    reasons: {},
    aborted: '',
    viaIframe: 0,
    startedAt: 0,
    lastId: ''
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function forward(jobs, source) {
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    const fresh = [];
    for (const job of jobs) {
      if (!job || !job.id) continue;
      const id = String(job.id);
      // 接口自动采集做本页去重；详情补全与手动提取始终放行（可能要更新已有记录）
      if (source !== 'manual' && seen.has(id)) continue;
      seen.add(id);
      fresh.push(job);
    }
    if (seen.size > MAX_SEEN) seen.clear();
    if (fresh.length === 0) return;

    try {
      chrome.runtime.sendMessage({ action: 'saveJobs', jobs: fresh }, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // ignore
    }
  }

  window.addEventListener('message', function (event) {
    // 不用 event.source !== window 做校验：隔离世界里的 window 与 event.source 不是同一包装对象，
    // 那样写会把本扩展自己的消息全部过滤掉。只认通道标识即可。
    const data = event.data;
    if (!data || data[CHANNEL] !== true || data.type !== 'jobs') return;
    if (event.origin && event.origin !== location.origin) return;
    forward(data.jobs, data.source || 'auto');
  });

  // ---------------- 详情页解析 ----------------

  const DETAIL_URL = (id) => 'https://www.zhipin.com/job_detail/' + id + '.html';

  const JD_SELECTORS = [
    '.job-sec-text',
    '.job-detail-section .text',
    '.job-detail .text',
    '.detail-content .text',
    '[class*="job-sec"]'
  ];
  const JD_SELECTOR_QUERY = JD_SELECTORS.join(',');

  const SALARY_OK = /^\d+(?:\.\d+)?\s*[-~－]\s*\d+(?:\.\d+)?\s*K/i;

  function pickText(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      const value = el && el.textContent ? el.textContent.trim() : '';
      if (value) return value;
    }
    return '';
  }

  // 选择器全失效时的兜底：取"子元素不多的块"里文本最长的一个。
  // 必须命中 JD 特征词，否则挑战页/错误页里的长文本会被误当成正文。
  const JD_HINTS = /岗位职责|职位描述|工作职责|任职要求|职位要求|工作内容|岗位要求|职责描述|你将负责|我们希望你|职位详情/;

  function longestTextBlock(root) {
    const nodes = root.querySelectorAll('div, section, article');
    let best = '';
    for (const node of nodes) {
      if (node.children.length > 8) continue;
      const text = node.textContent ? node.textContent.trim() : '';
      if (text.length > best.length && text.length >= 80 && JD_HINTS.test(text)) best = text;
    }
    return best;
  }

  // 详情页常带 schema.org JobPosting 结构化数据，薪资是纯数字，不受页面字符混淆影响
  function structuredSalary(doc) {
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || '{}');
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || item['@type'] !== 'JobPosting' || !item.baseSalary) continue;
          const value = item.baseSalary.value || item.baseSalary;
          let min = Number(value.minValue !== undefined ? value.minValue : value.value);
          let max = Number(value.maxValue !== undefined ? value.maxValue : value.value);
          if (!min || !max) continue;
          if (value.unitText && /YEAR/i.test(value.unitText)) {
            min = min / 12;
            max = max / 12;
          }
          const minK = Math.round(min / 1000);
          const maxK = Math.round(max / 1000);
          if (minK <= 0 || maxK <= 0) continue;
          return minK + '-' + maxK + 'K';
        }
      } catch (error) {
        // 单个节点解析失败不影响其他
      }
    }
    return '';
  }

  /**
   * 判定一个已加载文档的状态。
   * 返回 'ok' | 'security' | 'login' | 'closed' | 'short' | 'empty'
   */
  function classifyPage(doc) {
    if (!doc) return 'empty';
    if (doc.querySelector(JD_SELECTOR_QUERY)) return 'ok';

    const title = (doc.title || '').trim();
    const body = doc.body ? (doc.body.textContent || '') : '';
    const html = doc.documentElement ? doc.documentElement.innerHTML.slice(0, 30000) : '';

    // BOSS 的 JS 挑战页：标题是"请稍候"，内含 SecurityJsHelper / __zp_stoken__
    if (title.indexOf('请稍候') !== -1) return 'security';
    if (html.indexOf('SecurityJsHelper') !== -1 || html.indexOf('__zp_stoken__') !== -1) return 'security';
    if (/职位已关闭|该职位已下线|职位不存在|已停止招聘|职位已失效/.test(body)) return 'closed';
    if (/\/web\/user\//.test(html) && /登录|注册/.test(body.slice(0, 400))) return 'login';
    if (body.trim().length < 60) return 'short';
    return 'empty';
  }

  // 页面是否已经可以解析：选择器命中，或存在含 JD 特征词的长文本块（选择器改版时兜底）
  function looksLikeDetail(doc) {
    if (doc.querySelector(JD_SELECTOR_QUERY)) return true;
    const text = doc.body ? doc.body.textContent || '' : '';
    if (!JD_HINTS.test(text)) return false;
    return !!longestTextBlock(doc);
  }

  function parseDetailRoot(doc, id) {
    if (!doc) return null;

    // 先判状态再解析。顺序很重要：如果先做兜底抽取，挑战页里的长文本
    // 会被当成 JD，被拦截的记录就会伪装成"抓取成功"。
    const status = classifyPage(doc);
    if (status === 'security' || status === 'login' || status === 'closed') return null;

    let description = pickText(doc, JD_SELECTORS);
    if (!description) description = longestTextBlock(doc);
    if (!description) return null;

    const visibleSalary = pickText(doc, ['.job-banner .salary', '.job-primary .salary', '.info-primary .salary', '.salary']);

    const tags = Array.from(doc.querySelectorAll('.job-keyword-list li, .job-tags span, .tag-list li'))
      .map((el) => el.textContent.trim())
      .filter(Boolean);

    return {
      id: id,
      title: pickText(doc, ['.job-banner .name h1', '.job-primary .name h1', 'h1', '.job-name']),
      salary: structuredSalary(doc) || (SALARY_OK.test(visibleSalary) ? visibleSalary : ''),
      company: pickText(doc, ['.company-info .company-name', '.sider-company .company-name', '.company-name']),
      location: pickText(doc, ['.job-banner .text-city', '.job-primary .job-area', '.job-area', '.location-address']),
      experience: pickText(doc, ['.job-banner .text-experiece', '.job-primary .job-experience', '.job-experience']),
      education: pickText(doc, ['.job-banner .text-degree', '.job-primary .job-degree', '.job-degree']),
      skills: tags,
      description: description.slice(0, 3000),
      url: DETAIL_URL(id),
      detailSource: 'detail-page'
    };
  }

  // ---------------- 两级取数：fetch 优先，被拦则用 iframe 走真实导航 ----------------

  // 解析不出正文时的失败原因：'ok' 表示页面结构在但取不到文本，归入 empty
  function fallbackReason(doc) {
    const status = classifyPage(doc);
    return status === 'ok' ? 'empty' : status;
  }

  /**
   * 直接 fetch 详情页 HTML。
   * 注意：BOSS 对 HTML 请求有服务端风控，未通过时返回 302 到
   * /web/passport/zp/security.html，该页需要执行 JS 才能生成 __zp_stoken__。
   * fetch 只拿到文本不执行脚本，所以这条路只适用于 stoken 仍然有效的场景。
   */
  async function fetchOnce(id) {
    try {
      const response = await fetch(DETAIL_URL(id), { credentials: 'include' });
      if (response.status === 404) return { reason: 'closed' };
      if (response.status === 429) return { reason: 'rate-limit' };
      if (response.status === 403) return { reason: 'security' };
      if (!response.ok) return { reason: 'http-' + response.status };

      const html = await response.text();
      if (!html || html.length < 200) return { reason: 'short' };

      const doc = new DOMParser().parseFromString(html, 'text/html');
      const job = parseDetailRoot(doc, id);
      if (job) return { job: job };

      return { reason: fallbackReason(doc) };
    } catch (error) {
      return { reason: 'network' };
    }
  }

  /**
   * 用隐藏在页面外的同源 iframe 加载详情页。
   * 走的是浏览器真实导航：302 → security.html 的挑战脚本正常执行 →
   * 算出 __zp_stoken__ 写入 cookie → 自动跳回详情页。
   * 全程同源，可以直接读 contentDocument。
   *
   * CSP 是 frame-ancestors 'self' ...，zhipin.com 页面嵌 zhipin.com 属于 self，允许。
   */
  function loadViaIframe(id) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:420px;height:900px;border:0;opacity:0;pointer-events:none;';

      let settled = false;
      const cleanup = () => {
        try {
          frame.remove();
        } catch (error) {
          // ignore
        }
      };

      const finish = (doc) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        setTimeout(cleanup, 60);
        resolve(doc || null);
      };

      const timer = setTimeout(() => finish(null), IFRAME_TIMEOUT);

      const poll = setInterval(() => {
        let doc = null;
        try {
          doc = frame.contentDocument;
        } catch (error) {
          return; // 跨文档时抛错，下一轮再看
        }
        if (!doc || !doc.documentElement) return;
        if (doc.readyState === 'loading') return;

        // 已经拿到 JD 容器（或选择器失效但正文特征命中），成功
        if (looksLikeDetail(doc)) return finish(doc);

        // 还停在挑战页，让它自己算完并跳转，继续等
        const title = (doc.title || '').trim();
        if (title.indexOf('请稍候') !== -1) return;
        if (doc.documentElement.innerHTML.indexOf('SecurityJsHelper') !== -1) return;

        // 明确的终态（已关闭/登录页），没必要再等
        const body = doc.body ? doc.body.textContent || '' : '';
        if (/职位已关闭|该职位已下线|职位不存在|已停止招聘/.test(body)) return finish(doc);
      }, 250);

      frame.src = DETAIL_URL(id);
      (document.body || document.documentElement).appendChild(frame);
    });
  }

  async function resolveOne(id) {
    const first = await fetchOnce(id);
    if (first.job) return first;

    // 被风控或拿到空壳页：用 iframe 让挑战脚本跑一遍再取
    if (first.reason === 'security' || first.reason === 'short' || first.reason === 'empty' || first.reason === 'rate-limit') {
      const doc = await loadViaIframe(id);
      if (!doc) return { reason: 'iframe-timeout', viaIframe: true };

      const job = parseDetailRoot(doc, id);
      if (job) return { job: job, viaIframe: true };

      return { reason: fallbackReason(doc), viaIframe: true };
    }

    return first;
  }

  // ---------------- 批量补全 ----------------

  function bumpReason(reason) {
    state.reasons[reason] = (state.reasons[reason] || 0) + 1;
  }

  /**
   * tasks = [{ id, title }]，与当前页面 DOM 无关，可以在任意 BOSS 页面跑。
   */
  async function runBackfill(tasks) {
    if (state.running) return { started: false, reason: '已有任务进行中' };
    if (!Array.isArray(tasks) || tasks.length === 0) return { started: false, reason: '没有待补记录' };

    state.running = true;
    state.total = tasks.length;
    state.done = 0;
    state.failed = 0;
    state.reasons = {};
    state.aborted = '';
    state.viaIframe = 0;
    state.startedAt = Date.now();

    let streak = 0;
    let processed = 0;

    for (const task of tasks) {
      if (!task || !task.id) continue;
      state.lastId = task.id;

      const result = await resolveOne(task.id);

      if (result.job) {
        streak = 0;
        if (task.title && (!result.job.title || result.job.title.length < 2)) result.job.title = task.title;
        if (result.viaIframe) state.viaIframe += 1;
        forward([result.job], 'manual');
        state.done += 1;
      } else {
        streak += 1;
        state.failed += 1;
        bumpReason(result.reason);

        // 只有岗位本身的问题才消耗重试次数；被风控拦下来的不算，
        // 否则环境一抖就把整批记录烧成"失败 3 次"永久出局。
        if (!ENV_REASONS.has(result.reason)) {
          forward(
            [
              {
                id: task.id,
                title: task.title || '',
                url: DETAIL_URL(task.id),
                detailSource: 'failed',
                detailError: result.reason
              }
            ],
            'manual'
          );
        }

        if (streak >= BREAKER_THRESHOLD) {
          state.aborted = result.reason;
          state.running = false;
          return {
            started: true,
            total: state.total,
            done: state.done,
            failed: state.failed,
            aborted: state.aborted
          };
        }
      }

      processed += 1;
      await sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
      if (processed % COOLDOWN_EVERY === 0) {
        await sleep(COOLDOWN_MIN + Math.random() * (COOLDOWN_MAX - COOLDOWN_MIN));
      }
    }

    state.running = false;
    return { started: true, total: state.total, done: state.done, failed: state.failed, aborted: '' };
  }

  async function autoBackfill() {
    try {
      const config = await chrome.storage.local.get('autoDetail');
      if (!config || !config.autoDetail) return;
      const pending = await send({ action: 'getPendingDetails', limit: 20 });
      if (!pending || !pending.success || !pending.tasks || pending.tasks.length === 0) return;
      runBackfill(pending.tasks);
    } catch (error) {
      // ignore
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message && message.action;

    if (action === 'ping') {
      sendResponse({ ok: true, seen: seen.size, backfill: state });
      return false;
    }

    if (action === 'backfill') {
      if (state.running) {
        sendResponse({ started: false, reason: '已有任务进行中', backfill: state });
        return false;
      }
      // 立刻回执，进度靠 progress 轮询
      runBackfill(message.tasks).catch(() => {
        state.running = false;
      });
      sendResponse({ started: true, total: (message.tasks || []).length });
      return false;
    }

    if (action === 'progress') {
      sendResponse({ ok: true, backfill: state });
      return false;
    }

    return false;
  });

  // 页面空闲后检查是否需要自动补全
  setTimeout(autoBackfill, 2500);
})();
