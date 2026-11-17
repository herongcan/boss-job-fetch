// 后台服务 - 以 chrome.storage.local 为唯一数据源，按 jobId 合并去重
// 注意：Service Worker 里没有 DOM，无法使用 URL.createObjectURL 生成下载链接。
// 因此导出统一交给扩展页面 export.html 处理，这里只负责数据聚合。

const STORAGE_KEY = 'jobs';

// 数据来源优先级：详情页 > 接口 > 点击面板 > DOM 快速提取
// 详情页排在接口之前，是因为它的薪资来自 JSON-LD（纯数字），比列表接口更权威；
// 标题、公司名等也更完整。失败标记不在此表，rank 为 0，永远不会覆盖已有数据。
const SOURCE_RANK = { 'detail-page': 4, api: 3, 'click-panel': 1, dom: 0 };

// 薪资形如 "30-50K"、"35-55K·15薪"、"20-40K·13薪"；"面议" 也认作合法
const SALARY_RE = /(\d+(?:\.\d+)?)\s*[-~－]\s*(\d+(?:\.\d+)?)\s*K(?:\s*[·.．]\s*(\d+)\s*薪)?/i;

function isValidSalary(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (text.indexOf('面议') !== -1) return true;
  return SALARY_RE.test(text);
}

// 字段级校验：校验不过的值视为"残值"，不允许覆盖已有合法值
const VALIDATORS = {
  salary: isValidSalary,
  title: (value) => typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 60,
  url: (value) => typeof value === 'string' && value.indexOf('/job_detail/') !== -1,
  // 关键：已经拿到详情页内容的记录，不能被后续一次抓取失败退回成 failed
  detailSource: (value, previous) => {
    if (value === 'failed' && previous === 'detail-page') return false;
    return true;
  }
};

/**
 * 判断新值能否覆盖旧值。
 * 1. 旧值不合法 → 接受新值（哪怕新值也不合法，也不比原来更差）
 * 2. 旧值合法、新值不合法 → 拒收（-K 不能覆盖 30-50K）
 * 3. 都合法 → 按来源优先级，同级或更高才覆盖
 */
function shouldAccept(field, incoming, previous, incomingRank, previousRank) {
  const validator = VALIDATORS[field];
  if (!validator) return true;
  const okIncoming = validator(incoming);
  const okPrevious = validator(previous);
  if (!okPrevious) return true;
  if (!okIncoming) return false;
  return incomingRank >= previousRank;
}

function parseSalary(text) {
  if (!isValidSalary(text)) return null;
  const matched = SALARY_RE.exec(text);
  if (!matched) return null;
  return {
    salaryMin: Number(matched[1]),
    salaryMax: Number(matched[2]),
    salaryMonths: matched[3] ? Number(matched[3]) : 12
  };
}

// 把薪资原文解成结构化字段，供后续匹配/排序直接用
function applySalaryStructure(job) {
  if (!job.salary) {
    job.salaryStatus = 'empty';
    return job;
  }
  if (job.salary.indexOf('面议') !== -1) {
    job.salaryStatus = 'negotiable';
    delete job.salaryMin;
    delete job.salaryMax;
    delete job.salaryMonths;
    return job;
  }
  const parsed = parseSalary(job.salary);
  if (parsed) {
    job.salaryMin = parsed.salaryMin;
    job.salaryMax = parsed.salaryMax;
    job.salaryMonths = parsed.salaryMonths;
    job.salaryStatus = 'ok';
  } else {
    job.salaryStatus = 'invalid';
    delete job.salaryMin;
    delete job.salaryMax;
    delete job.salaryMonths;
  }
  return job;
}

