// Apply the saved appearance before CSS paints, without changing the preference.
(() => {
  let preference = 'light';
  try {
    const saved = localStorage.getItem('codex-navo-app-theme');
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch { /* Storage can be unavailable; keep the safe default. */ }
  const dark = preference === 'dark' || preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
