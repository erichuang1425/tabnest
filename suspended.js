/* Suspended-tab loader. Runs on suspended.html. */
(function () {
  function parseFragment() {
    var hash = location.hash.slice(1);
    var params = new URLSearchParams(hash);
    return {
      url:   params.get('url')   || '',
      title: params.get('title') || '',
      fav:   params.get('fav')   || ''
    };
  }
  var data = parseFragment();
  var url = data.url, title = data.title, fav = data.fav;

  if (title) document.title = title;
  else if (url) {
    try { document.title = new URL(url).hostname; } catch (e) { document.title = (window.TEI18n?.msg('suspendedLoading','Loading…') || 'Loading…'); }
  }

  function setFavicon(href) {
    var link = document.createElement('link');
    link.rel = 'icon';
    link.href = href;
    document.head.appendChild(link);
  }
  var favHref = fav;
  if (!favHref && url) {
    try { favHref = 'https://www.google.com/s2/favicons?domain=' + new URL(url).hostname + '&sz=64'; } catch (e) {}
  }
  var favEl = document.getElementById('fav');
  if (favHref) {
    setFavicon(favHref);
    if (favEl) favEl.src = favHref;
  } else if (favEl) {
    favEl.style.display = 'none';
  }

  var titleEl = document.getElementById('title');
  if (titleEl) titleEl.textContent = title || (window.TEI18n?.msg('suspendedSavedTab','Saved tab') || 'Saved tab');
  var urlEl = document.getElementById('url');
  if (urlEl) {
    try {
      var u = new URL(url);
      urlEl.textContent = u.hostname + u.pathname.slice(0, 80);
    } catch (e) {
      urlEl.textContent = url;
    }
  }

  var loading = false;
  function load() {
    if (loading || !url) return;
    loading = true;
    var st = document.getElementById('status-text');
    if (st) st.textContent = (window.TEI18n?.msg('suspendedLoadingPage','Loading page…') || 'Loading page…');
    location.replace(url);
  }

  function isForeground() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  if (isForeground()) {
    load();
  } else {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') load();
    });
    window.addEventListener('focus', load);
    window.addEventListener('pageshow', function () { if (isForeground()) load(); });
  }

  document.body.addEventListener('click', load);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); load(); }
  });
  var btn = document.getElementById('load-btn');
  if (btn) btn.addEventListener('click', function (e) { e.stopPropagation(); load(); });
})();
