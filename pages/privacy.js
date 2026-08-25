// Página de privacidad bilingüe: elige el idioma según el navegador y permite cambiarlo a mano.
(function () {
  const TITLES = { en: 'WebInfo — Privacy Policy', es: 'WebInfo — Política de privacidad' };
  const sections = document.querySelectorAll('[data-lang-section]');
  const buttons = document.querySelectorAll('[data-lang]');

  function apply(lang) {
    const l = lang === 'es' ? 'es' : 'en';
    document.documentElement.lang = l;
    document.title = TITLES[l];
    sections.forEach((s) => { s.hidden = s.dataset.langSection !== l; });
    buttons.forEach((b) => {
      const active = b.dataset.lang === l;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  apply(/^es/i.test(navigator.language || '') ? 'es' : 'en');
  buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.lang)));
})();
