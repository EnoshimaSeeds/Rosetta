'use strict';

(function () {
  const api = window.rosetta;
  if (!api || api.hostMode !== 'electron' || typeof api.windowControl !== 'function') return;

  document.documentElement.classList.add('is-electron');

  const btnMin = document.getElementById('btnWinMin');
  const btnMax = document.getElementById('btnWinMax');
  const btnFull = document.getElementById('btnWinFull');
  const btnClose = document.getElementById('btnWinClose');
  const hud = document.querySelector('.hud');

  function applyState(st) {
    if (!st) return;
    const isMax = Boolean(st.maximized);
    const isFull = Boolean(st.fullscreen);
    document.documentElement.classList.toggle('is-maximized', isMax);
    document.documentElement.classList.toggle('is-fullscreen', isFull);
    if (btnMax) {
      btnMax.title = isFull ? '退出全屏' : (isMax ? '还原窗口' : '最大化');
      btnMax.setAttribute('aria-label', btnMax.title);
    }
    if (btnFull) {
      btnFull.classList.toggle('active', isFull);
      btnFull.title = isFull ? '退出无边框全屏 (F11)' : '无边框全屏 (F11)';
      btnFull.setAttribute('aria-label', btnFull.title);
    }
  }

  if (btnMin) btnMin.addEventListener('click', () => api.windowControl('minimize'));
  if (btnMax) btnMax.addEventListener('click', () => api.windowControl('toggleMaximize').then(applyState));
  if (btnFull) btnFull.addEventListener('click', () => api.windowControl('toggleFullscreen').then(applyState));
  if (btnClose) btnClose.addEventListener('click', () => api.windowControl('close'));

  if (hud) {
    hud.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, a, input, select, .win-controls')) return;
      api.windowControl('toggleMaximize').then(applyState);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      api.windowControl('toggleFullscreen').then(applyState);
    }
  });

  if (typeof api.onWindowState === 'function') {
    api.onWindowState(applyState);
  }
  api.windowControl('getState').then(applyState).catch(() => {});
})();
