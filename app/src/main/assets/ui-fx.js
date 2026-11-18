/* ============================================================================
 * LibreTV 1.2.16 — Interactive Motion, View Transitions & Pointer Optics Engine
 * Idempotent & zero-dependency progressive enhancement for WebView and browsers.
 * ============================================================================ */
(function () {
  if (window.__ltvUiFxInstalled) return;
  window.__ltvUiFxInstalled = true;

  var HERO_NAME = 'ltv-poster-hero';
  var prefersReduced = function () {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  };
  var allowsMotion = function () {
    return !prefersReduced();
  };

  /* --------------------------------------------------------------------------
   * 1. Discrete display transition probe & helper (animate-element-entry-exit)
   * -------------------------------------------------------------------------- */
  var supportsDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (!window.CSS || typeof window.CSS.supports !== 'function'
        || !window.CSS.supports('transition-behavior', 'allow-discrete')
        || !document.body) {
      return false;
    }
    try {
      var probe = document.createElement('div');
      probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
      document.body.appendChild(probe);
      getComputedStyle(probe).display;
      probe.style.display = 'none';
      supportsDisplayTransition = getComputedStyle(probe).display === 'block';
      probe.remove();
    } catch (e) {
      supportsDisplayTransition = false;
    }
    return supportsDisplayTransition;
  }

  window.__ltvHideDiscrete = function (el, removeAfter) {
    if (!el) return Promise.resolve();
    if (canTransitionDisplay()) {
      el.hidden = true;
    } else {
      el.setAttribute('data-closing', '');
    }
    var anims = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
    var wait = anims.length > 0
      ? Promise.race([
          Promise.all(anims.map(function (a) {
            return a.finished ? a.finished.catch(function () {}) : Promise.resolve();
          })),
          new Promise(function (r) { setTimeout(r, 600); })
        ])
      : Promise.resolve();
    return wait.then(function () {
      if (el.hasAttribute('data-closing')) {
        el.removeAttribute('data-closing');
        el.hidden = true;
      }
      if (removeAfter && el.parentNode) el.remove();
    });
  };

  /* --------------------------------------------------------------------------
   * 2. Same-Document View Transition for Theme Circular Reveal
   * -------------------------------------------------------------------------- */
  window.__ltvThemeTransition = function (ev, applyFn) {
    if (typeof applyFn !== 'function') return;
    if (!document.startViewTransition || prefersReduced()) {
      applyFn();
      return;
    }
    try {
      var x = window.innerWidth - 32;
      var y = 28;
      if (ev && typeof ev.clientX === 'number' && (ev.clientX > 0 || ev.clientY > 0)) {
        x = ev.clientX;
        y = ev.clientY;
      } else if (ev && ev.currentTarget && ev.currentTarget.getBoundingClientRect) {
        var rect = ev.currentTarget.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      var maxR = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );
      var root = document.documentElement;
      root.style.setProperty('--ltv-vt-x', Math.round(x) + 'px');
      root.style.setProperty('--ltv-vt-y', Math.round(y) + 'px');
      root.style.setProperty('--ltv-vt-r', Math.ceil(maxR + 12) + 'px');
      root.setAttribute('data-ltv-vt', 'theme');

      var vt = document.startViewTransition(function () {
        applyFn();
        return Promise.resolve();
      });
      var clean = function () {
        root.removeAttribute('data-ltv-vt');
      };
      if (vt && vt.finished && typeof vt.finished.finally === 'function') {
        vt.finished.finally(clean);
      } else {
        setTimeout(clean, 550);
      }
    } catch (e) {
      document.documentElement.removeAttribute('data-ltv-vt');
      applyFn();
    }
  };

  /* --------------------------------------------------------------------------
   * 3. Shared Poster Naming Cleanup & Dialog Accessibility Focus Routing
   * -------------------------------------------------------------------------- */
  function clearHeroNames() {
    try {
      var nodes = document.querySelectorAll('[data-ltv-hero="1"]');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].style.viewTransitionName = '';
        nodes[i].removeAttribute('data-ltv-hero');
      }
    } catch (e) {}
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target && ev.target.closest ? ev.target : null;
    if (!target) return;
    var card = target.closest('.card');
    if (card) {
      clearHeroNames();
      var img = card.querySelector('img');
      if (img) {
        img.style.viewTransitionName = HERO_NAME;
        img.setAttribute('data-ltv-hero', '1');
        setTimeout(clearHeroNames, 700);
      }
    }
  }, true);

  function routeDialogFocus(dialog) {
    if (!dialog || dialog.__ltvFocused) return;
    dialog.__ltvFocused = true;
    try {
      var heading = dialog.querySelector('h1, h2, h3');
      var dest = heading || dialog;
      if (dest && !dest.hasAttribute('tabindex')) {
        dest.setAttribute('tabindex', '-1');
      }
      if (dest && typeof dest.focus === 'function') {
        requestAnimationFrame(function () {
          try { dest.focus({ preventScroll: true }); } catch (e) {}
        });
      }
    } catch (e) {}
  }

  /* --------------------------------------------------------------------------
   * 4. Pointer 3D Tilt & Specular Spotlight + Touch Ripple Feedback
   * -------------------------------------------------------------------------- */
  var activeCard = null;
  var tiltRaf = 0;
  var nextRx = 0;
  var nextRy = 0;
  var nextGx = '50%';
  var nextGy = '25%';

  function flushTilt() {
    tiltRaf = 0;
    if (!activeCard) return;
    activeCard.style.setProperty('--ltv-rx', nextRx.toFixed(2) + 'deg');
    activeCard.style.setProperty('--ltv-ry', nextRy.toFixed(2) + 'deg');
    activeCard.style.setProperty('--ltv-gx', nextGx);
    activeCard.style.setProperty('--ltv-gy', nextGy);
  }

  function resetCardTilt(card) {
    if (!card) return;
    card.style.removeProperty('--ltv-rx');
    card.style.removeProperty('--ltv-ry');
    card.style.removeProperty('--ltv-gx');
    card.style.removeProperty('--ltv-gy');
  }

  document.addEventListener('pointermove', function (ev) {
    if (!allowsMotion()) return;
    if (document.documentElement.classList.contains('ltv-fs')) return;
    if (ev.pointerType && ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') return;
    var target = ev.target && ev.target.closest ? ev.target : null;
    var card = target ? target.closest('.card.cursor-pointer') : null;
    if (activeCard && activeCard !== card) {
      resetCardTilt(activeCard);
      activeCard = null;
    }
    if (!card) return;
    activeCard = card;
    var r = card.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    var px = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    var py = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
    nextRy = (px - 0.5) * 9;
    nextRx = (0.5 - py) * 9;
    nextGx = Math.round(px * 100) + '%';
    nextGy = Math.round(py * 100) + '%';
    if (!tiltRaf) tiltRaf = requestAnimationFrame(flushTilt);
  }, { passive: true });

  document.addEventListener('pointerleave', function () {
    if (activeCard) {
      resetCardTilt(activeCard);
      activeCard = null;
    }
  }, { passive: true });

  document.addEventListener('pointerdown', function (ev) {
    if (!allowsMotion()) return;
    var target = ev.target && ev.target.closest ? ev.target : null;
    if (!target) return;
    var btn = target.closest('.btn, .btn-primary, .btn-ghost, .chip, button[role="tab"], section[aria-label] button:not(.card *)');
    if (!btn || btn.disabled) return;
    try {
      var rect = btn.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var size = Math.max(rect.width, rect.height);
      var ripple = document.createElement('span');
      ripple.className = 'ltv-ripple';
      ripple.style.width = size + 'px';
      ripple.style.height = size + 'px';
      ripple.style.left = (ev.clientX - rect.left) + 'px';
      ripple.style.top = (ev.clientY - rect.top) + 'px';
      btn.appendChild(ripple);
      var cleanRipple = function () {
        if (ripple.parentNode) ripple.remove();
      };
      var anims = typeof ripple.getAnimations === 'function' ? ripple.getAnimations() : [];
      if (anims.length > 0 && anims[0].finished) {
        anims[0].finished.then(cleanRipple, cleanRipple);
      } else {
        setTimeout(cleanRipple, 500);
      }
    } catch (e) {}
  }, { passive: true });

  /* --------------------------------------------------------------------------
   * 5. Fallbacks for Scroll Header & View-Timeline Cards + Dialog Focus Observer
   * -------------------------------------------------------------------------- */
  var supportsScrollTimeline = false;
  var supportsViewTimeline = false;
  try {
    supportsScrollTimeline = !!(window.CSS && CSS.supports && CSS.supports('(animation-timeline: scroll()) and (animation-range: 0% 100%)'));
    supportsViewTimeline = !!(window.CSS && CSS.supports && CSS.supports('(animation-timeline: view()) and (animation-range: entry)'));
  } catch (e) {}

  function syncScrolledHeader() {
    var hdr = document.querySelector('header.sticky.top-0');
    if (!hdr) return;
    if (window.scrollY > 14) hdr.setAttribute('data-scrolled', '1');
    else hdr.removeAttribute('data-scrolled');
  }

  if (!supportsScrollTimeline) {
    window.addEventListener('scroll', syncScrolledHeader, { passive: true });
    if (document.readyState !== 'loading') syncScrolledHeader();
    else document.addEventListener('DOMContentLoaded', syncScrolledHeader);
  }

  var cardObserver = null;
  function observeCards() {
    if (supportsViewTimeline || !allowsMotion() || !('IntersectionObserver' in window)) return;
    if (!cardObserver) {
      cardObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.isIntersecting) {
            entry.target.classList.remove('ltv-io-pending');
            entry.target.classList.add('ltv-io-visible');
            cardObserver.unobserve(entry.target);
          }
        }
      }, { threshold: 0.08 });
    }
    var cards = document.querySelectorAll('main .grid > .card');
    var vh = window.innerHeight || 800;
    for (var j = 0; j < cards.length; j++) {
      var c = cards[j];
      if (c.__ltvIoObserved) continue;
      c.__ltvIoObserved = true;
      var rect = c.getBoundingClientRect();
      if (rect.top > vh * 0.96) {
        c.classList.add('ltv-io-pending');
        cardObserver.observe(c);
      }
    }
  }

  var obsScheduled = 0;
  function scanEnhancedNodes() {
    obsScheduled = 0;
    observeCards();
    var dialogs = document.querySelectorAll('.fixed.inset-0 [role="dialog"], .fixed.inset-0 [role="alertdialog"]');
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if (!d.closest('.pointer-events-none')) {
        routeDialogFocus(d);
      }
    }
  }

  function startObserver() {
    if (!document.body || typeof MutationObserver !== 'function') return;
    scanEnhancedNodes();
    var mo = new MutationObserver(function () {
      if (!obsScheduled) obsScheduled = requestAnimationFrame(scanEnhancedNodes);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);
})();
