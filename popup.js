// 弹出页面脚本 v5 - 控制台：发起补全、看进度、导出
// 详情补全引擎在 content.js 里（fetch 优先 + iframe 兜底），这里只负责下任务和轮询进度。

const $ = (id) => document.getElementById(id);
let statsTimer = null;
let progressTimer = null;

// 失败原因的中文说明，与 content.js 里的 classifyPage 返回码对应
const REASON_LABEL = {
  security: '被安全验证拦截',
  'rate-limit': '请求过快被限流',
  login: '需要登录',
  closed: '岗位已关闭或下架',
  empty: '页面里找不到 JD 正文',
  short: '返回内容为空',
  network: '网络异常',
  'iframe-timeout': '详情页加载超时'
};

const reasonText = (code) => REASON_LABEL[code] || code;

function log(message) {
  const area = $('logArea');
  area.style.display = 'block';
  area.textContent += message + '\n';
  area.scrollTop = area.scrollHeight;
}

async function send(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response || { success: false, error: '无响应' };
  } catch (error) {
    return { success: false, error: String((error && error.message) || error) };
  }
}

async function refreshStats() {
  const stats = await send({ action: 'getStats' });
  if (!stats.success) return;
  $('total').textContent = stats.total;
  $('withDesc').textContent = stats.withDesc;

  const pending = stats.pendingDetail || 0;
  const button = $('fullBtn');
  if (button && !progressTimer) {
    button.textContent = pending > 0 ? `补全全部 JD 正文（${pending} 条待补）` : '补全全部 JD 正文';
    button.disabled = pending === 0;
  }

  const warn = $('salaryWarn');
  if (warn) {
    $('badSalary').textContent = stats.badSalary || 0;
    warn.style.display = stats.badSalary > 0 ? 'block' : 'none';
  }

  const failed = stats.failedDetail || 0;
  const closed = stats.closedDetail || 0;
  const failWarn = $('failWarn');
  if (failWarn) {
    $('failedNum').textContent = failed;
    const note = $('closedNote');
    if (note) {
      const retryable = Math.max(failed - closed, 0);
      note.textContent = closed > 0
        ? `，其中 ${closed} 条岗位已关闭（重试无效）${retryable > 0 ? `，${retryable} 条可重试` : ''}`
        : '（点下方按钮重试）';
    }
    failWarn.style.display = failed > 0 ? 'block' : 'none';
  }
  const retryBtn = $('retryBtn');
  if (retryBtn && !progressTimer) {
    const retryable = Math.max(failed - closed, 0);
    retryBtn.style.display = retryable > 0 ? 'block' : 'none';
    retryBtn.textContent = `重试失败记录（${retryable} 条）`;
    retryBtn.disabled = retryable === 0;
  }

  const purgeBtn = $('purgeClosedBtn');
  if (purgeBtn && !progressTimer) {
    purgeBtn.style.display = closed > 0 ? 'block' : 'none';
    purgeBtn.textContent = `清理已关闭岗位（${closed} 条）`;
    purgeBtn.disabled = closed === 0;
    // 条数变了就复位确认态，避免"确认删除"残留到下一批数据
    if (purgeBtn.dataset.count !== String(closed)) {
      purgeBtn.dataset.count = String(closed);
      resetPurgeConfirm();
    }
  }
}

// 扩展弹窗里 confirm() 会抢焦点、部分平台直接关掉弹窗，所以用"点两次"确认
let purgeConfirmTimer = null;
function resetPurgeConfirm() {
  const btn = $('purgeClosedBtn');
  if (!btn) return;
  clearTimeout(purgeConfirmTimer);
  btn.dataset.confirming = '';
  btn.classList.remove('confirming');
  const closed = Number(btn.dataset.count || 0);
  btn.textContent = `清理已关闭岗位（${closed} 条）`;
}

function setAutoStatus(text, type) {
  const node = $('autoStatus');
  node.textContent = text;
  node.className = 'pill' + (type ? ' ' + type : '');
}

