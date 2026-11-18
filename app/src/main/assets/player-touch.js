/*
 * LibreTV 安卓客户端：移动端播放交互增强（MainActivity 在 onPageFinished 注入）。
 *
 * 移动端三个痛点：
 *  1) 全屏难点：ArtPlayer 的「全屏」走浏览器原生 Fullscreen API，Android WebView
 *     会把播放器抽成 custom view，网页控件随之失效；而窄屏下网页全屏图标只有 40px。
 *     -> 客户端提供常驻大按钮直调 enter()，并把原生全屏按钮重定向为网页全屏。
 *  2) 进度难拖：网页进度条在手机上只有几像素高。
 *     -> 放大命中区，同时把 currentTime/duration 通过 LtvBridge 上报给原生 SeekBar 精确拖拽。
 *  3) 画面不适配：竖屏时播放器是桌面栅格里的一小块，且 object-fit 可能被拉伸。
 *     -> video 默认 contain，提供 contain / cover / fill 三档，由原生「画面」按钮循环切换。
 *
 * 幂等：重复注入直接返回；不改动 LibreTV 服务端代码。
 */
(function () {
  if (window.__ltvPlayerInstalled) return;
  window.__ltvPlayerInstalled = true;

  var STYLE_ID = 'ltv-player-style';
  var BRIDGE = 'LtvBridge';
  /* 网页内兜底 UI 的节点 id（退出全屏 + 投屏；进度条用 LibreTV 自带的迷你条） */
  var UI_WRAP_ID = 'ltv-ui';
  var UI_ROW_ID = 'ltv-top-actions';
  var UI_EXIT_ID = 'ltv-exit-btn';
  var UI_CAST_ID = 'ltv-cast-btn';
  var UI_PLAYBACK_ID = 'ltv-playback-btn';
  /* null = 跟随全屏判定；true/false = 原生显式指定（见 window.__ltv.setUiVisible） */
  var uiVisibleOverride = null;
  var castLabel = '投屏';
  /* ---- 投屏会话状态（面板就是一台遥控器，这些值决定按钮显示什么） ---- */
  /** 当前投屏是否处于「已连接」状态：true 时点投屏按钮进的是管理面板而不是重新搜设备 */
  var castActive = false;
  /** 当前投屏设备名 */
  var castName = '';
  /** 面板上显示的暂停态：与电视端同步（原生轮询会回写） */
  var castPaused = false;
  /** 电视端最近一次上报的进度（秒）与拿到该进度的时间戳，用于两次轮询之间平滑外推 */
  var castPos = 0;
  var castDur = 0;
  var castPosAt = 0;
  var castTick = null;
  var lastState = null;
  /* 用户是否主动要网页控制栏（点「网页」）。只有它为 false 时才由客户端接管并压住网页栏；
     由 Java 的 showWebControls / hideWebControls 精确置位，避免兜底逻辑把用户的选择抢回去。 */
  var webControlsWanted = false;
  var lastVideo = null;
  var lastReport = 0;
  var streamUrl = '';
  var streamPage = '';
  var hudIdleTimer = null;
  var HUD_IDLE_MS = 4000;
  var tempRateActive = false;
  var tempRateSaved = 1;
  var controlsHideTimer = null;

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function wakeHud() {
    try {
      if (hudIdleTimer) { clearTimeout(hudIdleTimer); hudIdleTimer = null; }
      var rootEl = document.documentElement;
      if (!isFullscreen()) {
        rootEl.removeAttribute('data-ltv-hud');
        return;
      }
      rootEl.setAttribute('data-ltv-hud', 'awake');
      var v = vid();
      if (!playbackPanel && !castPanelOpen && v && !v.paused) {
        hudIdleTimer = setTimeout(function () {
          hudIdleTimer = null;
          var curV = vid();
          if (isFullscreen() && !playbackPanel && !castPanelOpen && curV && !curV.paused) {
            document.documentElement.setAttribute('data-ltv-hud', 'idle');
          }
        }, HUD_IDLE_MS);
      }
    } catch (e) { }
  }

  // ---------------------------------------------------------------- 投屏：捕获视频直链
  // 电视无法播放 WebView 里的 blob: 地址，必须拿到原始 m3u8/mp4 URL。
  // hls.js 用 XHR 拉清单与分片，少数直连走 fetch，这里在最早注入点包装两者。
  function castStreamUrl(input) {
    var url = new URL(String(input), location.href);
    for (var depth = 0; depth < 2; depth++) {
      if (url.origin === location.origin
          && (url.pathname === '/api/proxy' || url.pathname === '/api/live/stream')) {
        var raw = url.searchParams.get('url');
        if (!raw) break;
        url = new URL(raw, location.href);
      } else {
        break;
      }
    }
    return /^https?:$/.test(url.protocol) ? url.href : '';
  }
  function looksLikeStream(u) {
    if (!u) return false;
    var s = String(u);
    if (s.indexOf('blob:') === 0 || s.indexOf('data:') === 0) return false;
    if (/\/api\/live\/stream\b/i.test(s)) return true;
    if (/\.(m3u8|mp4|flv|mkv|avi)(\?|#|&|$)/i.test(s)) return true;
    /* 服务端代理：/api/proxy?url=xxx.m3u8 */
    if (/\/api\/proxy\b/i.test(s) && /[?&](url|src|u)=/i.test(s)) return true;
    if (/[?&](url|src|u)=/i.test(s) && /m3u8|mp4|flv/i.test(s)) return true;
    return false;
  }
  function reportStream(u) {
    if (!looksLikeStream(u)) return;
    try {
      var abs = castStreamUrl(u);
      if (!abs) return;
      streamUrl = abs;
      streamPage = location.href;
    } catch (e) { }
  }
  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__ltvHooked) {
      var rawOpen = XHR.prototype.open;
      XHR.prototype.open = function () {
        try { reportStream(arguments[1]); } catch (e) { }
        return rawOpen.apply(this, arguments);
      };
      XHR.prototype.__ltvHooked = true;
    }
  } catch (e) { }
  try {
    if (window.fetch && !window.fetch.__ltvHooked) {
      var rawFetch = window.fetch;
      var hookedFetch = function (input) {
        try {
          reportStream(typeof input === 'string' ? input : (input && input.url));
        } catch (e) { }
        return rawFetch.apply(window, arguments);
      };
      hookedFetch.__ltvHooked = true;
      window.fetch = hookedFetch;
    }
  } catch (e) { }

  function q(sel) { return document.querySelector(sel); }
  function vid() { return q('video'); }
  /**
   * 取一个可安全调用的原生桥方法。
   *
   * 关键：必须把方法绑回注入对象再调用。Android 的 addJavascriptInterface 对象跟
   * DOM 方法一样会做 receiver 检查 —— 取出来单独 `fn()` 在部分 WebView 上会抛
   * "Illegal invocation"。之前干脆把方法裸取出来调，于是：
   *   · exitFullscreen 抛错 → 落进 window.__ltv.exit() 兜底，看起来「能用」；
   *   · setDomUi / log / onProgress 抛错被 try 吞掉，静默失效；
   *   · cast 抛错 → 面板只能报「投屏需要客户端环境」。
   * 用户看到的「不是 DLNA 投屏吗，为什么显示需要客户端环境」就是这一条。
   */
  function bridge(name) {
    try {
      var b = window[BRIDGE];
      if (!b || typeof b[name] !== 'function') return null;
      return function () { return b[name].apply(b, arguments); };
    } catch (e) { return null; }
  }

  /** 直接调一次原生方法，只转发实际传入的参数（Android @JavascriptInterface 严格校验参数个数） */
  function callBridge(name) {
    var fn = bridge(name);
    if (!fn) return false;
    try {
      fn.apply(null, Array.prototype.slice.call(arguments, 1));
      return true;
    } catch (e) { return false; }
  }

  function hasClass(node, cls) {
    if (!node || !node.className || typeof node.className !== 'string') return false;
    return (' ' + node.className + ' ').indexOf(' ' + cls + ' ') >= 0;
  }
  function upClass(node, cls) {
    while (node && node !== document) {
      if (hasClass(node, cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function nativeFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
              document.webkitCurrentFullScreenElement);
  }
  function manualFullscreen() {
    try { return document.documentElement.classList.contains('ltv-fs-manual'); }
    catch (e) { return false; }
  }
  function isFullscreen() {
    return nativeFullscreen() || manualFullscreen() ||
           !!q('.art-fullscreen-web, .art-fullscreen');
  }
  function notify(on) {
    var fn = bridge('onFullscreen');
    if (fn) { try { fn(!!on); } catch (e) { } }
  }

  // ---------------------------------------------------------------- 网页内兜底 UI（只剩退出按钮）
  /* 这里曾经还画过一条红色细进度线。删掉的原因（读 ArtPlayer + LibreTV 源码后确认）：
     LibreTV 的播放器开了自己的 miniProgressBar 选项（默认 true），逻辑是
       art.on('control', shown => shown ? 移除 : 添加 'art-mini-progress-bar')
     并配了对应 CSS —— 控制栏收起时，.art-bottom 保持可见、按钮行被推到画面外，
     只留一条 fine 进度条。也就是说「控制栏收起时的常驻进度条」这个能力，网页本来就有，
     而且它和控制栏状态严格互斥（同一份状态驱动）。
     我们那条红条靠 1Hz 轮询猜控制栏状态，猜错就是「红条和菜单叠在一起、点菜单误触」，
     而且它永远不消失。既然网页自己做得更准，就不要再画一条。 */
  var domUiReady = false;

  function ensureDomUi() {
    try {
      if (!document.body) return false;
      var wrap = q('#' + UI_WRAP_ID);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = UI_WRAP_ID;
        wrap.setAttribute('data-ltv', 'ui');

        /* 按钮排成一行：退出口 + 投屏。两者都必须「一定在、一定看得见」——
           原生层在部分机型（华为等）全屏时压根不上屏，1.1.5 那颗原生退出口
           就是这么消失的；投屏按钮同理，所以一起画进网页。 */
        var row = document.createElement('div');
        row.id = UI_ROW_ID;
        row.setAttribute('data-ltv', 'actions');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = UI_EXIT_ID;
        btn.textContent = '退出全屏';
        var onExit = function (e) {
          if (e) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
          }
          var fn = bridge('exitFullscreen');
          if (fn) { try { fn(); return; } catch (err) { } }
          /* 没有原生桥（纯浏览器打开）时退化为网页自己的退出 */
          try { window.__ltv.exit(); } catch (e2) { }
        };
        btn.addEventListener('click', onExit, true);
        row.appendChild(btn);

        /* 投屏：先在网页里把面板打开（用户立刻看到反应），再让原生去搜设备。
           之前只调 bridge('cast')，原生弹的是系统对话框 —— 播放态下这台设备
           的原生覆盖层不上屏，用户看到的就是「点了没反应」。 */
        var castBtn = document.createElement('button');
        castBtn.type = 'button';
        castBtn.id = UI_CAST_ID;
        castBtn.textContent = castLabel;
        castBtn.setAttribute('data-ltv', 'cast');
        var onCast = function (e) {
          if (e) {
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
          }
          try { window.__ltv.castShow(); return; } catch (e2) { }
          var fn = bridge('cast');
          if (fn) { try { fn(); return; } catch (err) { } }
          var lg = bridge('log');
          if (lg) { try { lg('网页内投屏入口不可用（没有原生桥）'); } catch (e3) { } }
        };
        castBtn.addEventListener('click', onCast, true);
        row.appendChild(castBtn);

        var playback = document.createElement('button');
        playback.type = 'button';
        playback.id = UI_PLAYBACK_ID;
        playback.textContent = '播放设置';
        playback.addEventListener('click', function (e) {
          stop(e);
          showPlaybackOptions();
        });
        row.appendChild(playback);

        wrap.appendChild(row);
        document.body.appendChild(wrap);
      }
      domUiReady = true;
      /* 告诉原生层「退出口已经由网页自己画了」，原生那颗就不再重复显示 */
      var fn2 = bridge('setDomUi');
      if (fn2) { try { fn2(true); } catch (e) { } }
      syncDomUi();
      return true;
    } catch (e) { return false; }
  }

  /** 全屏时显示左上「✕ 退出全屏」「投屏」，退出全屏立即隐藏。 */
  function syncDomUi() {
    var wrap = q('#' + UI_WRAP_ID);
    if (!wrap) return;
    var show = uiVisibleOverride === null ? isFullscreen() : !!uiVisibleOverride;
    var playback = q('#' + UI_PLAYBACK_ID);
    if (playback) playback.hidden = !vid();
    if (!show) closePlaybackOptions(true);
    wrap.style.display = show ? 'block' : 'none';
  }

  var playbackPanel = null;
  var playbackBackdrop = null;
  var playbackClosingNodes = [];
  var speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function finishAnimationWait(nodes, done) {
    if (prefersReducedMotion()) { done(); return; }
    var anims = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n && typeof n.getAnimations === 'function') {
        var list = n.getAnimations();
        for (var j = 0; j < list.length; j++) anims.push(list[j]);
      }
    }
    if (anims.length === 0) { done(); return; }
    var settled = false;
    var finish = function () { if (!settled) { settled = true; done(); } };
    var timer = setTimeout(finish, 200);
    Promise.all(anims.map(function (a) {
      return a.finished ? a.finished.catch(function () { }) : Promise.resolve();
    })).then(function () { clearTimeout(timer); finish(); }, function () { clearTimeout(timer); finish(); });
  }

  function flushClosingPlaybackNodes() {
    while (playbackClosingNodes.length) {
      var n = playbackClosingNodes.pop();
      try { if (n && n.parentNode) n.remove(); } catch (e) { }
    }
  }

  function closePlaybackOptions(immediate) {
    if (immediate) flushClosingPlaybackNodes();
    if (!playbackPanel) return;
    var panel = playbackPanel;
    var backdrop = playbackBackdrop;
    playbackPanel = null;
    playbackBackdrop = null;
    callBridge('playbackPanel', false);
    var trigger = q('#' + UI_PLAYBACK_ID);
    if (trigger && isFullscreen()) {
      try { trigger.focus({ preventScroll: true }); } catch (e) { }
    }
    wakeHud();
    if (immediate || prefersReducedMotion()) {
      try { if (panel && panel.parentNode) panel.remove(); } catch (e) { }
      try { if (backdrop && backdrop.parentNode) backdrop.remove(); } catch (e) { }
      return;
    }
    try { getComputedStyle(panel).opacity; } catch (e) { }
    panel.setAttribute('data-closing', '1');
    if (backdrop) backdrop.setAttribute('data-closing', '1');
    playbackClosingNodes.push(panel);
    if (backdrop) playbackClosingNodes.push(backdrop);
    finishAnimationWait([panel, backdrop], function () {
      try { if (panel && panel.parentNode) panel.remove(); } catch (e) { }
      try { if (backdrop && backdrop.parentNode) backdrop.remove(); } catch (e) { }
    });
  }

  function showPlaybackOptions() {
    closePlaybackOptions(true);
    var video = vid();
    if (!video) return;
    var panel = document.createElement('div');
    panel.id = 'ltv-playback-options';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '播放设置');
    playbackPanel = panel;
    wakeHud();
    function button(parent, label, action, active, keepOpen) {
      var el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      if (active !== undefined) el.setAttribute('aria-pressed', String(active));
      el.addEventListener('click', function (e) {
        stop(e);
        if (!keepOpen) closePlaybackOptions(false);
        action();
      });
      parent.appendChild(el);
      return el;
    }
    function row(label) {
      var title = document.createElement('h3');
      title.textContent = label;
      var buttons = document.createElement('div');
      buttons.className = 'ltv-option-grid';
      body.appendChild(title);
      body.appendChild(buttons);
      return buttons;
    }
    var heading = document.createElement('header');
    var title = document.createElement('h2');
    title.textContent = '播放设置';
    heading.appendChild(title);
    var close = button(heading, '关闭', function () { });
    panel.appendChild(heading);
    var watch = window.__ltvWatch;
    var actions = document.createElement('div');
    actions.className = 'ltv-option-grid ltv-playback-actions';
    if (watch) {
      button(actions, '切换线路', function () {
        var exit = bridge('exitFullscreen');
        if (exit) exit(); else window.__ltv.exit();
        watch.switchSource();
      });
    }
    if (bridge('requestPictureInPicture')) {
      button(actions, '画中画', function () { callBridge('requestPictureInPicture'); });
    }
    if (actions.childElementCount) panel.appendChild(actions);
    var body = document.createElement('div');
    body.className = 'ltv-options-body';
    panel.appendChild(body);
    var rates = row('倍速');
    speeds.forEach(function (rate) {
      button(rates, rate + '×', function () {
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;
        tempRateActive = false;
        tempRateSaved = rate;
        try { localStorage.setItem('ltv-playback-rate', String(rate)); } catch (e) { }
        Array.prototype.forEach.call(rates.children, function (item, i) {
          item.setAttribute('aria-pressed', String(speeds[i] === rate));
        });
      }, rate === video.playbackRate, true);
    });
    if (watch && watch.count > 0) {
      var epTitle = document.createElement('h3');
      epTitle.textContent = '选集（共 ' + watch.count + ' 集）';
      body.appendChild(epTitle);
      var episodes = document.createElement('div');
      episodes.className = 'ltv-option-grid ltv-episode-grid';
      if (watch.count >= 45) {
        var rangesWrap = document.createElement('div');
        rangesWrap.className = 'ltv-ep-ranges';
        rangesWrap.setAttribute('role', 'tablist');
        rangesWrap.setAttribute('aria-label', '选集分段');
        var chunk = 50;
        var rangeBtns = [];
        for (var start = 0; start < watch.count; start += chunk) {
          (function (sIdx, eIdx) {
            var rBtn = document.createElement('button');
            rBtn.type = 'button';
            rBtn.textContent = (sIdx + 1) + '-' + eIdx;
            var isCurRange = watch.index >= sIdx && watch.index < eIdx;
            rBtn.setAttribute('aria-pressed', String(isCurRange));
            rBtn.addEventListener('click', function (e) {
              stop(e);
              for (var k = 0; k < rangeBtns.length; k++) {
                rangeBtns[k].setAttribute('aria-pressed', String(rangeBtns[k] === rBtn));
              }
              var targetEp = episodes.children[sIdx];
              if (targetEp && targetEp.scrollIntoView) {
                try { targetEp.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
                catch (err) { targetEp.scrollIntoView(true); }
              }
            });
            rangeBtns.push(rBtn);
            rangesWrap.appendChild(rBtn);
          })(start, Math.min(watch.count, start + chunk));
        }
        body.appendChild(rangesWrap);
      }
      var frag = document.createDocumentFragment();
      for (var index = 0; index < watch.count; index++) {
        (function (episode) {
          button(frag, '第' + (episode + 1) + '集', function () {
            if (window.__ltvWatch === watch) watch.select(episode);
          }, episode === watch.index);
        })(index);
      }
      episodes.appendChild(frag);
      body.appendChild(episodes);
    }
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        stop(event);
        closePlaybackOptions(false);
      } else if (event.key === 'Tab') {
        var buttons = panel.querySelectorAll('button');
        var first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          stop(event); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          stop(event); first.focus();
        }
      }
    });
    playbackBackdrop = document.createElement('div');
    playbackBackdrop.className = 'ltv-playback-backdrop';
    playbackBackdrop.addEventListener('click', function (event) {
      stop(event);
      closePlaybackOptions(false);
    });
    q('#' + UI_WRAP_ID).appendChild(playbackBackdrop);
    q('#' + UI_WRAP_ID).appendChild(panel);
    callBridge('playbackPanel', true);
    close.focus({ preventScroll: true });
    var activeEp = panel.querySelector('.ltv-episode-grid button[aria-pressed="true"]');
    if (activeEp && activeEp.scrollIntoView && (!watch || watch.index > 0)) {
      try {
        requestAnimationFrame(function () {
          try { activeEp.scrollIntoView({ block: 'nearest' }); } catch (e) { }
        });
      } catch (e) { }
    }
  }

  // ---------------------------------------------------------------- 投屏面板（也画在网页里）
  /* 为什么要连结果面板一起画进网页：
     1.2.0 把投屏按钮画进 DOM 后就出过「点绿色投屏无任何反应」——按钮点了确实触发了，
     原生那边弹出的是 AlertDialog；而播放态下这台设备的原生覆盖层本来就不上屏
     （1.1.5 的退出口、1.2.0 的 castToggle 都栽在这），于是用户只看到「点了没反应」。
     结论：按钮在哪一层，结果就得在哪一层。设备搜索仍在原生（SSDP 组播要 socket），
     这里只负责显示状态、设备列表与回传点击。 */
  var CAST_ID = 'ltv-cast';
  var castPanelOpen = false;

  function stop(e) {
    if (!e) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
  }
  function el(id, cls, text) {
    var d = document.createElement('div');
    if (id) d.id = id;
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function ensureCastUi() {
    try {
      if (!document.body) return false;
      if (q('#' + CAST_ID)) return true;
      var wrap = el(CAST_ID);
      wrap.setAttribute('data-ltv', 'cast');

      var card = el('ltv-cast-card');
      var head = el('ltv-cast-head');
      head.appendChild(el('ltv-cast-title', null, '投屏到电视'));
      var close = el('ltv-cast-close', null, '✕');
      var onClose = function (e) { stop(e); window.__ltv.castHide(); };
      close.addEventListener('click', onClose, true);
      close.addEventListener('touchend', onClose, true);
      head.appendChild(close);
      card.appendChild(head);

      card.appendChild(el('ltv-cast-status', null, '正在准备…'));
      /* 遥控器区（暂停 / 快退快进 / 进度条）：只在 casting 态填充，其它状态清空 */
      card.appendChild(el('ltv-cast-controls'));
      card.appendChild(el('ltv-cast-list'));
      card.appendChild(el('ltv-cast-actions'));
      wrap.appendChild(card);

      /* 点蒙层空白处关闭 */
      var onBg = function (e) { if (e && e.target === wrap) window.__ltv.castHide(); };
      wrap.addEventListener('click', onBg, true);

      document.body.appendChild(wrap);
      return true;
    } catch (e) { return false; }
  }

  function castBtn(label, kind, onClick) {
    var cls = 'ltv-cast-btn2';
    if (kind === 'danger') cls += ' danger';
    else if (kind) cls += ' primary';
    var b = el(null, cls, label);
    var h = function (e) { stop(e); onClick(); };
    b.addEventListener('click', h, true);
    b.addEventListener('touchend', h, true);
    return b;
  }

  // ---------------------------------------------------------------- 投屏遥控器

  /** 秒 → mm:ss（超过 1 小时给 h:mm:ss） */
  function fmtT(sec) {
    var s = Math.max(0, Math.floor(seq(sec)));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var mm = (m < 10 ? '0' : '') + m;
    var tt = (ss < 10 ? '0' : '') + ss;
    return h > 0 ? h + ':' + mm + ':' + tt : mm + ':' + tt;
  }
  function seq(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }

  /** 只刷新进度条与时间文字，不重建面板（轮询每 2 秒都会来一次） */
  function syncCastSliderVars(bar, pos, dur) {
    if (!bar) return;
    var maxVal = Math.max(1, Number(bar.max) || Math.round(seq(dur)) || 1);
    var p = seq(pos);
    var pct = Math.max(0, Math.min(100, (p / maxVal) * 100));
    bar.style.setProperty('--slider-progress', pct.toFixed(2) + '%');
    bar.setAttribute('aria-valuetext', fmtT(p) + ' / ' + fmtT(seq(dur)));
  }

  function paintCastBar(pos, dur) {
    var bar = q('#ltv-cast-range');
    var lab = q('#ltv-cast-time');
    var d = seq(dur);
    if (bar && d > 0 && String(bar.max) !== String(Math.round(d))) {
      bar.max = String(Math.round(d));
    }
    var p = seq(pos);
    if (bar && !bar.__dragging) bar.value = String(Math.round(p));
    var shown = bar && bar.__dragging ? seq(bar.value) : p;
    if (bar) syncCastSliderVars(bar, shown, d);
    if (lab) {
      lab.textContent = fmtT(shown) + ' / ' + fmtT(d);
    }
  }

  function paintCastPlayBtn() {
    var btn = q('#ltv-cast-play');
    if (btn) btn.textContent = castPaused ? '▶' : '❚❚';
  }

  /** 电视端状态字符串 → 面板暂停态 */
  function syncCastState(state) {
    if (state === 'PAUSED_PLAYBACK' || state === 'PAUSED_RECORDING') castPaused = true;
    else if (state === 'PLAYING' || state === 'RECORDING') castPaused = false;
    paintCastPlayBtn();
  }

  /**
   * 两次轮询之间（2 秒一次）本地 4Hz 外推进度，滑块填充与时间流畅前进。
   * 暂停时不动；拿到新的上报值就以新值为准。
   */
  function startCastTick() {
    if (castTick) return;
    castTick = setInterval(function () {
      if (!castActive || !castPanelOpen) return;
      if (castPaused) return;
      if (!(castPosAt > 0) || !(castDur > 0)) return;
      var p = castPos + (Date.now() - castPosAt) / 1000;
      paintCastBar(p > castDur ? castDur : p, castDur);
    }, 250);
  }
  function stopCastTick() {
    if (castTick) { try { clearInterval(castTick); } catch (e) { } }
    castTick = null;
  }

  /** 下发跳转（秒）。没有桥时给出可读原因，不假装成功。 */
  function castSeekTo(sec) {
    var t = Math.max(0, Math.round(seq(sec)));
    castPos = t;
    castPosAt = Date.now();
    paintCastBar(t, castDur);
    var b = bridge('castSeek');
    if (!b) {
      var st = q('#ltv-cast-status');
      if (st) st.textContent = '客户端不支持调进度：请确认装的是 1.2.3 及以上版本';
      return false;
    }
    try { b(String(t)); return true; } catch (e) { return false; }
  }

  /** 暂停 / 继续：点一次只发一个确定的动作，失败由原生回写回滚 */
  function castTogglePlay() {
    var next = !castPaused;
    castPaused = next;
    paintCastPlayBtn();
    var b = bridge('castPause');
    if (!b) {
      castPaused = !next;
      paintCastPlayBtn();
      var st = q('#ltv-cast-status');
      if (st) st.textContent = '客户端不支持暂停控制：请确认装的是 1.2.3 及以上版本';
      return false;
    }
    try { b(next); return true; } catch (e) {
      castPaused = !next;
      paintCastPlayBtn();
      return false;
    }
  }

  /** 拼出遥控器区：进度条 + 快退 / 暂停 / 快进 */
  function buildCastControls() {
    var box = q('#ltv-cast-controls');
    if (!box) return;
    box.innerHTML = '';

    var bar = document.createElement('input');
    bar.type = 'range';
    bar.id = 'ltv-cast-range';
    bar.setAttribute('aria-label', '投屏播放进度');
    bar.min = '0';
    bar.max = String(Math.max(1, Math.round(seq(castDur) || 1)));
    bar.step = '1';
    bar.value = String(Math.round(seq(castPos)));
    syncCastSliderVars(bar, castPos, castDur);
    /* 拖动期间不让轮询回写覆盖用户的手指位置 */
    bar.addEventListener('input', function () {
      bar.__dragging = true;
      var cur = seq(bar.value);
      syncCastSliderVars(bar, cur, castDur);
      var lab = q('#ltv-cast-time');
      if (lab) lab.textContent = fmtT(cur) + ' / ' + fmtT(castDur);
    }, true);
    var commit = function () {
      bar.__dragging = false;
      castSeekTo(bar.value);
    };
    bar.addEventListener('change', commit, true);
    /* 部分 WebView 的 range 在 touchend 后才触发 change，补一道兜底（幂等） */
    bar.addEventListener('touchend', function () {
      if (bar.__dragging) commit();
    }, true);

    var line = el('ltv-cast-timeline');
    line.appendChild(bar);
    line.appendChild(el('ltv-cast-time', null, fmtT(castPos) + ' / ' + fmtT(castDur)));
    box.appendChild(line);

    var row = el('ltv-cast-ctrl');
    var back = el(null, 'ltv-cast-round', '−30s');
    var bh = function (e) { stop(e); castSeekTo(seq(castPos) - 30); };
    back.addEventListener('click', bh, true);
    back.addEventListener('touchend', bh, true);
    row.appendChild(back);

    var play = el('ltv-cast-play', 'ltv-cast-round big', castPaused ? '▶' : '❚❚');
    var ph = function (e) { stop(e); castTogglePlay(); };
    play.addEventListener('click', ph, true);
    play.addEventListener('touchend', ph, true);
    row.appendChild(play);

    var fwd = el(null, 'ltv-cast-round', '+30s');
    var fh = function (e) {
      stop(e);
      var target = seq(castPos) + 30;
      if (castDur > 0 && target > castDur) target = castDur;
      castSeekTo(target);
    };
    fwd.addEventListener('click', fh, true);
    fwd.addEventListener('touchend', fh, true);
    row.appendChild(fwd);

    box.appendChild(row);
    startCastTick();
  }

  /** 统一的渲染入口：state = scanning | list | casting | idle | error */
  function castRender(state, data) {
    ensureCastUi();
    var wrap = q('#' + CAST_ID);
    var st = q('#ltv-cast-status');
    var list = q('#ltv-cast-list');
    var acts = q('#ltv-cast-actions');
    var ctrl = q('#ltv-cast-controls');
    if (!wrap || !st || !list || !acts) return;
    list.innerHTML = '';
    acts.innerHTML = '';
    if (ctrl) ctrl.innerHTML = '';
    if (state !== 'casting') { castActive = false; stopCastTick(); }

    if (state === 'scanning') {
      st.textContent = '正在搜索同一 Wi-Fi 下的电视 / 盒子…（约 5 秒）';
      acts.appendChild(castBtn('重新搜索', true, function () {
        st.textContent = '正在重新搜索…';
        var b = bridge('cast'); if (b) { try { b(); } catch (e) { } }
      }));
      acts.appendChild(castBtn('系统屏幕镜像', false, function () {
        var b = bridge('castSystem'); if (b) { try { b(); } catch (e) { } }
      }));
    } else if (state === 'list') {
      var arr = data || [];
      st.textContent = arr.length
        ? '找到 ' + arr.length + ' 台设备，点一下开始投屏'
        : '没发现设备（见下方提示）';
      for (var i = 0; i < arr.length; i++) {
        (function (idx, name) {
          var row = el(null, 'ltv-cast-item', name);
          var h = function (e) {
            stop(e);
            var stEl = q('#ltv-cast-status');
            if (stEl) stEl.textContent = '正在投屏到 ' + name + '…';
            var b = bridge('castPick');
            if (b) { try { b(idx); } catch (err) { } }
          };
          row.addEventListener('click', h, true);
          row.addEventListener('touchend', h, true);
          list.appendChild(row);
        })(i, arr[i] && arr[i].name ? arr[i].name : ('设备 ' + (i + 1)));
      }
      acts.appendChild(castBtn('重新搜索', true, function () {
        var b = bridge('cast'); if (b) { try { b(); } catch (e) { } }
      }));
      acts.appendChild(castBtn('系统屏幕镜像', false, function () {
        var b = bridge('castSystem'); if (b) { try { b(); } catch (e) { } }
      }));
    } else if (state === 'casting') {
      castActive = true;
      castName = data || castName || '电视';
      st.textContent = (castPaused ? '已暂停 · ' : '正在投屏到 ') + castName;
      /* 遥控器：进度条 + −30s / 暂停继续 / +30s。这一块以前完全没有，
         所以用户投屏后既停不掉也控制不了 —— 现在把控制项补全在下发指令的两侧。 */
      buildCastControls();
      acts.appendChild(castBtn('停止投屏', 'danger', function () {
        /* 本地立刻收起遥控器，不等原生回调：SOAP 失败时可能要等 8 秒读超时 */
        castActive = false;
        castPaused = false;
        castPos = 0;
        castPosAt = 0;
        stopCastTick();
        var b = bridge('castStop');
        if (b) { try { b(); return; } catch (e) { } }
        castRender('idle', '已停止投屏（客户端未响应）');
      }));
      acts.appendChild(castBtn('同步手机进度', false, function () {
        var b = bridge('castSync'); if (b) { try { b(); } catch (e) { } }
      }));
      acts.appendChild(castBtn('切换电视', false, function () {
        var b = bridge('cast'); if (b) { try { b(); } catch (e) { } }
      }));
    } else if (state === 'idle') {
      castActive = false;
      castName = '';
      st.textContent = data || '已停止投屏';
      acts.appendChild(castBtn('重新搜索', true, function () {
        var b = bridge('cast'); if (b) { try { b(); } catch (e) { } }
      }));
      acts.appendChild(castBtn('系统屏幕镜像', false, function () {
        var b = bridge('castSystem'); if (b) { try { b(); } catch (e) { } }
      }));
    } else {
      st.textContent = data || '出错了';
      acts.appendChild(castBtn('重试', true, function () {
        var b = bridge('cast'); if (b) { try { b(); } catch (e) { } }
      }));
    }
    acts.appendChild(castBtn('关闭', false, function () { window.__ltv.castHide(); }));
  }

  function castShow(state, data) {
    ensureCastUi();
    var wrap = q('#' + CAST_ID);
    if (wrap) {
      wrap.removeAttribute('data-closing');
      wrap.style.display = 'flex';
      castPanelOpen = true;
    }
    wakeHud();
    /* 面板打开时手势层必须让开：整屏都可能被点到（设备行 / 按钮） */
    var cb = bridge('castPanel');
    if (cb) { try { cb(true); } catch (e) { } }
    castRender(state || 'scanning', data);
  }

  function castHide(immediate) {
    var wrap = q('#' + CAST_ID);
    castPanelOpen = false;
    /* 面板收起就停止本地外推：没必要在后台每秒算一次进度 */
    stopCastTick();
    var cb = bridge('castPanel');
    if (cb) { try { cb(false); } catch (e) { } }
    wakeHud();
    if (!wrap) return;
    if (immediate || prefersReducedMotion()) {
      wrap.removeAttribute('data-closing');
      wrap.style.display = 'none';
      return;
    }
    var card = q('#ltv-cast-card');
    try { getComputedStyle(wrap).opacity; } catch (e) { }
    wrap.setAttribute('data-closing', '1');
    finishAnimationWait([wrap, card], function () {
      if (!castPanelOpen) {
        wrap.removeAttribute('data-closing');
        wrap.style.display = 'none';
      }
    });
  }

  // ---------------------------------------------------------------- 样式
  function injectStyle() {
    if (q('#' + STYLE_ID)) return;
    var css = [
      /* --- 画面适配 ---
         竖屏（含竖屏全屏）一律 contain：竖屏容器又窄又高，cover 会把画面左右裁掉。
         只有横屏才按用户选择的 cover / fill 生效；竖向视频即使横屏也由 JS 降级为 contain。 */
      'video, .art-video video {',
      '  object-fit: contain !important;',
      '  width: 100% !important; height: 100% !important;',
      '  max-width: 100% !important;',
      '}',
      /* --- 方向相关规则统一放在样式表最末尾（见文件结尾）：
             同特异性 + 同为 !important 时「后出现者胜」，放前面会被基础规则反压。 */
      /* --- 进度条：只放大命中区，绝不改 .art-progress 的高度 ---
         .art-progress 是 .art-bottom（flex column）里的一整行，自带 padding 与
         translateY(--art-bottom-offset)。给它写死 height 会把这一行压成 8px，
         column 布局随之错位 —— 进度条整行被压进 .art-controls 按钮行，
         表现就是「进度条和控制菜单叠在一起，怎么都选不中」。
         粗细必须走 ArtPlayer 自己的变量 --art-progress-height。 */
      '.art-video-player { --art-progress-height: 8px !important; }',
      '.art-control-progress { min-height: 32px !important; position: relative !important; }',
      '.art-control-progress::before {',
      '  content: ""; position: absolute; left: 0; right: 0; top: -12px; bottom: -12px;',
      '}',
      '.art-control-progress .art-control-progress-inner {',
      '  height: 4px !important; border-radius: 999px !important;',
      '  background-color: rgba(255,255,255,0.24) !important;',
      '  transition: height 160ms cubic-bezier(0.22, 1, 0.36, 1) !important;',
      '}',
      '.art-control-progress:hover .art-control-progress-inner,',
      '.art-control-progress:active .art-control-progress-inner {',
      '  height: 6px !important;',
      '}',
      '.art-control-progress .art-control-progress-inner .art-progress-loaded {',
      '  background-color: rgba(255,255,255,0.40) !important; border-radius: inherit !important;',
      '}',
      '.art-control-progress .art-control-progress-inner .art-progress-played {',
      '  background: linear-gradient(90deg, #00c8f8 0%, #3b82f6 100%) !important; border-radius: inherit !important;',
      '}',
      '.art-progress-indicator {',
      '  width: 14px !important; height: 14px !important; border-radius: 50% !important;',
      '  background: #ffffff !important; border: 2px solid #00c8f8 !important;',
      '  box-shadow: 0 0 0 4px rgba(0,200,248,0.25), 0 2px 6px rgba(0,0,0,0.5) !important;',
      '  transition: transform 150ms cubic-bezier(0.22, 1, 0.36, 1) !important;',
      '}',
      '.art-control-progress:active .art-progress-indicator { transform: scale(1.22) !important; }',
      '.art-video-player .art-bottom { transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1) !important; }',
      '.art-video-player .art-bottom .art-controls, .art-video-player .art-bottom .art-progress {',
      '  transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1) !important;',
      '}',
      /* 迷你进度条态：LibreTV 在控制栏收起时给播放器加 art-mini-progress-bar，
         只留一条指示线。那时不能再用上面那套「撑高方便手指」的规则，
         否则底边会出现一条又厚又容易误跳进度的热区，还正好压在系统手势条上。 */
      '.art-video-player.art-mini-progress-bar { --art-progress-height: 5px !important; }',
      '.art-video-player.art-mini-progress-bar .art-control-progress { min-height: 0 !important; }',
      '.art-video-player.art-mini-progress-bar .art-control-progress .art-control-progress-inner {',
      '  height: 3px !important; border-radius: 0 !important;',
      '}',
      '.art-video-player.art-mini-progress-bar .art-control-progress::before { display: none !important; }',
      /* --- 控制按钮：全部状态放大触摸目标 --- */
      '.art-control { min-width: 48px !important; min-height: 48px !important; }',
      '.art-control-fullscreenWeb { min-width: 52px !important; min-height: 52px !important; }',
      '.art-bottom { padding-bottom: 6px !important; }',
      /* --- 全屏态：控件更大、避让挖孔与手势条 --- */
      '.art-fullscreen, .art-fullscreen-web {',
      '  --art-control-height: 68px !important;',
      '  --art-control-icon-scale: 1.5 !important;',
      '  --art-control-icon-size: 30px !important;',
      '  --art-progress-height: 10px !important;',
      '  --art-indicator-size: 18px !important;',
      '  --art-bottom-height: 68px !important;',
      '}',
      '.art-fullscreen .art-progress-indicator, .art-fullscreen-web .art-progress-indicator {',
      '  width: 18px !important; height: 18px !important;',
      '}',
      /* 网页控制栏交回 ArtPlayer 自己的「轻触显示 / 自动隐藏」。
         以前这里有一条 html.ltv-native-bar，把 .art-bottom / .art-controls 整体压掉，
         改由原生层画进度条与按钮。实测在部分机型（华为等）上原生覆盖层根本没上屏：
         全屏后既看不到进度条，也看不到退出口，而网页内容一切正常。
         现在网页栏是唯一控制栏，画面纯净由 ArtPlayer 自己的 3 秒自动隐藏完成。 */
      /* 只有用户主动按「网页」时，才把倍速 / 清晰度等控件强制常显出来。 */
      'html.ltv-web-controls .art-bottom, html.ltv-web-controls .art-controls {',
      '  opacity: 1 !important; visibility: visible !important;',
      '  pointer-events: auto !important;',
      '}',
      /* 原生面板展开时，网页底部整块（进度行 + 按钮行）让位，
         避免两层控制栏同时压在画面底部抢触摸。 */
      'html.ltv-panel .art-bottom, html.ltv-panel .art-controls {',
      '  opacity: 0 !important; visibility: hidden !important;',
      '  pointer-events: none !important;',
      '}',
      '.art-fullscreen .art-control, .art-fullscreen-web .art-control {',
      '  min-width: 54px !important; min-height: 54px !important;',
      '}',
      '.art-fullscreen .art-bottom, .art-fullscreen-web .art-bottom {',
      '  padding: 0 24px 16px 24px !important;',
      '}',
      /* 原生全屏按钮隐藏：避免 WebView 把播放器抽成 custom view */
      '.art-control-fullscreen { display: none !important; }',
      /* --- 网页全屏兜底：ArtPlayer 未就绪 / 版本差异时，客户端自己铺满 --- */
      'html.ltv-fs-manual .artplayer, html.ltv-fs-manual .art-video {',
      '  position: fixed !important; inset: 0 !important;',
      '  width: 100vw !important; height: 100vh !important;',
      '  z-index: 2147483000 !important; background: #000 !important;',
      '}',
      'html.ltv-fs, html.ltv-fs body, html.ltv-fs-manual, html.ltv-fs-manual body {',
      '  overflow: hidden !important;',
      '}',
      /* --- 横屏全屏：容器铺满整块屏幕，配合 cover 消除上下/左右黑边 --- */
      'html.ltv-fs .artplayer {',
      '  aspect-ratio: auto !important;',
      '  width: 100vw !important; max-width: none !important;',
      '  height: 100vh !important; max-height: none !important;',
      '  border-radius: 0 !important;',
      '}',
      'html.ltv-fs .art-video, html.ltv-fs .art-video video {',
      '  width: 100% !important; height: 100% !important;',
      '}',
      /* 播放页自带一个「跳过片头 / 片尾」浮层按钮：absolute + bottom-16(64px) + 居中 + z-10。
         全屏时 ArtPlayer 的 art-bottom 被我们压掉后，这个按钮就浮在最上层，
         正好落在原生面板的按钮行上 —— 看起来就是「控制菜单叠在一起、点不到进度条」。
         面板出现时把它抬到面板上方，收起时保持原位，不影响正常跳片头。 */
      'html.ltv-panel [class*="bottom-16"][class*="rounded-full"] {',
      '  bottom: 200px !important;',
      '}',
      /* --- 网页内兜底 UI：全屏退出口 + 细进度线 ---
         为什么画在网页 DOM 里而不是原生层：网页内容能正常显示，它就能正常显示。
         原生覆盖层一旦因为机型 / 合成原因不上屏，用户就彻底失去退出口与进度可视；
         放在 DOM 里与视频走同一条渲染路径，不存在这个问题。
         外层 pointer-events:none，只有按钮和进度条自己接收触摸，
         中间画面区域的触摸照旧穿透给播放器。 */
      '#ltv-ui { position: fixed !important; inset: 0 !important;',
      '  z-index: 2147483647 !important; pointer-events: none !important;',
      '  display: none; }',
      /* 按钮行：左上角，横排。安全区兜底 —— 横屏挖孔在左、竖屏刘海在上，
         env() 取不到时回落 0，不影响常规机型。 */
      '#ltv-top-actions { position: absolute !important; display: flex !important;',
      '  align-items: center !important; flex-wrap: wrap !important; gap: 8px !important;',
      '  max-width: calc(100vw - 82px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)) !important;',
      '  top: calc(12px + env(safe-area-inset-top, 0px)) !important;',
      '  left: calc(14px + env(safe-area-inset-left, 0px)) !important;',
      '  transition: opacity 320ms cubic-bezier(0.22, 1, 0.36, 1);',
      '  pointer-events: none !important; }',
      'html.ltv-fs[data-ltv-hud="idle"] #ltv-top-actions { opacity: 0.44; }',
      '#ltv-exit-btn, #ltv-cast-btn, #ltv-playback-btn { pointer-events: auto !important; cursor: pointer;',
      '  padding: 9px 14px !important; border-radius: 999px !important;',
      '  border: 1px solid rgba(186,214,255,0.22) !important;',
      '  background: rgba(15,22,36,0.74) !important; color: #f8fbff !important;',
      '  backdrop-filter: blur(16px) saturate(165%); -webkit-backdrop-filter: blur(16px) saturate(165%);',
      '  font: 500 13px/1.15 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif !important;',
      '  letter-spacing: .3px; white-space: nowrap; min-height: 44px;',
      '  box-shadow: 0 8px 22px rgba(0,0,0,.46), inset 0 1px 0 rgba(255,255,255,0.14);',
      '  transition: transform 0.16s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.2s ease, border-color 0.2s ease;',
      '  -webkit-user-select: none; user-select: none;',
      '}',
      '@keyframes ltvBackdropIn { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes ltvSheetOpacity { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes ltvSheetTransform { from { transform: translateX(-50%) translateY(18px) scale(0.96); } to { transform: translateX(-50%) translateY(0) scale(1); } }',
      '@keyframes ltvCardOpacity { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes ltvCardTransform { from { transform: translateY(16px) scale(0.95); } to { transform: translateY(0) scale(1); } }',
      '@keyframes ltvCastRadar {',
      '  0% { transform: scale(0.96); opacity: 0.78; }',
      '  75% { transform: scale(1.18, 1.32); opacity: 0; }',
      '  100% { transform: scale(1.18, 1.32); opacity: 0; }',
      '}',
      '#ltv-exit-btn:active, #ltv-cast-btn:active, #ltv-playback-btn:active,',
      '#ltv-playback-options button:active, .ltv-cast-btn2:active { transform: scale(0.95); }',
      '.ltv-playback-backdrop { pointer-events: auto; position: absolute; inset: 0;',
      '  background: rgba(5,9,17,0.62); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);',
      '  animation: ltvBackdropIn 180ms ease-out both; transition: opacity 170ms ease-out; }',
      '.ltv-playback-backdrop[data-closing="1"] { animation: none; opacity: 0; pointer-events: none !important; }',
      '#ltv-playback-options { pointer-events: auto; position: absolute; display: flex; flex-direction: column;',
      '  left: 50%; bottom: max(12px, env(safe-area-inset-bottom)); transform: translateX(-50%);',
      '  width: min(480px, calc(100vw - 24px)); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); box-sizing: border-box;',
      '  overflow: hidden; contain: layout style paint; padding: 14px; border: 1px solid rgba(148,185,255,0.22); border-radius: 18px;',
      '  background: rgba(14,21,34,0.90); color: #eef5ff;',
      '  backdrop-filter: blur(26px) saturate(175%); -webkit-backdrop-filter: blur(26px) saturate(175%);',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.72), inset 0 1px 0 rgba(255,255,255,0.12);',
      '  animation: ltvSheetOpacity 180ms ease-out both, ltvSheetTransform 260ms cubic-bezier(0.22, 1, 0.36, 1) both;',
      '  animation-timing-function: ease-out, linear(0, 0.42 14%, 0.86 32%, 1.035 54%, 0.994 78%, 1); }',
      '#ltv-playback-options[data-closing="1"] { animation: none; opacity: 0;',
      '  transform: translateX(-50%) translateY(16px) scale(0.96);',
      '  transition: opacity 170ms cubic-bezier(0.4, 0, 1, 1), transform 170ms cubic-bezier(0.4, 0, 1, 1);',
      '  pointer-events: none !important; }',
      '#ltv-playback-options header { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 8px;',
      '  padding-bottom: 6px; border-bottom: 1px solid rgba(148,185,255,0.12); }',
      '#ltv-playback-options h2, #ltv-playback-options h3 { color: inherit; margin: 0; font-weight: 600; }',
      '#ltv-playback-options h2 { font-size: 17px; letter-spacing: 0.2px; }',
      '#ltv-playback-options h3 { font-size: 13px; color: #9db2d1; margin: 12px 0 6px; }',
      '#ltv-playback-options .ltv-options-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding-right: 2px; }',
      '#ltv-playback-options .ltv-ep-ranges { display: flex; flex-wrap: nowrap; gap: 6px; overflow-x: auto;',
      '  scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; padding-bottom: 6px; margin-bottom: 6px; scrollbar-width: none; }',
      '#ltv-playback-options .ltv-ep-ranges::-webkit-scrollbar { display: none; }',
      '#ltv-playback-options .ltv-ep-ranges button { flex: 0 0 auto; scroll-snap-align: start; min-height: 32px;',
      '  padding: 4px 10px; font-size: 12px; border-radius: 999px; font-variant-numeric: tabular-nums; }',
      '#ltv-playback-options .ltv-option-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(64px,1fr)); gap: 7px; }',
      '#ltv-playback-options .ltv-playback-actions { flex: 0 0 auto; margin-top: 8px; margin-bottom: 6px; grid-template-columns: repeat(auto-fit,minmax(100px,1fr)); }',
      '#ltv-playback-options .ltv-episode-grid { grid-template-columns: repeat(auto-fill,minmax(84px,1fr)); }',
      '#ltv-playback-options button { font: inherit; border: 1px solid rgba(148,185,255,0.16); border-radius: 10px;',
      '  padding: 6px 8px; background: rgba(29,41,62,0.84); color: inherit; min-height: 44px;',
      '  transition: transform 0.14s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }',
      '#ltv-playback-options .ltv-episode-grid button { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '#ltv-playback-options button[aria-pressed="true"] {',
      '  background: linear-gradient(135deg, #00b8e6 0%, #2563eb 100%) !important;',
      '  border-color: rgba(125,211,252,0.65) !important; color: #ffffff !important; font-weight: 600;',
      '  box-shadow: 0 0 0 1px rgba(125,211,252,0.35), 0 6px 18px -4px rgba(0,184,230,0.45); }',
      '#ltv-playback-options button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }',
      'html.ltv-pip #ltv-ui, html.ltv-pip #ltv-cast, html.ltv-pip .art-bottom,',
      'html.ltv-pip .art-mask, html.ltv-pip .art-settings { visibility: hidden !important; }',
      /* 投屏用翡翠极光渐变：和「退出」区分开，也提示它是一个动作而不是返回 */
      '#ltv-cast-btn { position: relative; background: linear-gradient(135deg, rgba(16,185,129,0.92), rgba(5,150,105,0.92)) !important; border-color: rgba(167,243,208,0.34) !important; }',
      /* 投屏中：文字换成「投屏中」，带有合成器脉冲光环，暗示点进去是管理而不是重新搜设备 */
      '#ltv-cast-btn[data-casting="1"] { background: linear-gradient(135deg, rgba(5,150,105,0.95), rgba(4,120,87,0.95)) !important; border-color: rgba(110,231,183,0.58) !important; }',
      '#ltv-cast-btn[data-casting="1"]::after {',
      '  content: ""; position: absolute; inset: -3px; border-radius: 999px;',
      '  border: 2px solid rgba(52,211,153,0.72); pointer-events: none; opacity: 0;',
      '}',
      '@media (prefers-reduced-motion: no-preference) {',
      '  #ltv-cast-btn[data-casting="1"]::after { animation: ltvCastRadar 2.2s cubic-bezier(0.22, 1, 0.36, 1) infinite; }',
      '}',
      /* --- 投屏面板：与投屏按钮同一层（网页 DOM），不依赖原生覆盖层 ---
         层级与 #ltv-ui 相同、但插入在它之后：同 z-index 时「后出现者在上」，
         面板打开后蒙层正好盖住左上那两颗按钮，不会出现「点蒙层点到了退出全屏」。 */
      '#ltv-cast { position: fixed !important; inset: 0 !important;',
      '  z-index: 2147483647 !important; display: none; align-items: center; justify-content: center;',
      '  background: rgba(5,9,17,0.66) !important; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);',
      '  pointer-events: auto !important; transition: opacity 170ms ease-out;',
      '  font: 14px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif !important; }',
      '#ltv-cast[data-closing="1"] { opacity: 0; pointer-events: none !important; }',
      '#ltv-cast-card { width: min(88vw, 420px) !important; max-height: calc(100vh - 24px) !important; max-height: calc(100dvh - 24px) !important;',
      '  overflow-y: auto !important; contain: layout style paint; box-sizing: border-box; padding: 16px 16px 14px !important; border-radius: 18px !important;',
      '  border: 1px solid rgba(148,185,255,0.22) !important; background: rgba(14,21,34,0.92) !important; color: #eef5ff !important;',
      '  backdrop-filter: blur(26px) saturate(175%); -webkit-backdrop-filter: blur(26px) saturate(175%);',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.72), inset 0 1px 0 rgba(255,255,255,0.12); display: flex; flex-direction: column; gap: 10px;',
      '  animation: ltvCardOpacity 180ms ease-out both, ltvCardTransform 260ms cubic-bezier(0.22, 1, 0.36, 1) both;',
      '  animation-timing-function: ease-out, linear(0, 0.42 14%, 0.86 32%, 1.035 54%, 0.994 78%, 1); }',
      '#ltv-cast[data-closing="1"] #ltv-cast-card { animation: none; opacity: 0; transform: translateY(14px) scale(0.96);',
      '  transition: opacity 170ms cubic-bezier(0.4, 0, 1, 1), transform 170ms cubic-bezier(0.4, 0, 1, 1); }',
      '#ltv-cast-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;',
      '  padding-bottom: 6px; border-bottom: 1px solid rgba(148,185,255,0.12); }',
      '#ltv-cast-title { font-size: 16px !important; font-weight: 600 !important; letter-spacing: 0.2px; }',
      '#ltv-cast-close { width: 38px; height: 38px; line-height: 38px; text-align: center;',
      '  border-radius: 19px; background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,0.12);',
      '  color: #dbe6f5; font-size: 15px; cursor: pointer; transition: transform 0.15s ease, background-color 0.15s ease; }',
      '#ltv-cast-close:active { transform: scale(0.92); background: rgba(255,255,255,0.18); }',
      '#ltv-cast-status { flex: 0 0 auto; font-size: 12px !important; color: #9db2d1 !important; min-height: 17px;',
      '  word-break: break-word; }',
      '#ltv-cast-list { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow-y: auto;',
      '  max-height: 44vh; }',
      '.ltv-cast-item { padding: 12px 14px !important; border-radius: 12px !important;',
      '  background: rgba(29,41,62,0.85) !important; border: 1px solid rgba(148,185,255,0.16) !important;',
      '  color: #eef5ff !important; font-size: 14px !important; cursor: pointer;',
      '  transition: transform 0.15s ease, border-color 0.18s ease, background-color 0.18s ease; }',
      '.ltv-cast-item:active { background: rgba(38,56,84,0.95) !important; border-color: rgba(16,185,129,0.6) !important; transform: scale(0.98); }',
      '#ltv-cast-actions { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px; }',
      '.ltv-cast-btn2 { flex: 1 1 40%; min-width: 104px; padding: 11px 12px !important;',
      '  border-radius: 12px !important; background: rgba(34,47,70,0.88) !important;',
      '  border: 1px solid rgba(148,185,255,0.15) !important; color: #e8f1ff !important;',
      '  text-align: center; font-size: 13px !important; cursor: pointer;',
      '  transition: transform 0.15s ease, filter 0.18s ease; }',
      '.ltv-cast-btn2.primary { background: linear-gradient(135deg, #10b981, #059669) !important; border-color: rgba(167,243,208,0.3) !important; color: #fff !important; font-weight: 600; }',
      /* 停止投屏用红色：与「关闭 / 切换」拉开，误触代价最高的一颗不能长得像普通按钮 */
      '.ltv-cast-btn2.danger { background: linear-gradient(135deg, #ef4444, #dc2626) !important; border-color: rgba(254,202,202,0.3) !important; color: #fff !important; font-weight: 600; }',
      /* --- 投屏遥控器：进度条 + 快退 / 暂停继续 / 快进 --- */
      '#ltv-cast-controls { flex: 0 0 auto; display: flex; flex-direction: column; gap: 10px;',
      '  padding: 10px; border-radius: 12px; background: rgba(9,14,24,0.52); border: 1px solid rgba(148,185,255,0.12); }',
      /* 非 casting 态时这块是空的，:empty 把 flex gap 也一并去掉 */
      '#ltv-cast-controls:empty { display: none; }',
      '#ltv-cast-timeline { display: flex; align-items: center; gap: 8px; }',
      /* input[type=range] 必须清掉原生外观，否则安卓 WebView 画成一条细线、拇指点不到 */
      '#ltv-cast-range {',
      '  --slider-track-size: 6px; --slider-thumb-size: 18px; --slider-progress: 0%;',
      '  -webkit-appearance: none; appearance: none; flex: 1 1 auto;',
      '  height: 34px; margin: 0; padding: 0; border: 0; background: transparent;',
      '  cursor: pointer; pointer-events: auto;',
      '}',
      '#ltv-cast-range:focus-visible { outline: 2px solid #34d399; outline-offset: 4px; border-radius: 6px; }',
      '#ltv-cast-range::-webkit-slider-runnable-track { height: var(--slider-track-size); border: 0; border-radius: 999px;',
      '  background: linear-gradient(90deg, #10b981 0%, #00c8f8 var(--slider-progress), rgba(255,255,255,0.18) var(--slider-progress)); }',
      '#ltv-cast-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;',
      '  width: var(--slider-thumb-size); height: var(--slider-thumb-size);',
      '  margin-block-start: calc((var(--slider-track-size) - var(--slider-thumb-size)) / 2);',
      '  border-radius: 50%; background: #ffffff; border: 2px solid #10b981;',
      '  box-shadow: 0 0 0 4px rgba(16,185,129,0.28), 0 2px 8px rgba(0,0,0,0.45);',
      '  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1); }',
      '#ltv-cast-range:active::-webkit-slider-thumb { transform: scale(1.18); }',
      '#ltv-cast-range::-moz-range-track { height: var(--slider-track-size); border: 0; border-radius: 999px; background: rgba(255,255,255,0.18); }',
      '#ltv-cast-range::-moz-range-progress { height: var(--slider-track-size); border-radius: 999px; background: linear-gradient(90deg, #10b981, #00c8f8); }',
      '#ltv-cast-range::-moz-range-thumb { width: var(--slider-thumb-size); height: var(--slider-thumb-size); border: 2px solid #10b981; border-radius: 50%; background: #ffffff; }',
      '#ltv-cast-time { font-size: 11px !important; color: #9db2d1 !important;',
      '  white-space: nowrap; font-variant-numeric: tabular-nums; }',
      '#ltv-cast-ctrl { display: flex; align-items: center; justify-content: center; gap: 14px; }',
      '.ltv-cast-round { min-width: 64px; height: 42px; line-height: 42px; text-align: center;',
      '  border-radius: 21px; background: rgba(34,47,70,0.92) !important; border: 1px solid rgba(148,185,255,0.18) !important;',
      '  color: #e8f1ff !important; font-size: 13px !important; cursor: pointer;',
      '  transition: transform 0.14s ease, filter 0.15s ease;',
      '  -webkit-user-select: none; user-select: none; }',
      '.ltv-cast-round.big { min-width: 76px; height: 50px; line-height: 50px; border-radius: 25px;',
      '  background: linear-gradient(135deg, #10b981, #059669) !important; border-color: rgba(167,243,208,0.35) !important;',
      '  color: #fff !important; font-size: 17px !important; box-shadow: 0 8px 20px -4px rgba(16,185,129,0.5); }',
      '.ltv-cast-round:active { transform: scale(0.93); filter: brightness(1.16); }',
      /* ================= 方向规则（必须在最后，靠「后出现者胜」压住上面所有基础规则） ================= */
      '@media (orientation: portrait) {',
      '  html video, html .art-video video { object-fit: contain !important; }',
      /* ArtPlayer 的结构：.art-bottom 是铺满播放器的 flex column，
         里面 .art-progress 一行（进度条）、.art-controls 一行（按钮），
         天然上下排列不会互相压。之前「叠在一起」的真正原因有两层：
         一是给 .art-progress 写死了 height 把 column 压塌（已撤），
         二是网页栏与客户端原生控制层同时可见（原生层已退出，见 #ltv-ui 说明）。
         竖屏这里只做两件事：把 46px/36px 的按钮在窄屏收小；隐藏竖屏没用的图标。 */
      '  html .art-video-player {',
      '    --art-control-height: 38px !important;',
      '    --art-control-icon-size: 22px !important;',
      '    --art-progress-height: 5px !important;',
      '    --art-indicator-size: 13px !important;',
      '  }',
      '  html .art-control-volume, html .art-control-pip,',
      '  html .art-control-screenshot { display: none !important; }',
      '  html .art-bottom { padding-left: 6px !important; padding-right: 6px !important; }',
      '  html .art-control-time { font-size: 11px !important; }',
      '  html .art-control-progress { min-height: 28px !important; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  #ltv-playback-options, #ltv-cast-card, #ltv-cast-btn[data-casting="1"]::after,',
      '  .ltv-playback-backdrop { animation: none !important; }',
      '  #ltv-playback-options[data-closing="1"], .ltv-playback-backdrop[data-closing="1"],',
      '  #ltv-cast[data-closing="1"], #ltv-cast[data-closing="1"] #ltv-cast-card { transition: none !important; }',
      '  #ltv-exit-btn:active, #ltv-cast-btn:active, #ltv-playback-btn:active,',
      '  #ltv-playback-options button:active, .ltv-cast-btn2:active,',
      '  .ltv-cast-round:active, #ltv-cast-close:active, .ltv-cast-item:active,',
      '  .art-control-progress:active .art-progress-indicator, #ltv-cast-range:active::-webkit-slider-thumb { transform: none !important; }',
      '}',
      '@media (orientation: landscape) {',
      '  html[data-ltv-fit="cover"] video,',
      '  html[data-ltv-fit="cover"] .art-video video { object-fit: cover !important; }',
      '  html[data-ltv-fit="fill"] video,',
      '  html[data-ltv-fit="fill"] .art-video video { object-fit: fill !important; }',
      '}'
    ].join('\n');
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------------------------------------------------------------- 视频绑定 / 进度上报
  function reportProgress(force) {
    var v = vid();
    var fn = bridge('onProgress');
    if (!v || !fn) return;
    var now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    try {
      fn(isFinite(v.currentTime) ? v.currentTime : 0,
         isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
    } catch (e) { }
  }

  function bindVideo() {
    var v = vid();
    if (!v || v.__ltvBound) return;
    v.__ltvBound = true;
    function restoreRate() {
      if (tempRateActive) return;
      try {
        var rate = Number(localStorage.getItem('ltv-playback-rate'));
        if (speeds.indexOf(rate) !== -1) {
          v.defaultPlaybackRate = rate;
          v.playbackRate = rate;
        }
      } catch (e) { }
    }
    restoreRate();
    v.addEventListener('loadedmetadata', restoreRate);
    var handler = function () { reportProgress(false); };
    ['timeupdate', 'durationchange', 'loadedmetadata', 'play', 'seeked', 'pause']
      .forEach(function (ev) { try { v.addEventListener(ev, handler); } catch (e) { } });
    reportProgress(true);
  }

  function check() {
    /* 样式表可能被 SPA 路由切换整段重建掉。这里做一次存在性检查（单次 getElementById，
       开销可忽略），不存在才补注入 —— 替代过去由 MutationObserver 承担的那部分职责。 */
    injectStyle();
    var v = vid();
    var has = !!v;
    if (has !== lastVideo) {
      lastVideo = has;
      if (!has) tempRateActive = false;
      var fn = bridge('onVideo');
      if (fn) { try { fn(has); } catch (e) { } }
    }
    if (has) {
      bindVideo();
      /* 非 HLS 的 mp4 直连：video.src 就是可投屏地址 */
      try {
        var src = v.getAttribute('src') || v.src || '';
        if (src && String(src).indexOf('blob:') !== 0) reportStream(src);
      } catch (e) { }
    }

    var on = isFullscreen();
    if (on !== lastState) {
      lastState = on;
      notify(on);
      try {
        if (on) {
          document.documentElement.classList.add('ltv-fs');
          wakeHud();
        } else {
          document.documentElement.classList.remove('ltv-fs');
          if (hudIdleTimer) { clearTimeout(hudIdleTimer); hudIdleTimer = null; }
          document.documentElement.removeAttribute('data-ltv-hud');
        }
      } catch (e) { }
      /* 把网页侧判断写进日志中心：下次若还有人「全屏里什么都没有」，
         这一行会直接说明是网页没判定成全屏，还是原生层没收到。 */
      var lg = bridge('log');
      if (lg) {
        try {
          lg('全屏判定=' + on + ' native=' + nativeFullscreen() + ' manual=' + manualFullscreen() +
             ' webClass=' + !!q('.art-fullscreen-web, .art-fullscreen') +
             ' video=' + !!vid() + ' exitBtn=' + !!q('#' + UI_EXIT_ID));
        } catch (e) { }
      }
    }

    /* 全屏状态每次 check 都校正一次网页内兜底 UI：
       全屏 -> 显示左上「✕ 退出全屏」，并在 ArtPlayer 控制栏未显示时顶出细进度线。
       这两样都在网页 DOM 里，只要页面能渲染就一定看得见。 */
    ensureDomUi();
    syncDomUi();
  }

  // ---------------------------------------------------------------- 全屏接管
  document.addEventListener('click', function (e) {
    var webToggle = upClass(e.target, 'art-control-fullscreenWeb');
    if (webToggle) {
      try { requestAnimationFrame(check); } catch (err) { }
      setTimeout(check, 40);
      return;
    }
    var btn = upClass(e.target, 'art-control-fullscreen');
    if (!btn) return;
    if (nativeFullscreen() || q('.art-fullscreen')) return;
    var webBtn = q('.art-control-fullscreenWeb');
    if (!webBtn) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.stopPropagation) e.stopPropagation();
    webBtn.click();
    try { requestAnimationFrame(check); } catch (err) { }
    setTimeout(check, 40);
  }, true);

  document.addEventListener('pointerdown', function (e) {
    if (isFullscreen() && (e.target.closest && (e.target.closest('#ltv-top-actions') || e.target.closest('.art-bottom')))) {
      wakeHud();
    }
  }, { capture: true, passive: true });

  function onFullscreenChange() {
    if (nativeFullscreen()) {
      var d = document;
      try {
        var exit = d.exitFullscreen || d.webkitExitFullscreen || d.webkitCancelFullScreen;
        if (exit) exit.call(d);
      } catch (err) { }
      var webBtn = q('.art-control-fullscreenWeb');
      if (webBtn) setTimeout(function () { webBtn.click(); }, 90);
    }
    setTimeout(check, 150);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ---------------------------------------------------------------- 原生控制 API
  window.__ltv = {
    closePlaybackOptions: function () { closePlaybackOptions(false); },
    wakeHud: wakeHud,
    setTempRate: function (active) {
      var v = vid();
      if (active) {
        if (!tempRateActive) {
          var saved = NaN;
          try { saved = Number(localStorage.getItem('ltv-playback-rate')); } catch (e) { }
          tempRateSaved = speeds.indexOf(saved) !== -1 ? saved : (v && isFinite(v.playbackRate) ? v.playbackRate : 1);
          tempRateActive = true;
        }
        if (v) v.playbackRate = 2;
        return '2';
      }
      var backRate = tempRateSaved;
      try {
        var stored = Number(localStorage.getItem('ltv-playback-rate'));
        if (speeds.indexOf(stored) !== -1) backRate = stored;
      } catch (e) { }
      if (!(backRate > 0)) backRate = 1;
      tempRateActive = false;
      if (v) {
        v.defaultPlaybackRate = backRate;
        v.playbackRate = backRate;
      }
      return String(backRate);
    },
    setPip: function (active) {
      document.documentElement.classList.toggle('ltv-pip', !!active);
      if (active) closePlaybackOptions(true);
    },
    /** 一键进入全屏：优先用 ArtPlayer 网页全屏，失败则客户端 CSS 铺满 */
    enter: function () {
      if (isFullscreen()) { check(); try { requestAnimationFrame(check); } catch (e) { } return 'already'; }
      var webBtn = q('.art-control-fullscreenWeb');
      if (webBtn) {
        try { webBtn.click(); } catch (e) { }
        check();
        try { requestAnimationFrame(check); } catch (e) { }
        setTimeout(check, 120);
        setTimeout(check, 400);
        return 'web';
      }
      try {
        document.documentElement.classList.add('ltv-fs-manual');
        document.documentElement.classList.add('ltv-fs');
      } catch (e) { }
      notify(true);
      check();
      try { requestAnimationFrame(check); } catch (e) { }
      return 'manual';
    },
    exit: function () {
      var webBtn = q('.art-control-fullscreenWeb');
      if (q('.art-fullscreen-web') && webBtn) {
        try { webBtn.click(); } catch (e) { }
      }
      if (manualFullscreen()) {
        try {
          document.documentElement.classList.remove('ltv-fs-manual');
          document.documentElement.classList.remove('ltv-fs');
        } catch (e) { }
      }
      if (nativeFullscreen()) {
        try {
          var exit = document.exitFullscreen || document.webkitExitFullscreen ||
                     document.webkitCancelFullScreen;
          if (exit) exit.call(document);
        } catch (err) { }
      }
      var nativeBtn = q('.art-control-fullscreen');
      if (q('.art-fullscreen') && nativeBtn && !q('.art-fullscreen-web')) {
        try { nativeBtn.click(); } catch (e) { }
      }
      check();
      try { requestAnimationFrame(check); } catch (e) { }
      setTimeout(check, 120);
      setTimeout(check, 450);
      return 'ok';
    },
    toggleFs: function () {
      return isFullscreen() ? window.__ltv.exit() : window.__ltv.enter();
    },
    seek: function (delta) {
      var v = vid();
      if (!v) return 'novideo';
      var max = isFinite(v.duration) && v.duration > 0 ? v.duration : v.currentTime + delta;
      v.currentTime = Math.max(0, Math.min(max, v.currentTime + delta));
      reportProgress(true);
      return 'ok';
    },
    /** 原生 SeekBar 松手后精确跳转 */
    seekTo: function (sec) {
      var v = vid();
      if (!v) return 'novideo';
      var t = Number(sec);
      if (!isFinite(t) || t < 0) return 'bad';
      var max = isFinite(v.duration) && v.duration > 0 ? v.duration : t;
      v.currentTime = Math.min(max, t);
      reportProgress(true);
      return 'ok';
    },
    toggle: function () {
      var v = vid();
      if (!v) return 'novideo';
      if (v.paused) {
        var p = v.play();
        if (p && p.catch) p.catch(function () { });
        wakeHud();
        return 'playing';
      }
      v.pause();
      wakeHud();
      return 'paused';
    },
    /** 仅让 ArtPlayer 自己的控制栏显示一次；不切换任何全屏互斥状态。 */
    showControls: function () {
      if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
      var player = q('.art-video-player');
      if (player && player.classList) {
        player.classList.add('art-control-show');
        player.classList.remove('art-mini-progress-bar');
      }
      ['.art-bottom', '.art-controls'].forEach(function (sel) {
        var el = q(sel);
        if (el && el.classList) el.classList.add('art-control-show');
      });
      wakeHud();
      return 'ok';
    },
    /** 轻触画面平滑切换底部控制条与顶栏 HUD；未锁定时 4 秒自动回落为极简状态。 */
    toggleControls: function () {
      var player = q('.art-video-player');
      var shown = !!(player && player.classList.contains('art-control-show')
        && !player.classList.contains('art-mini-progress-bar'));
      if (controlsHideTimer) { clearTimeout(controlsHideTimer); controlsHideTimer = null; }
      if (shown) {
        if (player && player.classList) {
          player.classList.remove('art-control-show');
          player.classList.add('art-mini-progress-bar');
        }
        ['.art-bottom', '.art-controls'].forEach(function (sel) {
          var el = q(sel);
          if (el && el.classList) el.classList.remove('art-control-show');
        });
        wakeHud();
        return 'hidden';
      }
      window.__ltv.showControls();
      if (!webControlsWanted) {
        controlsHideTimer = setTimeout(function () {
          controlsHideTimer = null;
          if (!webControlsWanted && !playbackPanel && !castPanelOpen) {
            var p = q('.art-video-player');
            if (p && p.classList) {
              p.classList.remove('art-control-show');
              p.classList.add('art-mini-progress-bar');
            }
            ['.art-bottom', '.art-controls'].forEach(function (sel) {
              var el = q(sel);
              if (el && el.classList) el.classList.remove('art-control-show');
            });
          }
        }, 4000);
      }
      return 'shown';
    },
    /**
     * 兼容旧调用。以前这里会把网页控制栏整体压掉（ltv-native-bar）、由原生层接管，
     * 但原生覆盖层在部分机型上不上屏 —— 全屏后既没进度条也没退出口。
     * 现在网页栏是唯一控制栏，这里只做状态清理，不再隐藏任何东西。
     */
    setNativeBar: function (on) {
      webControlsWanted = false;
      try {
        var cl = document.documentElement.classList;
        cl.remove('ltv-native-bar');
        cl.remove('ltv-web-controls');
      } catch (e) { }
      return on ? 'on' : 'off';
    },
    /** 「网页」按钮：收起原生条，把倍速 / 清晰度等网页设置控件放出来。 */
    showWebControls: function () {
      webControlsWanted = true;
      try {
        var cl = document.documentElement.classList;
        cl.remove('ltv-native-bar');
        cl.add('ltv-web-controls');
      } catch (e) { }
      var player = q('.art-video-player');
      if (player && player.classList) {
        player.classList.add('art-control-show');
        player.classList.remove('art-mini-progress-bar');
      }
      ['.art-bottom', '.art-controls'].forEach(function (sel) {
        var el = q(sel);
        if (el && el.classList) el.classList.add('art-control-show');
      });
      return 'ok';
    },
    /** 退出全屏 / 按返回键：撤掉所有覆盖样式，网页控制栏交回 ArtPlayer 自己管理。 */
    hideWebControls: function () {
      webControlsWanted = false;
      try {
        var cl = document.documentElement.classList;
        cl.remove('ltv-web-controls');
        cl.remove('ltv-native-bar');
      } catch (e) { }
      var player = q('.art-video-player');
      if (player && player.classList) {
        player.classList.remove('art-control-show');
        player.classList.add('art-mini-progress-bar');
      }
      ['.art-bottom', '.art-controls'].forEach(function (sel) {
        var el = q(sel);
        if (el && el.classList) el.classList.remove('art-control-show');
      });
      return 'ok';
    },
    /** 原生高级面板是否展开：网页里那些浮在底部的按钮要让开位置 */
    setPanel: function (on) {
      try {
        var cl = document.documentElement.classList;
        if (on) cl.add('ltv-panel');
        else cl.remove('ltv-panel');
      } catch (e) { }
      return on ? 'on' : 'off';
    },
    /** 画面模式：contain 等比适应 / cover 填满裁切 / fill 拉伸 */
    setFit: function (mode) {
      var arr = ['contain', 'cover', 'fill'];
      var m = arr.indexOf(mode) >= 0 ? mode : 'contain';
      try { document.documentElement.setAttribute('data-ltv-fit', m); } catch (e) { }
      return m;
    },
    /**
     * 左下按钮行（退出全屏 / 投屏）的可见性。
     * 传 null 回到「跟随全屏判定」的默认行为；传 true/false 由原生强制指定 ——
     * 原生进入播放态时用 true，避免某些机型全屏类名判不出来时按钮跟着消失。
     */
    setUiVisible: function (on) {
      uiVisibleOverride = (on === null || on === undefined) ? null : !!on;
      syncDomUi();
      return uiVisibleOverride === null ? 'auto' : (uiVisibleOverride ? 'on' : 'off');
    },
    /** 投屏按钮文案：投屏 / 投屏中（点进去是管理菜单） */
    setCast: function (label) {
      castLabel = label ? String(label) : '投屏';
      var el = q('#' + UI_CAST_ID);
      if (el) {
        el.textContent = castLabel;
        try { el.setAttribute('data-casting', castLabel.indexOf('中') >= 0 ? '1' : '0'); }
        catch (e) { }
      }
      return castLabel;
    },
    /** 打开投屏面板并开始搜索（用户点绿色「投屏」或原生入口都走这里） */
    castShow: function () {
      /* 已经在投屏：这颗按钮的语义变成「管理 / 遥控」，绝不能再搜一遍设备 ——
         以前无论什么状态都渲染 scanning，用户一点就看不到停止按钮了。 */
      if (castActive && castName) {
        castShow('casting', castName);
        var pb = bridge('castPoll');
        if (pb) { try { pb(true); } catch (e) { } }
        return 'casting';
      }
      castShow('scanning');
      var b = window[BRIDGE];
      /* cast 为主，castStart 是原生侧的同义入口（防止个别 WebView 对短名做特殊处理） */
      var fn = bridge('cast') || bridge('castStart');
      if (!fn) {
        /* 把诊断信息直接写在面板上，别再说「需要客户端环境」这种让人误解的话 */
        castRender('error', '找不到原生投屏接口'
          + (b ? '（LtvBridge 存在，但没有 cast 方法）' : '（LtvBridge 未注入）')
          + '：请确认装的是 1.2.2 及以上版本');
        return 'nobridge';
      }
      try {
        fn();
        return 'ok';
      } catch (e) {
        var msg = e && e.message ? e.message : String(e);
        var lg = bridge('log');
        if (lg) { try { lg('castShow 调用失败: ' + msg); } catch (e2) { } }
        castRender('error', '原生投屏接口调用失败：' + msg);
        return 'error';
      }
    },
    /** 原生回写状态文字（搜索进度 / 失败原因） */
    castStatus: function (text) {
      ensureCastUi();
      var st = q('#ltv-cast-status');
      if (st && text) st.textContent = String(text);
      return 'ok';
    },
    /** 原生回写设备列表：[{name:'客厅电视'}, …] */
    castDevices: function (json) {
      var arr = [];
      try { arr = typeof json === 'string' ? JSON.parse(json) : (json || []); }
      catch (e) { arr = []; }
      castRender('list', arr);
      return arr.length;
    },
    /** 原生回写整体状态：scanning / casting / idle / error */
    castState: function (state, data) {
      castRender(state || 'idle', data);
      return state || 'idle';
    },
    /** 原生回写暂停态（用户在电视遥控器上按了暂停也会同步过来） */
    castPaused: function (on) {
      castPaused = !!on;
      paintCastPlayBtn();
      var st = q('#ltv-cast-status');
      if (st && castActive && castName) {
        st.textContent = (castPaused ? '已暂停 · ' : '正在投屏到 ') + castName;
      }
      return castPaused ? 'paused' : 'playing';
    },
    /**
     * 原生轮询回写电视端真实进度（每 2 秒一次）：
     * pos / dur 单位秒，拿不到时传 -1；state 为 UPnP 的 CurrentTransportState。
     */
    castProgress: function (pos, dur, state) {
      var p = Number(pos), d = Number(dur);
      if (isFinite(p) && p >= 0) { castPos = p; castPosAt = Date.now(); }
      if (isFinite(d) && d > 0) castDur = d;
      if (state) syncCastState(String(state));
      paintCastBar(castPos, castDur);
      return 'ok';
    },
    /** 供原生 / 调试直接下发跳转（秒） */
    castSeek: function (sec) { return castSeekTo(sec) ? 'ok' : 'fail'; },
    castHide: function () { castHide(false); return 'ok'; },
    nextFit: function () {
      var arr = ['contain', 'cover', 'fill'];
      var cur = 'contain';
      try { cur = document.documentElement.getAttribute('data-ltv-fit') || 'contain'; }
      catch (e) { }
      var m = arr[(arr.indexOf(cur) + 1 + arr.length) % arr.length];
      window.__ltv.setFit(m);
      return m;
    },
    /** 供原生查询当前状态 */
    info: function () {
      var v = vid();
      return JSON.stringify({
        video: !!v,
        fullscreen: isFullscreen(),
        fit: (function () {
          try { return document.documentElement.getAttribute('data-ltv-fit') || 'contain'; }
          catch (e) { return 'contain'; }
        })(),
        current: v && isFinite(v.currentTime) ? v.currentTime : 0,
        duration: v && isFinite(v.duration) ? v.duration : 0,
        stream: streamUrl
      });
    },
    /** 投屏用：返回当前可投屏的视频直链（绝对地址），拿不到返回空串。 */
    castUrl: function () {
      var candidates = [];
      var v = vid();
      if (!v) return '';
      var watch = window.__ltvWatch;
      if (watch && watch.stream) candidates.push(watch.stream);
      /* 播放页 / 直播页 URL 参数：/watch?...&url=<直链> 或 /live?url=<频道地址> */
      try {
        if (/\/(watch|live)\/?$/.test(location.pathname)) {
          candidates.push(new URLSearchParams(location.search).get('url') || '');
        }
      } catch (e) { }
      /* ArtPlayer 实例（优先匹配当前 <video> 所属实例，但不抢占 watch.stream 与 URL 参数） */
      try {
        var el = q('.artplayer');
        if (el && el.art && el.art.url) candidates.push(el.art.url);
        if (window.Artplayer && window.Artplayer.instances) {
          var fallbackArt = [];
          for (var i = 0; i < window.Artplayer.instances.length; i++) {
            var inst = window.Artplayer.instances[i];
            if (inst && inst.url && (inst.video === v || (inst.template && inst.template.$video === v))) {
              candidates.push(inst.url);
            } else if (inst && inst.url) {
              fallbackArt.push(inst.url);
            }
          }
          for (var j = 0; j < fallbackArt.length; j++) candidates.push(fallbackArt[j]);
        }
      } catch (e) { }
      candidates.push(v.currentSrc || '', v.src || '');
      if (streamPage === location.href) candidates.push(streamUrl);
      for (var k = 0; k < candidates.length; k++) {
        var u = candidates[k];
        if (!u) continue;
        u = String(u);
        if (u.indexOf('blob:') === 0 || u.indexOf('data:') === 0) continue;
        try {
          var direct = castStreamUrl(u);
          if (direct) return direct;
        } catch (e2) { }
      }
      return '';
    },
    /** 投屏用：影片标题，用于电视上显示的 DIDL-Lite dc:title。 */
    castTitle: function () {
      try {
        var params = new URLSearchParams(location.search);
        var t = params.get('title') || params.get('name');
        if (t) return t;
      } catch (e) { }
      var h = q('h1');
      if (h && h.textContent && h.textContent.trim()) return h.textContent.trim();
      return 'LibreTV 投屏';
    }
  };

  // ---------------------------------------------------------------- 启动
  injectStyle();
  /* 默认 contain：完整显示画面，不裁切。
     之前默认 cover（铺满屏幕），16:9 的视频在 20:9 的横屏上按宽度撑满后高度溢出，
     表现就是「横排时画面上下被裁掉」。铺满改由「画面」按钮手动切 cover / fill。 */
  try {
    if (!document.documentElement.getAttribute('data-ltv-fit')) {
      document.documentElement.setAttribute('data-ltv-fit', 'contain');
    }
  } catch (e) { }
  window.addEventListener('resize', check);
  /* 曾经在这里挂过 MutationObserver：observe(document.documentElement,
     { subtree:true, childList:true, attributes:true, attributeFilter:['class'] })，
     回调里再调 check()。这是「用着用着整个页面卡死」的主因：
       - LibreTV 是 React 应用，每次渲染都产生大量 childList mutation；
       - ArtPlayer 播放时每帧都在切 art-control-show / art-hover / art-loading 类名；
       - 两者叠加让回调以「每秒几十次」的频率执行，而每次 check() 都要做多轮
         querySelector 并读写 documentElement 的 classList，等于持续占满渲染线程。
     全屏状态本来就不需要毫秒级感知：enter() 里已用 setTimeout 补了 100/400ms 两次，
     这里再用 1s 轮询兜底足够，且开销恒定、与页面 DOM 规模无关。 */
  setInterval(check, 1000);
  setTimeout(check, 100);
  check();
})();
