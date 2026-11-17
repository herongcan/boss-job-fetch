// 检查实际的 DOM 结构
(function() {
  // 查找所有包含 job_detail 的链接
  const jobLinks = document.querySelectorAll('a[href*="job_detail"]');
  console.log('找到 ' + jobLinks.length + ' 个职位链接');

  // 分析前几个链接的父元素结构
  const structures = new Set();
  jobLinks.forEach((link, i) => {
    if (i < 10) {
      let parent = link.parentElement;
      let structure = [];
      for (let j = 0; j < 5; j++) {
        if (parent) {
          structure.push(parent.tagName + (parent.className ? '.' + parent.className.split(' ').join('.') : ''));
          parent = parent.parentElement;
        }
      }
      structures.add(structure.join(' > '));
    }
  });

  console.log('\nDOM 结构示例:');
  structures.forEach(s => console.log(s));

  // 查找可能的职位卡片容器
  const possibleContainers = [
    '.job-card-wrapper',
    '.job-list-box',
    '.search-job-result',
    '[class*="job-card"]',
    '[class*="job-list"]',
    '[class*="position"]',
  ];

  console.log('\n容器搜索结果:');
  possibleContainers.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    console.log(selector + ': ' + elements.length + ' 个');
  });

  // 查找职位标题
  const titleSelectors = [
    '.job-name',
    '.job-title',
    '[class*="job-name"]',
    '[class*="job-title"]',
    'h3',
  ];

  console.log('\n标题选择器搜索:');
  titleSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    console.log(selector + ': ' + elements.length + ' 个');
  });
})();