async function detectAuto() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setAutoStatus('无活动标签页', 'warn');
      return;
    }
    const reply = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    if (reply && reply.ok) {
      setAutoStatus('已开启', 'ok');
    } else {
      setAutoStatus('未注入，请刷新页面', 'warn');
    }
  } catch (error) {
    setAutoStatus('未注入，请刷新页面', 'warn');
  }
}

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true });
}

function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  $('progressLine').style.display = 'none';
}

function startProgressPolling(tabId) {
  if (progressTimer) return;
  $('progressLine').style.display = 'block';

  progressTimer = setInterval(async () => {
    let reply = null;
    try {
      reply = await chrome.tabs.sendMessage(tabId, { action: 'progress' });
    } catch (error) {
      stopProgress();
      log('页面已断开，补全中断');
      $('fullBtn').disabled = false;
      return;
    }
    const state = reply && reply.backfill;
    if (!state) return;

    $('pgDone').textContent = state.done + state.failed;
    $('pgTotal').textContent = state.total;

    if (!state.running) {
      stopProgress();
      const detail = Object.keys(state.reasons || {})
        .map((code) => `${reasonText(code)}×${state.reasons[code]}`)
        .join('、');

      if (state.aborted) {
        log('已自动中断：连续 3 次「' + reasonText(state.aborted) + '」');
        log(`本轮成功 ${state.done} 条，剩余记录已保留待补，不会计入失败次数`);
        log('建议：在 BOSS 页面手动打开任一职位详情页停留几秒，或等几分钟再点补全');
      } else {
        log(`补全结束：成功 ${state.done} 条，失败 ${state.failed} 条`);
      }
      if (state.viaIframe) log(`其中 ${state.viaIframe} 条走了 iframe 兜底`);
      if (detail) log('失败原因：' + detail);

      $('fullBtn').disabled = false;
      await refreshStats();
    }
  }, 800);
}

async function startBackfill(includeFailed) {
  const button = $('fullBtn');
  button.disabled = true;
  log('读取待补列表...');

  const pending = await send({ action: 'getPendingDetails', limit: 200, includeFailed: !!includeFailed });
  if (!pending || !pending.success) {
    button.disabled = false;
    return log('读取待补列表失败：' + ((pending && pending.error) || '未知错误'));
  }
  if (!pending.tasks || pending.tasks.length === 0) {
    button.disabled = false;
    return log('没有待补记录，全部条目都已有 JD 正文');
  }
  log(`库里待补 ${pending.remaining} 条，本次处理 ${pending.tasks.length} 条`);

  const tabs = await activeTab();
  const tab = tabs && tabs[0];
  if (!tab) {
    button.disabled = false;
    return log('未找到活动标签页');
  }

  let started = null;
  try {
    started = await chrome.tabs.sendMessage(tab.id, { action: 'backfill', tasks: pending.tasks });
  } catch (error) {
    button.disabled = false;
    return log('页面未就绪，请先刷新 BOSS 页面再试');
  }

  if (!started || !started.started) {
    button.disabled = false;
    return log('未能启动：' + ((started && started.reason) || '未知原因'));
  }

  $('pgDone').textContent = '0';
  $('pgTotal').textContent = String(started.total);
  log('开始补全，请勿关闭该标签页...');
  startProgressPolling(tab.id);
}