// 串行化读-改-写，避免并发 saveJobs 互相覆盖
let queue = Promise.resolve();
function withLock(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function isBlank(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

async function readJobs() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const jobs = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  // 读时补算结构化薪资，历史数据（没有 salaryStatus 的）也能直接被体检
  return jobs.map((job) => {
    if (!job || !job.id) return job;
    const next = applySalaryStructure({ ...job });
    // 兼容旧数据：v4 时期失败标记因来源优先级被吞，只留下 detailAttempts/detailError，
    // 这里补回 detailSource，保证导出页能看出这条是抓取失败而不是"列表摘要"
    if (!next.description && next.detailSource !== 'detail-page' && (next.detailError || next.detailAttempts)) {
      next.detailSource = 'failed';
    }
    return next;
  });
}

function rankOf(job) {
  if (!job) return 0;
  const key = job.detailSource && SOURCE_RANK[job.detailSource] !== undefined ? job.detailSource : job.source;
  return SOURCE_RANK[key] === undefined ? 0 : SOURCE_RANK[key];
}

/**
 * 合并岗位：同 id 的字段做并集，但受 shouldAccept 约束——
 * 残值（如 "-K"）永远不会覆盖已经拿到的合法值（如 "30-50K"）。
 */
function mergeJobs(base, incoming) {
  const map = new Map();
  for (const job of base) {
    if (job && job.id) map.set(String(job.id), job);
  }

  let added = 0;
  for (const raw of incoming) {
    if (!raw || isBlank(raw.id)) continue;
    const id = String(raw.id).trim();
    const prev = map.get(id);
    const next = prev ? { ...prev } : {};

    const incomingRank = rankOf(raw);
    const previousRank = rankOf(prev);

    for (const [key, value] of Object.entries(raw)) {
      // detailSource 是状态字段，不参与来源优先级比较，单独处理（见下方）
      if (key === 'id' || key === 'detailSource') continue;
      if (isBlank(value)) continue;
      const clean = typeof value === 'string' ? value.trim() : value;
      if (!shouldAccept(key, clean, prev ? prev[key] : undefined, incomingRank, previousRank)) continue;
      next[key] = clean;
    }

    next.id = id;
    if (!next.url) next.url = `https://www.zhipin.com/job_detail/${id}.html`;
    if (raw.detailSource === 'failed') {
      // failed 的 rank 是 0，永远打不过 source:api(3)。若走通用字段比较，
      // 失败状态根本写不进去，记录会一直显示"待补"并被无限重试。
      // 只在"确实还没有正文"时才标失败，已经有 JD 的记录不该被打上失败标记。
      if (next.detailSource !== 'detail-page' && !next.description) {
        next.detailSource = 'failed';
        next.detailAttempts = (next.detailAttempts || 0) + 1;
      }
    } else if (raw.detailSource === 'detail-page') {
      next.detailSource = 'detail-page';
      // 抓到了就清账：失败计数与失败原因都不该残留，否则一条记录
      // 先失败两次、成功后又被失败一次就满 3 次被永久剔除
      delete next.detailAttempts;
      delete next.detailError;
    }
    if (!prev) {
      next.crawlTime = raw.crawlTime || new Date().toISOString();
      added += 1;
    }
    next.updateTime = new Date().toISOString();
    map.set(id, applySalaryStructure(next));
  }

  return { jobs: Array.from(map.values()), added };
}

const MAX_DETAIL_ATTEMPTS = 3;
// 终态失败：岗位已关闭/不存在，重试多少次都不会变，不该占着"待补"名额
const TERMINAL_REASONS = new Set(['closed']);

// 需要补详情的记录：没有 JD 正文，或薪资解析不出来。
// includeFailed 为 true 时连同已被熔断的记录一起返回（用于手动重试）。
function needsDetail(job, includeFailed) {
  if (!job || !job.id) return false;
  if (!job.description || job.salaryStatus === 'invalid') {
    if (includeFailed) return true;
    if (TERMINAL_REASONS.has(job.detailError)) return false;
    if ((job.detailAttempts || 0) >= MAX_DETAIL_ATTEMPTS) return false;
    return true;
  }
  return false;
}

function pendingTasks(jobs, limit, includeFailed) {
  const all = jobs
    .filter((job) => needsDetail(job, includeFailed))
    .sort((a, b) => String(a.crawlTime || '').localeCompare(String(b.crawlTime || '')));
  return {
    remaining: all.length,
    tasks: all.slice(0, limit).map((job) => ({ id: job.id, title: job.title || '' }))
  };
}

async function handle(message) {
  const action = message && message.action;

  if (action === 'saveJobs') {
    const incoming = Array.isArray(message.jobs) ? message.jobs : [];
    if (incoming.length === 0) {
      return { success: true, total: (await readJobs()).length, added: 0 };
    }
    return withLock(async () => {
      const base = await readJobs();
      const { jobs, added } = mergeJobs(base, incoming);
      await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
      return { success: true, total: jobs.length, added };
    });
  }

  if (action === 'getJobs') {
    return { success: true, jobs: await readJobs() };
  }

  if (action === 'getStats') {
    const jobs = await readJobs();
    const withDesc = jobs.filter((job) => job.description).length;
    const badSalary = jobs.filter((job) => job.salaryStatus === 'invalid').length;
    const pendingDetail = jobs.filter((job) => needsDetail(job, false)).length;
    // 抓过但没抓到 JD 的记录（含已被熔断剔除的）
    const failedDetail = jobs.filter((job) => !job.description && (job.detailSource === 'failed' || job.detailAttempts)).length;
    // 其中岗位已关闭/不存在的终态记录，重试无意义
    const closedDetail = jobs.filter((job) => !job.description && job.detailError === 'closed').length;
    let updatedAt = '';
    for (const job of jobs) {
      if (job.updateTime && job.updateTime > updatedAt) updatedAt = job.updateTime;
    }
    return { success: true, total: jobs.length, withDesc, badSalary, pendingDetail, failedDetail, closedDetail, updatedAt };
  }

  if (action === 'getPendingDetails') {
    const limit = Number(message.limit) > 0 ? Math.min(Number(message.limit), 500) : 50;
    const jobs = await readJobs();
    return { success: true, ...pendingTasks(jobs, limit, !!message.includeFailed) };
  }

  // 把失败记录重新放回待补队列：清掉失败计数与失败标记
  if (action === 'resetFailed') {
    return withLock(async () => {
      const jobs = await readJobs();
      let reset = 0;
      const next = jobs.map((job) => {
        if (!job || !job.id || job.description) return job;
        if (job.detailSource !== 'failed' && !job.detailAttempts) return job;
        const copy = { ...job };
        delete copy.detailAttempts;
        delete copy.detailError;
        if (copy.detailSource === 'failed') delete copy.detailSource;
        reset += 1;
        return copy;
      });
      if (reset > 0) await chrome.storage.local.set({ [STORAGE_KEY]: next });
      return { success: true, reset, total: next.length };
    });
  }

  // 删除"岗位已关闭/不存在"的终态记录：这类岗位补不到 JD，留着只会占列表
  if (action === 'purgeClosed') {
    return withLock(async () => {
      const jobs = await readJobs();
      const keep = jobs.filter((job) => !(job && !job.description && job.detailError === 'closed'));
      const removed = jobs.length - keep.length;
      if (removed > 0) await chrome.storage.local.set({ [STORAGE_KEY]: keep });
      return { success: true, removed, total: keep.length };
    });
  }

  if (action === 'clearJobs') {
    return withLock(async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      return { success: true, total: 0 };
    });
  }

  return { success: false, error: `未知操作: ${action}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ success: false, error: String((error && error.message) || error) }));
  return true;
});
