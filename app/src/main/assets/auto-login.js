/*
 * 自动完成 LibreTV 的密码校验，避免「服务起来了但没登录 -> /api/search 401 -> 搜不到视频」。
 * 脚本里的密码占位符由 Java 端用 JSONObject.quote() 替换成安全的 JS 字符串字面量。
 * 每个文档只检查一次。会话由服务端验证，换密码后可以重新登录。
 */
(function () {
  var P = __PASSWORD__;
  try {
    if (window.__ltvAutoLoginPending) return 'skip';
    window.__ltvAutoLoginPending = true;
    fetch('/api/status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s || !s.passwordRequired || s.verified) {
          window.__ltvAutoLoginPending = false;
          return;
        }
        return fetch('/api/auth', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: P })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.success) {
              window.__ltvAutoLoginPending = false;
              return;
            }
            return fetch('/api/status', { credentials: 'same-origin' })
              .then(function (r) { return r.json(); })
              .then(function (status) {
                window.__ltvAutoLoginPending = false;
                if (status && status.verified) location.reload();
              });
          });
      })
      .catch(function () { window.__ltvAutoLoginPending = false; /* 下次页面加载时重试 */ });
    return 'pending';
  } catch (e) {
    return 'err:' + (e && e.message ? e.message : String(e));
  }
})();
