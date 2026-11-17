// 这个脚本会被注入到页面中，直接提取数据

(function() {
  const jobs = [];
  const links = document.querySelectorAll('a[href*="job_detail"]');

  links.forEach(link => {
    try {
      const href = link.href;
      const idMatch = href.match(/job_detail\/([^?]+)/);
      if (!idMatch) return;

      const jobId = idMatch[1];
      const text = link.textContent.trim();

      if (text && text.length > 1 && text.length < 50) {
        jobs.push({
          id: jobId,
          title: text,
          url: href
        });
      }
    } catch(e) {}
  });

  return jobs;
})();
