(function () {
  function msg(key, fallback = '') {
    try {
      const v = chrome?.i18n?.getMessage?.(key);
      return v || fallback || key;
    } catch (_) {
      return fallback || key;
    }
  }
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = msg(el.dataset.i18n, el.textContent || '');
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', msg(el.dataset.i18nPlaceholder, el.getAttribute('placeholder') || ''));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', msg(el.dataset.i18nTitle, el.getAttribute('title') || ''));
    });
  }
  window.TEI18n = { msg, apply };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply());
  } else apply();
})();
