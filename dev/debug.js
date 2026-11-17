// 调试脚本 - 打印所有 XHR 请求

(function() {
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    console.log('🔗 XHR 请求:', method, url);
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    console.log('🔗 Fetch 请求:', args[0]);
    return originalFetch.apply(this, args);
  };

  console.log('✅ 调试脚本已加载');
})();