document.addEventListener('DOMContentLoaded', async () => {
  await refreshStats();
  detectAuto();

  // 自动补全开关
  const config = await chrome.storage.local.get('autoDetail');
  $('autoDetail').checked = !!(config && config.autoDetail);
  $('autoDetail').addEventListener('change', async (event) => {
    await chrome.storage.local.set({ autoDetail: event.target.checked });
    log(event.target.checked ? '已开启自动补全（每次打开 BOSS 页面补最多 20 条）' : '已关闭自动补全');
  });

  // 注意不能直接把 startBackfill 当回调：addEventListener 会把事件对象当第一个参数传进去
  $('fullBtn').addEventListener('click', () => startBackfill(false));

  $('retryBtn').addEventListener('click', async () => {
    const btn = $('retryBtn');
    btn.disabled = true;
    log('正在重置失败记录...');
    const result = await send({ action: 'resetFailed' });
    if (!result.success) {
      btn.disabled = false;
      return log('重置失败：' + (result.error || '未知错误'));
    }
    log(`已重置 ${result.reset} 条，重新加入待补队列`);
    await startBackfill(true);
  });

  // 清理已关闭岗位：第一次点击进入确认态，3 秒内再点一次才真正删除
  $('purgeClosedBtn').addEventListener('click', async () => {
    const btn = $('purgeClosedBtn');
    if (btn.dataset.confirming !== '1') {
      btn.dataset.confirming = '1';
      btn.classList.add('confirming');
      btn.textContent = `确认删除 ${btn.dataset.count || 0} 条？再点一次`;
      clearTimeout(purgeConfirmTimer);
      purgeConfirmTimer = setTimeout(resetPurgeConfirm, 3000);
      return;
    }

    clearTimeout(purgeConfirmTimer);
    btn.disabled = true;
    const result = await send({ action: 'purgeClosed' });
    if (!result.success) {
      resetPurgeConfirm();
      btn.disabled = false;
      return log('清理失败：' + (result.error || '未知错误'));
    }
    log(`已清理 ${result.removed} 条已关闭岗位，剩余 ${result.total} 条`);
    if (result.removed === 0) log('没有可清理的记录（可能刚被其他标签页改过）');
    await refreshStats();
  });

  $('quickBtn').addEventListener('click', async () => {
    log('快速提取中...');
    const tabs = await activeTab();
    const tab = tabs && tabs[0];
    if (!tab) return log('未找到活动标签页');

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const jobs = [];
          const seen = new Set();
          document.querySelectorAll('a[href*="job_detail"]').forEach((anchor) => {
            const matched = (anchor.href || '').match(/job_detail\/([^?.]+)/);
            if (!matched || seen.has(matched[1])) return;
            const title = anchor.textContent ? anchor.textContent.trim() : '';
            if (!title || title.length < 2 || title.length > 60) return;
            seen.add(matched[1]);
            const card =
              anchor.closest('.job-card-wrapper') || anchor.closest('[class*="job-card"]') || anchor;
            const grab = (selectors) => {
              for (const selector of selectors) {
                const el = card.querySelector(selector);
                if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
              }
              return '';
            };
            const rawSalary = grab(['.salary', '[class*="salary"]']);
            // 只上报能通过校验的薪资。残缺值（如 "-K"）不入库，免得污染已拿到的好数据
            const salary = /^\d+(\.\d+)?\s*[-~－]\s*\d+(\.\d+)?\s*K/i.test(rawSalary) ? rawSalary : '';
            jobs.push({
              id: matched[1],
              title: title,
              salary: salary,
              company: grab(['.company-name', '[class*="company-name"]']),
              location: grab(['.job-area', '[class*="job-area"]']),
              url: anchor.href,
              source: 'dom'
            });
          });
          return jobs;
        }
      });

      const jobs = (results && results[0] && results[0].result) || [];
      if (jobs.length === 0) return log('未找到岗位卡片，请确认当前在职位列表页');

      const saved = await send({ action: 'saveJobs', jobs: jobs });
      log(`页面命中 ${jobs.length} 条，新增 ${saved.added || 0} 条，累计 ${saved.total || 0} 条`);
      await refreshStats();
    } catch (error) {
      log('提取失败：' + ((error && error.message) || error));
    }
  });

  $('exportBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('export.html') });
    window.close();
  });

  $('clearBtn').addEventListener('click', async () => {
    if (!confirm('确定清空全部已收集数据？此操作不可撤销。')) return;
    const result = await send({ action: 'clearJobs' });
    if (result.success) {
      log('数据已清空');
      await refreshStats();
    } else {
      log('清空失败：' + result.error);
    }
  });
});
