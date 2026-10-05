(function () {
  const TITLES = { en: 'WebInfo: Privacy', es: 'WebInfo: Privacidad' };
  const sections = document.querySelectorAll('[data-lang-section]');
  const links = document.querySelectorAll('[data-lang]');

  function apply(lang) {
    const l = lang === 'es' ? 'es' : 'en';
    document.documentElement.lang = l;
    document.title = TITLES[l];
    sections.forEach((s) => { s.hidden = s.dataset.langSection !== l; });
    links.forEach((link) => {
      if (link.dataset.lang === l) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  let language = navigator.language || '';
  try { language = chrome.i18n.getUILanguage() || language; } catch {}
  const defaultLanguage = /^es/i.test(language) ? 'es' : 'en';
  function applyFromHash() {
    const lang = window.location.hash.slice(1);
    apply(lang === 'es' || lang === 'en' ? lang : defaultLanguage);
  }
  applyFromHash();
  window.addEventListener('hashchange', applyFromHash);
})();
