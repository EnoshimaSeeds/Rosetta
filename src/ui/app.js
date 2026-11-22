'use strict';

(function () {
  const AGENTS = [
    { key: 'dsh', short: 'DeepSeek Harness', label: 'DeepSeek Harness (dsh)', cls: 'dsh' }
  ];

  const ORIGIN_LABEL = { official: '官方严选', 'github-verified': 'GitHub 核验', bespoke: '自研精制' };

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const state = {
    tier: 'categories',
    dashboard: { categories: [], skills: [], mcpServers: [], proposals: [], snapshots: [] },
    activeCategoryId: null,
    phi: 0,
    phiTarget: 0,
    focusIndex: 0,
    savedCatPhi: 0,
    studioSkill: null,
    studioIsNew: false,
    activeTab: 'markdown',
    activeScriptName: null
  };

  const elWheelView = document.getElementById('wheelView');
  const elStudioView = document.getElementById('studioView');
  const elCanvas = document.getElementById('wheelCanvas');
  const elCanvasFront = document.getElementById('wheelCanvasFront');
  const elWheelHub = document.getElementById('wheelHub');
  const elHubTitle = document.getElementById('hubTitle');
  const elHubSub = document.getElementById('hubSub');
  const elWheelFrames = document.getElementById('wheelFrames');
  const elProjectionDock = document.getElementById('projectionDock');
  const elProjection = document.getElementById('projectionPanel');
  if (window.RosettaWheel && typeof window.RosettaWheel.bindMaglevPanel === 'function') {
    window.RosettaWheel.bindMaglevPanel(elProjectionDock);
  }
  const fx = { pointerX: 0, pointerY: 0, targetPX: 0, targetPY: 0, pulse: 0, lastTs: 0, time: 0 };
  const reducedMotionMq = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
  const elReelRack = document.getElementById('reelRack');
  const elHudCrumbs = document.getElementById('hudCrumbs');
  const elHudStat = document.getElementById('hudStat');
  const elProposalBadge = document.getElementById('proposalBadge');
  const elToast = document.getElementById('toast');

  let toastTimer = null;
  function showToast(msg, isError = false) {
    elToast.textContent = msg;
    elToast.style.borderColor = isError ? 'var(--danger)' : 'var(--or-hot)';
    elToast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elToast.hidden = true; }, 3400);
  }

  async function rpc(action, payload = {}) {
    if (!window.rosetta || typeof window.rosetta.invoke !== 'function') {
      throw new Error('未检测到 Rosetta 安全桥接接口');
    }
    const res = await window.rosetta.invoke(action, payload);
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || '操作失败');
      err.details = res && res.details;
      throw err;
    }
    return res.data;
  }

  const studio = window.RosettaStudio.createStudioController({
    AGENTS,
    esc,
    rpc,
    showToast,
    getState: () => state,
    onDashboardUpdated(newDash, newCatId) {
      state.dashboard = newDash;
      if (newCatId) state.activeCategoryId = newCatId;
      renderHud();
    },
    onExitStudio() {
      switchToCards(state.activeCategoryId, false);
    }
  });
  studio.wireDomEvents();

  function getWheelItems() {
    if (state.tier === 'categories') {
      const cats = state.dashboard.categories.map((c) => ({ kind: 'category', data: c }));
      cats.push({ kind: 'blank_category' });
      return cats;
    }
    if (state.tier === 'cards') {
      const list = state.dashboard.skills.filter((s) => s.categoryId === state.activeCategoryId).map((s) => ({ kind: 'skill', data: s }));
      list.push({ kind: 'blank_skill' });
      return list;
    }
    return [];
  }

  function currentAccent() {
    if (state.tier === 'categories') {
      const focused = getWheelItems()[state.focusIndex];
      return (focused && focused.data && focused.data.accent) || '#e8742c';
    }
    const cat = state.dashboard.categories.find((c) => c.id === state.activeCategoryId);
    return (cat && cat.accent) || '#e8742c';
  }

  function getGeometry() {
    const rect = elWheelView.getBoundingClientRect();
    return window.RosettaWheel.computeGeometry(rect.width || window.innerWidth, rect.height || (window.innerHeight - 58));
  }

  function rotateToIndex(idx, instant = false) {
    const items = getWheelItems();
    const clamped = Math.max(0, Math.min(items.length - 1, idx));
    const geom = getGeometry();
    if (clamped !== state.focusIndex) fx.pulse = 1;
    state.focusIndex = clamped;
    state.phiTarget = clamped * geom.step;
    if (instant) state.phi = state.phiTarget;
    renderProjection();
    updateFrameFocusClasses();
  }

  function renderHud() {
    document.body.dataset.tier = state.tier;
    const totalSkills = state.dashboard.skills.length;
    const mountedCount = state.dashboard.skills.filter((s) => s.assigned && s.assigned.dsh).length;
    const cleanCount = state.dashboard.skills.filter((s) => s.security && s.security.passed).length;
    elHudStat.textContent = `${state.dashboard.categories.length} 板块 · DSH 已挂载 ${mountedCount}/${totalSkills} · 安检 ${cleanCount}/${totalSkills}`;

    const pCount = (state.dashboard.proposals || []).length;
    elProposalBadge.hidden = pCount === 0;
    elProposalBadge.textContent = String(pCount);

    const cat = state.dashboard.categories.find((c) => c.id === state.activeCategoryId);
    const parts = [];
    if (state.tier === 'categories') {
      parts.push('<span class="crumb-cur">Ⅰ · 板块主轮盘</span>');
    } else if (state.tier === 'cards') {
      parts.push('<button class="crumb-btn" data-nav="categories">← Ⅰ · 板块主轮盘</button>');
      parts.push('<span class="crumb-sep">/</span>');
      parts.push(`<span class="crumb-cur">Ⅱ · ${esc(cat ? cat.title : state.activeCategoryId)}</span>`);
    } else if (state.tier === 'studio') {
      parts.push('<button class="crumb-btn" data-nav="categories">Ⅰ · 主轮盘</button>');
      parts.push('<span class="crumb-sep">/</span>');
      parts.push(`<button class="crumb-btn" data-nav="cards">← Ⅱ · ${esc(cat ? cat.title : '卡面转轮')}</button>`);
      parts.push('<span class="crumb-sep">/</span>');
      const label = state.studioIsNew ? '新建技能包' : (state.studioSkill ? state.studioSkill.title : '细则精修');
      parts.push(`<span class="crumb-cur">Ⅲ · ${esc(label)}</span>`);
    }
    elHudCrumbs.innerHTML = parts.join('');
    elHudCrumbs.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.getAttribute('data-nav') === 'categories') switchToCategories();
        else switchToCards(state.activeCategoryId, false);
      });
    });
  }

  function renderWheelDom() {
    if (state.tier === 'studio') {
      elWheelView.hidden = true;
      elStudioView.hidden = false;
      return;
    }
    elWheelView.hidden = false;
    elStudioView.hidden = true;

    const items = getWheelItems();
    const cat = state.dashboard.categories.find((c) => c.id === state.activeCategoryId);
    elHubTitle.textContent = state.tier === 'categories' ? 'ROSETTA' : (cat ? cat.code : 'REEL');
    elHubSub.textContent = state.tier === 'categories' ? 'Ⅰ · 选择分类板块轮盘' : 'Ⅱ · 拨动转轮选择技能卡面';

    elWheelFrames.innerHTML = items.map((item, idx) => {
      if (item.kind === 'blank_category') {
        return `<div class="reel-frame blank" data-idx="${idx}"><div class="reel-card"><div class="rc-blank-label"><span class="rc-plus">+</span><span>开辟新板块轮盘</span></div></div></div>`;
      }
      if (item.kind === 'blank_skill') {
        return `<div class="reel-frame blank" data-idx="${idx}"><div class="reel-card"><div class="rc-blank-label"><span class="rc-plus">+</span><span>新建或导入技能包</span></div></div></div>`;
      }
      if (item.kind === 'category') {
        const c = item.data;
        const count = state.dashboard.skills.filter((s) => s.categoryId === c.id).length;
        return `<div class="reel-frame" data-idx="${idx}" style="--card-accent:${esc(c.accent)}">
          <div class="reel-card">
            <div class="rc-top"><span class="rc-code">${esc(c.code)}</span><span class="rc-badge ok">${count} 项技能</span></div>
            <div class="rc-title">${esc(c.title)}</div>
            <div class="rc-sub">${esc(c.subtitle)}</div>
          </div>
        </div>`;
      }
      const s = item.data;
      const catAccent = (cat && cat.accent) || '#e8742c';
      const dshOn = Boolean(s.assigned && s.assigned.dsh);
      return `<div class="reel-frame" data-idx="${idx}" style="--card-accent:${esc(catAccent)}">
        <div class="reel-card">
          <div class="rc-top">
            <span class="rc-code">${esc(ORIGIN_LABEL[s.origin] || '自研')} · v${esc(s.version)}</span>
            ${s.diskDrifted ? '<span class="rc-badge" style="color:var(--warn);border-color:var(--warn);">⚠️ 漂移冻结</span>' : `<span class="rc-badge ok">🛡️ ${esc(s.security ? s.security.score : 100)}</span>`}
          </div>
          <div class="rc-title">${esc(s.title)}</div>
          <div class="rc-sub">${esc(s.summary)}</div>
          <div class="rc-foot"><div class="host-pips">
            <span class="pip dsh ${dshOn ? 'on' : ''}"><i></i>${dshOn ? 'DSH 已挂载' : 'DSH 未挂载'}</span>
          </div></div>
        </div>
      </div>`;
    }).join('');

    elWheelFrames.querySelectorAll('.reel-frame').forEach((el) => {
      el.addEventListener('click', () => activateWheelItem(parseInt(el.getAttribute('data-idx'), 10)));
    });

    if (state.tier === 'cards') {
      elReelRack.hidden = false;
      elReelRack.innerHTML = state.dashboard.categories.map((c) => `
        <button class="rack-item ${c.id === state.activeCategoryId ? 'on' : ''}" data-cat="${esc(c.id)}" style="--rack-accent:${esc(c.accent)}">
          <span class="rack-dot"></span><span>${esc(c.title.split(/[：:]/).pop())}</span>
        </button>
      `).join('');
      elReelRack.querySelectorAll('[data-cat]').forEach((btn) => {
        btn.addEventListener('click', () => switchToCards(btn.getAttribute('data-cat'), true));
      });
    } else {
      elReelRack.hidden = true;
    }

    updateFrameFocusClasses();
    renderProjection();
  }

  function updateFrameFocusClasses() {
    elWheelFrames.querySelectorAll('.reel-frame').forEach((el) => {
      el.classList.toggle('focus', parseInt(el.getAttribute('data-idx'), 10) === state.focusIndex);
    });
  }

  function renderProjection() {
    if (state.tier === 'studio') return;
    const focused = getWheelItems()[state.focusIndex];
    if (!focused) { elProjection.innerHTML = ''; return; }

    if (focused.kind === 'blank_category') {
      elProjection.innerHTML = `
        <div class="proj-eyebrow">OPEN TAXONOMY · 开放式扩建</div>
        <h2 class="proj-title">开辟新的板块轮盘</h2>
        <p class="proj-desc">预设的五大板块只是起步种子。你可以随时为新课题、新工具链或专属工作流建立独立轮盘。</p>
        <div class="proj-cta"><button class="cta-btn" id="projBtnNewCat">+ 立即创建新板块 (Enter)</button></div>
        <div class="proj-keys mono">滚轮 / 上下键拨动转轮 · Enter 打开选中项</div>`;
      document.getElementById('projBtnNewCat').addEventListener('click', () => {
        document.getElementById('formCategory').reset();
        document.getElementById('dlgCategory').showModal();
      });
      return;
    }

    if (focused.kind === 'blank_skill') {
      const cat = state.dashboard.categories.find((c) => c.id === state.activeCategoryId);
      elProjection.innerHTML = `
        <div class="proj-eyebrow">NEW SKILL PACKAGE · ${esc(cat ? cat.code : '')}</div>
        <h2 class="proj-title">新建或导入技能包</h2>
        <p class="proj-desc">在此板块下编写新的可编辑技能规范，或将外部技能经主机安全扫描后入库并挂载至 DeepSeek Harness。</p>
        <div class="proj-cta"><button class="cta-btn" id="projBtnNewSkill">+ 进入新建技能工坊 (Enter)</button></div>
        <div class="proj-keys mono">Esc 返回主轮盘 · 左右方向键切换相邻板块</div>`;
      document.getElementById('projBtnNewSkill').addEventListener('click', () => openStudioForNewSkill(state.activeCategoryId));
      return;
    }

    if (focused.kind === 'category') {
      const c = focused.data;
      const catSkills = state.dashboard.skills.filter((s) => s.categoryId === c.id);
      if (elProjectionDock) elProjectionDock.style.setProperty('--proj-accent', c.accent);
      elProjection.style.setProperty('--proj-accent', c.accent);
      elProjection.innerHTML = `
        <div class="proj-eyebrow" style="color:${esc(c.accent)}">${esc(c.code)} · CATEGORY SECTOR</div>
        <h2 class="proj-title">${esc(c.title)}</h2>
        <p class="proj-desc">${esc(c.subtitle)}</p>
        <div class="proj-section-label">本板块收纳技能包 (${catSkills.length}) — 点击可直接快进细则编辑</div>
        <div class="chip-list">
          ${catSkills.length ? catSkills.map((s) => `<button class="Dish-chip" data-open-skill="${esc(s.id)}">${esc(s.title)}</button>`).join('') : '<span class="dim">暂无技能包，点开轮盘即可新建</span>'}
        </div>
        <div class="proj-section-label">DeepSeek Harness 协作档位</div>
        <div class="flavor-preview">
          <div class="flavor-preview-item"><b>常规对话</b><span>按任务语境自动匹配并按需读取技能</span></div>
          <div class="flavor-preview-item"><b>「走一遍流程」</b><span>启用完整规范与随附自动化校验脚本</span></div>
          <div class="flavor-preview-item"><b>「多视角独立复核」</b><span>生成缺陷分级审查清单并逐项核验</span></div>
        </div>
        <div class="proj-cta"><button class="cta-btn" id="projBtnEnterCat">展开此板块 · 选择技能卡面 (Enter) →</button></div>
        <div class="proj-keys mono">鼠标滚轮 / 拖拽 / ↑↓ 拨动轮盘 · 单击扇区或按 Enter 进入</div>`;
      document.getElementById('projBtnEnterCat').addEventListener('click', () => switchToCards(c.id, true));
      elProjection.querySelectorAll('[data-open-skill]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.activeCategoryId = c.id;
          openStudioForSkill(btn.getAttribute('data-open-skill'));
        });
      });
      return;
    }

    const s = focused.data;
    const cat = state.dashboard.categories.find((c) => c.id === s.categoryId);
    const skillAccent = (cat && cat.accent) || '#e8742c';
    const dshOn = Boolean(s.assigned && s.assigned.dsh);
    if (elProjectionDock) elProjectionDock.style.setProperty('--proj-accent', skillAccent);
    elProjection.style.setProperty('--proj-accent', skillAccent);
    elProjection.innerHTML = `
      <div class="proj-eyebrow">
        <span>${esc(ORIGIN_LABEL[s.origin] || '自研')} · v${esc(s.version)}</span><span>·</span>
        <span style="color:var(--ok)">🛡️ 安检 ${esc(s.security ? s.security.verdict : 'CLEAN')} (${esc(s.security ? s.security.score : 100)})</span>
        ${s.diskDrifted ? '<span>·</span><button type="button" class="sbtn small" id="projBtnDrift" style="color:var(--warn);border-color:var(--warn);">⚠️ 磁盘改动已冻结 · 点此审阅 Diff</button>' : ''}
      </div>
      <h2 class="proj-title">${esc(s.title)}</h2>
      <p class="proj-desc" title="给 AI 调度器看的触发条件">${esc(s.summary)}</p>
      <div class="note-head-row">
        <span class="proj-section-label" style="margin:0;">📖 技能注解与备注（仅供你查阅）</span>
        <button type="button" class="sbtn ghost small" id="btnQuickEditNote">✏️ 编辑注解</button>
      </div>
      <div id="projNoteArea">
        <div class="note-box ${s.annotation ? '' : 'empty'}">${s.annotation ? esc(s.annotation) : '暂无注解——点右上角「编辑注解」可随时记下它的内部机制、适用场景或你的备注。'}</div>
      </div>
      ${(s.flavor && s.flavor.length) ? `
        <div class="proj-section-label">当前参数预设（点开卡面可自由修改）</div>
        <div class="flavor-preview">${s.flavor.map((f) => `<div class="flavor-preview-item"><b>${esc(f.label)}</b><span>${esc(String(f.value))}</span></div>`).join('')}</div>` : ''}
      <div class="proj-section-label">DeepSeek Harness 挂载状态（点击即刻开关并同步）</div>
      <div class="mount-row">
        <button class="mount-pill dsh ${dshOn ? 'on' : ''}" data-toggle-agent="dsh">
          <span>${dshOn ? '◆' : '◇'}</span>
          <span>${dshOn ? '已挂载至 DeepSeek Harness（点击暂停）' : '未挂载（点击启用并同步至 DSH）'}</span>
        </button>
      </div>
      <div class="proj-cta"><button class="cta-btn" id="projBtnOpenStudio">展开卡面 · 进入细则精修工坊 (Enter) →</button></div>
      <div class="proj-keys mono">↑↓ 拨动卡面 · ←→ 切换板块 · Esc 返回主轮盘</div>`;

    document.getElementById('projBtnOpenStudio').addEventListener('click', () => openStudioForSkill(s.id));
    const btnProjDrift = document.getElementById('projBtnDrift');
    if (btnProjDrift) btnProjDrift.addEventListener('click', () => studio.openDriftModal(s.id));
    document.getElementById('btnQuickEditNote').addEventListener('click', () => {
      const area = document.getElementById('projNoteArea');
      area.innerHTML = `
        <div class="note-inline-editor">
          <textarea id="quickNoteInput" rows="4" placeholder="写下给自己的注解、使用说明或备注（不占 AI 上下文）…">${esc(s.annotation || '')}</textarea>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button type="button" class="sbtn ghost small" id="btnQuickNoteCancel">取消</button>
            <button type="button" class="sbtn primary small" id="btnQuickNoteSave">保存注解</button>
          </div>
        </div>`;
      const ta = document.getElementById('quickNoteInput');
      ta.focus();
      document.getElementById('btnQuickNoteCancel').addEventListener('click', () => renderProjection());
      document.getElementById('btnQuickNoteSave').addEventListener('click', async () => {
        try {
          const out = await rpc('saveSkillAnnotation', { skillId: s.id, annotation: ta.value });
          state.dashboard = out.dashboard;
          renderProjection();
          showToast(`已更新「${s.title}」的注解`);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
    elProjection.querySelectorAll('[data-toggle-agent]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        const agentKey = btn.getAttribute('data-toggle-agent');
        const nextVal = !(s.assigned && s.assigned[agentKey]);
        try {
          const out = await rpc('setAssignment', { skillId: s.id, assigned: { [agentKey]: nextVal }, syncNow: true });
          state.dashboard = out.dashboard;
          renderHud();
          renderWheelDom();
          const warnStr = out.syncReport && out.syncReport.warnings && out.syncReport.warnings.length
            ? `（注：${out.syncReport.warnings[0]}）`
            : '';
          showToast(`已为 DeepSeek Harness ${nextVal ? '挂载' : '卸下'}「${s.title}」` + warnStr);
        } catch (err) {
          showToast(err.message, true);
        } finally {
          btn.dataset.busy = '0';
        }
      });
    });
  }

  function activateWheelItem(idx) {
    const target = getWheelItems()[idx];
    if (!target) return;
    rotateToIndex(idx, false);
    setTimeout(() => {
      if (target.kind === 'blank_category') {
        document.getElementById('formCategory').reset();
        document.getElementById('dlgCategory').showModal();
      } else if (target.kind === 'blank_skill') {
        openStudioForNewSkill(state.activeCategoryId);
      } else if (target.kind === 'category') {
        switchToCards(target.data.id, true);
      } else if (target.kind === 'skill') {
        openStudioForSkill(target.data.id);
      }
    }, 150);
  }

  function switchToCategories() {
    state.tier = 'categories';
    state.phi = state.savedCatPhi;
    state.phiTarget = state.savedCatPhi;
    const geom = getGeometry();
    state.focusIndex = Math.max(0, Math.min(getWheelItems().length - 1, Math.round(state.phiTarget / geom.step)));
    renderHud();
    renderWheelDom();
  }

  function switchToCards(categoryId, resetScroll = true) {
    if (state.tier === 'categories') state.savedCatPhi = state.phiTarget;
    state.activeCategoryId = categoryId;
    state.tier = 'cards';
    if (resetScroll) { state.focusIndex = 0; state.phi = 0; state.phiTarget = 0; }
    renderHud();
    renderWheelDom();
  }

  async function openStudioForSkill(skillId) {
    try {
      const fullSkill = await rpc('getSkill', { skillId });
      state.studioSkill = structuredClone(fullSkill);
      state.studioIsNew = false;
      state.activeScriptName = Object.keys(state.studioSkill.scriptFiles || {})[0] || null;
      state.tier = 'studio';
      renderHud();
      renderWheelDom();
      studio.renderStudio();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function openStudioForNewSkill(categoryId) {
    state.studioIsNew = true;
    state.studioSkill = {
      id: '',
      categoryId: categoryId || (state.dashboard.categories[0] && state.dashboard.categories[0].id) || 'industrial',
      title: '',
      summary: '',
      origin: 'bespoke',
      annotation: '',
      sourceUrl: '',
      version: '1.0.0',
      tags: [],
      flavor: [{ key: 'mode_preset', label: '默认执行档位', type: 'text', value: '标准专业档', hint: '可按需调节的偏好参数' }],
      assigned: { dsh: true },
      body: '# 核心执行工序\n\n1. 需求对齐与边界确认\n2. 规范实现与模块化交付\n3. 真实工具端到端验证\n',
      scriptFiles: {},
      security: { passed: true, verdict: 'CLEAN', score: 100, counts: { critical: 0, high: 0, warn: 0 }, findings: [] }
    };
    state.activeScriptName = null;
    state.tier = 'studio';
    renderHud();
    renderWheelDom();
    studio.renderStudio();
  }

  document.getElementById('formCategory').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await rpc('saveCategory', {
        category: {
          id: document.getElementById('catId').value.trim(),
          code: document.getElementById('catCode').value.trim(),
          title: document.getElementById('catTitle').value.trim(),
          subtitle: document.getElementById('catSubtitle').value.trim(),
          accent: document.getElementById('catAccent').value
        }
      });
      state.dashboard = out.dashboard;
      document.getElementById('dlgCategory').close();
      renderHud();
      renderWheelDom();
      showToast(`新板块「${out.category.title}」已开辟！`);
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btnHomeBrand').addEventListener('click', switchToCategories);

  document.getElementById('btnSyncAll').addEventListener('click', async () => {
    try {
      const out = await rpc('syncAll');
      state.dashboard = out.dashboard;
      const r = out.syncReport.results;
      const synced = r.dsh ? r.dsh.synced : 0;
      const warnStr = out.syncReport.warnings && out.syncReport.warnings.length
        ? ` · 注: ${out.syncReport.warnings[0]}`
        : '';
      showToast(`已同步 ${synced} 项技能至 DeepSeek Harness (${out.syncReport.targetSkillsRoot})` + warnStr);
    } catch (err) { showToast(err.message, true); }
  });

  const modals = window.RosettaModals.createModalsController({
    esc,
    rpc,
    showToast,
    getState: () => state,
    onDashboardUpdated(newDash, rerenderWheel = false) {
      state.dashboard = newDash;
      renderHud();
      if (rerenderWheel) renderWheelDom();
    },
    onAfterRollback() {
      switchToCategories();
    },
    studio
  });
  modals.wireModalEvents();

  let dragState = null;
  let snapTimer = null;
  function scheduleSnap() {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => { rotateToIndex(Math.round(state.phiTarget / getGeometry().step), false); }, 130);
  }

  elWheelView.addEventListener('wheel', (e) => {
    if (state.tier === 'studio') return;
    const items = getWheelItems();
    const geom = getGeometry();
    const maxPhi = Math.max(0, (items.length - 1) * geom.step);
    state.phiTarget = Math.max(0, Math.min(maxPhi, state.phiTarget + e.deltaY * 0.0016));
    const nearest = Math.max(0, Math.min(items.length - 1, Math.round(state.phiTarget / geom.step)));
    if (nearest !== state.focusIndex) { state.focusIndex = nearest; fx.pulse = 1; updateFrameFocusClasses(); renderProjection(); }
    scheduleSnap();
  }, { passive: true });

  elWheelView.addEventListener('pointerdown', (e) => {
    if (state.tier === 'studio' || e.target.closest('.reel-frame, .projection, .reel-rack, button')) return;
    dragState = { startY: e.clientY, startPhi: state.phiTarget };
    elWheelView.setPointerCapture(e.pointerId);
  });
  elWheelView.addEventListener('pointermove', (e) => {
    const rect = elWheelView.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      fx.targetPX = ((e.clientX - rect.left) / rect.width - 0.35) * 1.4;
      fx.targetPY = ((e.clientY - rect.top) / rect.height - 0.5) * 1.4;
    }
    if (!dragState) return;
    const items = getWheelItems();
    const geom = getGeometry();
    const maxPhi = Math.max(0, (items.length - 1) * geom.step);
    state.phiTarget = Math.max(0, Math.min(maxPhi, dragState.startPhi + (dragState.startY - e.clientY) * 0.0042));
    const nearest = Math.max(0, Math.min(items.length - 1, Math.round(state.phiTarget / geom.step)));
    if (nearest !== state.focusIndex) { state.focusIndex = nearest; fx.pulse = 1; updateFrameFocusClasses(); renderProjection(); }
  });
  elWheelView.addEventListener('pointerleave', () => { fx.targetPX = 0; fx.targetPY = 0; });
  elWheelView.addEventListener('pointerup', () => { if (dragState) { dragState = null; scheduleSnap(); } });

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (state.tier === 'studio') {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); studio.saveStudioSkill(true); }
      else if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); switchToCards(state.activeCategoryId, false); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); rotateToIndex(state.focusIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rotateToIndex(state.focusIndex - 1); }
    else if (state.tier === 'cards' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const cats = state.dashboard.categories;
      const curIdx = cats.findIndex((c) => c.id === state.activeCategoryId);
      if (curIdx >= 0 && cats.length > 0) switchToCards(cats[(curIdx + (e.key === 'ArrowRight' ? 1 : cats.length - 1)) % cats.length].id, true);
    } else if (e.key === 'Enter') { e.preventDefault(); activateWheelItem(state.focusIndex); }
    else if (e.key === 'Escape' && state.tier === 'cards') { e.preventDefault(); switchToCategories(); }
  });

  function animationTick(ts) {
    const now = typeof ts === 'number' ? ts : performance.now();
    const dt = fx.lastTs ? Math.min(0.05, (now - fx.lastTs) / 1000) : 0.016;
    fx.lastTs = now;
    if (!document.hidden && state.tier !== 'studio') {
      const diff = state.phiTarget - state.phi;
      const stepDelta = Math.abs(diff) > 0.0002 ? diff * 0.16 : 0;
      state.phi = stepDelta !== 0 ? state.phi + stepDelta : state.phiTarget;
      fx.time += dt * (1 + Math.min(2.6, Math.abs(diff) * 6));
      fx.pointerX += (fx.targetPX - fx.pointerX) * 0.08;
      fx.pointerY += (fx.targetPY - fx.pointerY) * 0.08;
      if (fx.pulse > 0.005) fx.pulse *= 0.92;
      else fx.pulse = 0;

      const geom = getGeometry();
      elWheelHub.style.left = geom.cx + 'px';
      elWheelHub.style.top = geom.cy + 'px';
      if (geom.hubScale) elWheelHub.style.setProperty('--hub-scale', geom.hubScale.toFixed(3));
      window.RosettaWheel.drawDisc(elCanvas, geom, state.phi, currentAccent(), {
        frontCanvas: elCanvasFront,
        time: fx.time,
        velocity: diff,
        pointerX: fx.pointerX,
        pointerY: fx.pointerY,
        pulse: fx.pulse,
        reducedMotion: Boolean(reducedMotionMq.matches)
      });

      const frameEls = elWheelFrames.children;
      for (let i = 0; i < frameEls.length; i++) {
        const el = frameEls[i];
        const a = i * geom.step - state.phi;
        const visible = Math.abs(a) < 1.38;
        el.style.display = visible ? 'block' : 'none';
        if (visible) {
          const deg = (a * 180) / Math.PI;
          const pull = i === state.focusIndex ? 8 : 0;
          el.style.width = geom.cardW + 'px';
          el.style.height = geom.cardH + 'px';
          el.style.left = geom.cx + 'px';
          el.style.top = geom.cy + 'px';
          el.style.opacity = String(Math.max(0.18, 1 - Math.abs(a) * 0.62));
          el.style.transform = `rotate(${deg.toFixed(3)}deg) translate(${geom.rIn + pull}px, ${-geom.cardH / 2}px)`;
        }
      }
    }
    requestAnimationFrame(animationTick);
  }

  async function init() {
    try {
      const data = await rpc('getDashboard');
      state.dashboard = data;
      state.activeCategoryId = data.categories[0] ? data.categories[0].id : null;
      renderHud();
      renderWheelDom();
    } catch (err) { showToast('初始化失败: ' + err.message, true); }
    requestAnimationFrame(animationTick);
  }

  init();
})();
