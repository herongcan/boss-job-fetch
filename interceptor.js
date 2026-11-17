// 页面主世界脚本 - 在 document_start 注入，抢占 window.fetch / XMLHttpRequest
// 注意：world=MAIN 的脚本没有 chrome.* API，采集结果通过 window.postMessage 交给 content.js 中转。

(function () {
  'use strict';

  if (window.__bzpCollectorHooked) return;
  window.__bzpCollectorHooked = true;

  const CHANNEL = '__bzpCollector';
  const URL_HINTS = ['joblist', 'search/job', 'job/list', 'geek/job', 'wapi/zpgeek'];
  const MAX_JOBS_PER_PAYLOAD = 200;

  function post(jobs, source) {
    if (!jobs || jobs.length === 0) return;
    try {
      window.postMessage({ [CHANNEL]: true, type: 'jobs', source: source, jobs: jobs }, '*');
    } catch (error) {
      // 页面被 CSP 限制时静默失败，不影响原页面逻辑
    }
  }

  function pickJobList(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const candidates = [
      payload.zpData && payload.zpData.jobList,
      payload.jobList,
      payload.data && payload.data.jobList,
      payload.zpData && payload.zpData.jobCardList,
      payload.jobCardList
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) return candidate;
    }
    return [];
  }

  function normalize(job) {
    const id = job.encryptJobId || job.jobId || job.encryptId || '';
    if (!id) return null;
    const location = [job.cityName, job.areaDistrict, job.businessDistrict].filter(Boolean).join('·');
    return {
      id: String(id),
      title: job.jobName || job.positionName || '',
      salary: job.salaryDesc || '',
      company: job.brandName || job.companyName || '',
      location: location,
      experience: job.jobExperience || '',
      education: job.jobDegree || '',
      skills: Array.isArray(job.skills) ? job.skills : Array.isArray(job.jobLabels) ? job.jobLabels : [],
      industry: job.brandIndustry || '',
      scale: job.brandScaleName || '',
      stage: job.brandStageName || '',
      url: `https://www.zhipin.com/job_detail/${id}.html`,
      source: 'api'
    };
  }

  function handlePayload(payload, source) {
    const list = pickJobList(payload).slice(0, MAX_JOBS_PER_PAYLOAD);
    if (list.length === 0) return;
    post(list.map(normalize).filter(Boolean), source);
  }

  function isTarget(url) {
    if (typeof url !== 'string' || url.length === 0) return false;
    return URL_HINTS.some((hint) => url.indexOf(hint) !== -1);
  }

  // --- fetch 劫持 ---
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = nativeFetch.apply(this, args);
      if (!isTarget(url)) return promise;
      return promise.then((response) => {
        try {
          response
            .clone()
            .json()
            .then((data) => handlePayload(data, 'api-fetch'))
            .catch(() => {});
        } catch (error) {
          // ignore
        }
        return response;
      });
    };
  }

  // --- XHR 劫持（BOSS 部分列表仍走 XHR） ---
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__bzpUrl = url;
      return nativeOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      if (isTarget(this.__bzpUrl)) {
        this.addEventListener('load', function () {
          try {
            const type = this.responseType;
            if (type && type !== 'text' && type !== 'json') return;
            const data = type === 'json' ? this.response : JSON.parse(this.responseText);
            handlePayload(data, 'api-xhr');
          } catch (error) {
            // ignore
          }
        });
      }
      return nativeSend.apply(this, args);
    };
  }
})();
