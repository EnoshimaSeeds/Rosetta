'use strict';

window.RosettaStudio = (function () {
  function createStudioController({ AGENTS, esc, rpc, showToast, getState, onDashboardUpdated, onExitStudio }) {
    function syncLeftMetaToState() {
      const s = getState().studioSkill;
      if (!s) return;
      const idEl = document.getElementById('metaId');
      if (idEl) {
        s.id = idEl.value.trim();
        s.categoryId = document.getElementById('metaCat').value;
        s.title = document.getElementById('metaTitle').value.trim();
        s.summary = document.getElementById('metaSummary').value.trim();
        const annEl = document.getElementById('metaAnnotation');
        if (annEl) s.annotation = annEl.value.trim();
        s.origin = document.getElementById('metaOrigin').value;
        s.version = document.getElementById('metaVersion').value.trim() || '1.0.0';
        s.sourceUrl = document.getElementById('metaSourceUrl').value.trim();
        s.tags = document.getElementById('metaTags').value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      }
    }

    function syncRightEditorToState() {
      const st = getState();
      const s = st.studioSkill;
      if (!s) return;
      syncLeftMetaToState();
      const mdEl = document.getElementById('editorMarkdown');
      if (mdEl) s.body = mdEl.value;
      const scEl = document.getElementById('editorScript');
      if (scEl && st.activeScriptName && s.scriptFiles && Object.prototype.hasOwnProperty.call(s.scriptFiles, st.activeScriptName)) {
        s.scriptFiles[st.activeScriptName] = scEl.value;
      }
    }

    function switchStudioTab(tab) {
      const st = getState();
      st.activeTab = tab;
      document.querySelectorAll('.stab').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
      document.getElementById('paneMarkdown').hidden = tab !== 'markdown';
      document.getElementById('paneScripts').hidden = tab !== 'scripts';
      document.getElementById('paneSecurity').hidden = tab !== 'security';
    }

    function renderSecurityHtml(scan, container, includeRescanBtn = false) {
      if (!scan) {
        container.innerHTML = '<span class="dim">尚未执行扫描</span>';
        return;
      }
      const findings = scan.findings || [];
      container.innerHTML = `
        <div class="sec-verdict ${esc(scan.verdict)}">
          <div>
            <strong>静态启发式与能力检查：${esc(scan.verdict)}（评分 ${esc(scan.score)} / 100）</strong>
            <div style="font-size:12px;opacity:0.88;">高危: ${scan.counts.critical} · 严重: ${scan.counts.high} · 能力提醒: ${scan.counts.warn}${scan.hasExecutableScripts ? ' · 含可执行脚本（须人工审阅）' : ''}</div>
          </div>
          ${includeRescanBtn ? '<button type="button" class="sbtn" id="btnLiveRescan">🔍 对当前内容重新检查</button>' : ''}
        </div>
        ${findings.length === 0
          ? '<div class="finding-row">✅ 静态启发式检查未发现已知提示词覆盖、隐形控制字符、危险子进程或异常外连（注：含可执行脚本时仍请人工核对逻辑）。</div>'
          : findings.map((f) => `
            <div class="finding-row">
              <div><strong style="color:var(--danger)">[${esc(f.severity)}] ${esc(f.ruleId)}</strong> <span class="mono dim">${esc(f.file)}:${esc(f.line)}</span></div>
              <div style="margin-top:4px;">${esc(f.message)}</div>
              <code class="mono dim" style="display:block;margin-top:4px;">${esc(f.snippet)}</code>
            </div>
          `).join('')}
      `;
      if (includeRescanBtn) {
        document.getElementById('btnLiveRescan').addEventListener('click', async () => {
          syncRightEditorToState();
          const st = getState();
          const res = await rpc('scanContent', {
            markdown: st.studioSkill.body,
            scripts: st.studioSkill.scriptFiles
          });
          st.studioSkill.security = res;
          renderStudioSecurity(res);
          showToast(`实时安检完成：${res.verdict} (${res.score}/100)`, !res.passed);
        });
      }
    }

    function renderStudioSecurity(scan) {
      renderSecurityHtml(scan, document.getElementById('studioSecurityReport'), true);
    }

    function renderScriptPane() {
      const st = getState();
      const s = st.studioSkill;
      s.scriptFiles = s.scriptFiles || {};
      const bar = document.getElementById('scriptBar');
      const editor = document.getElementById('editorScript');
      const names = Object.keys(s.scriptFiles);
      if (st.activeScriptName && !Object.prototype.hasOwnProperty.call(s.scriptFiles, st.activeScriptName)) {
        st.activeScriptName = names[0] || null;
      } else if (!st.activeScriptName && names.length > 0) {
        st.activeScriptName = names[0];
      }

      bar.innerHTML = `
        ${names.map((n) => `<button type="button" class="sbtn small ${n === st.activeScriptName ? 'primary' : ''}" data-scname="${esc(n)}">${esc(n)}</button>`).join('')}
        <button type="button" class="sbtn small" id="btnAddScript">+ 新增辅助脚本</button>
        ${st.activeScriptName ? '<button type="button" class="sbtn ghost small" id="btnRemoveScript">移除当前脚本</button>' : ''}
        ${names.length === 0 ? '<span class="dim" style="font-size:12.5px;">本技能包暂未附带脚本，纯靠 SKILL.md 即可运行。</span>' : ''}
      `;

      editor.disabled = !st.activeScriptName;
      editor.value = st.activeScriptName ? (s.scriptFiles[st.activeScriptName] || '') : '';

      bar.querySelectorAll('[data-scname]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (st.activeScriptName && Object.prototype.hasOwnProperty.call(s.scriptFiles, st.activeScriptName)) {
            s.scriptFiles[st.activeScriptName] = editor.value;
          }
          st.activeScriptName = btn.getAttribute('data-scname');
          renderScriptPane();
        });
      });

      document.getElementById('btnAddScript').addEventListener('click', () => {
        if (st.activeScriptName && Object.prototype.hasOwnProperty.call(s.scriptFiles, st.activeScriptName)) {
          s.scriptFiles[st.activeScriptName] = editor.value;
        }
        let n = names.length + 1;
        while (Object.prototype.hasOwnProperty.call(s.scriptFiles, `helper_${n}.cjs`)) n++;
        const newName = `helper_${n}.cjs`;
        s.scriptFiles[newName] = "'use strict';\n// 在此编写零依赖辅助脚本\n";
        if (Array.isArray(s.removedScripts)) {
          s.removedScripts = s.removedScripts.filter((x) => x !== newName);
        }
        st.activeScriptName = newName;
        renderScriptPane();
      });

      const delBtn = document.getElementById('btnRemoveScript');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          if (!st.activeScriptName) return;
          s.removedScripts = Array.isArray(s.removedScripts) ? s.removedScripts : [];
          if (!s.removedScripts.includes(st.activeScriptName)) {
            s.removedScripts.push(st.activeScriptName);
          }
          delete s.scriptFiles[st.activeScriptName];
          st.activeScriptName = Object.keys(s.scriptFiles)[0] || null;
          renderScriptPane();
        });
      }
    }

    function renderStudio() {
      const st = getState();
      const s = st.studioSkill;
      if (!s) return;

      const elLeft = document.getElementById('studioLeft');
      elLeft.innerHTML = `
        ${s.diskDrifted ? `
        <div class="panel-card" style="border-color:var(--warn);">
          <div class="panel-head"><span style="color:var(--warn);">⚠️ 检测到未审阅的磁盘改动（已冻结更新）</span></div>
          <div class="dim" style="font-size:12.5px;">磁盘文件与上次入库哈希不一致，DeepSeek Harness 仍保留上一版干净副本。保存前请先审阅 Diff，选择采纳或单卡还原。</div>
          <div><button type="button" class="sbtn primary small" id="btnStudioDrift">🔍 查看磁盘漂移 Diff（采纳 / 单卡还原）</button></div>
        </div>` : ''}
        <div class="panel-card">
          <div class="panel-head"><span>DeepSeek Harness 挂载开关</span><span class="mono dim">TARGET RUNTIME</span></div>
          <div class="mount-row">
            ${AGENTS.map((a) => `
              <button type="button" class="mount-pill ${a.cls} ${s.assigned && s.assigned[a.key] ? 'on' : ''}" data-studio-agent="${a.key}">
                <span>${s.assigned && s.assigned[a.key] ? '◆' : '◇'}</span>
                <span>${esc(a.label)}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-head">
            <span>可编辑「参数预设卡」(${(s.flavor || []).length})</span>
            <button type="button" class="sbtn small" id="btnAddFlavor">+ 新增参数项</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:9px;">
            ${(s.flavor || []).length === 0 ? '<span class="dim" style="font-size:12px;">暂无预设参数，点击右上角可添加自定义开关、下拉或文本偏好。</span>' : ''}
            ${(s.flavor || []).map((f, idx) => `
              <div class="flavor-item">
                <div class="flavor-item-top" style="gap:8px;">
                  <input type="text" data-flabel="${idx}" value="${esc(f.label)}" title="编辑参数显示名称" style="flex:1;min-width:0;background:transparent;border:1px solid transparent;border-radius:4px;padding:2px 5px;font-weight:500;" />
                  <select data-ftype="${idx}" title="切换参数控件类型" style="background:var(--bg0);border:1px solid var(--line2);border-radius:4px;padding:2px 6px;font-size:11.5px;color:var(--dim);">
                    <option value="text" ${f.type === 'text' || !f.type ? 'selected' : ''}>文本</option>
                    <option value="select" ${f.type === 'select' ? 'selected' : ''}>下拉</option>
                    <option value="boolean" ${f.type === 'boolean' ? 'selected' : ''}>开关</option>
                  </select>
                  <button type="button" class="sbtn ghost small" data-del-flavor="${idx}">删除</button>
                </div>
                ${f.type === 'select' ? `
                  <select class="field-ctl" data-fval="${idx}" style="background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:6px 9px;">
                    ${(f.options || []).map((opt) => `<option value="${esc(opt)}" ${opt === f.value ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
                  </select>
                  <input type="text" data-fopts="${idx}" value="${esc((f.options || []).join(' / '))}" placeholder="备选项（用 / 分隔）" style="background:var(--bg0);border:1px dashed var(--line2);border-radius:4px;padding:4px 8px;font-size:11.5px;color:var(--dim);" />
                ` : f.type === 'boolean' ? `
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 4px;">
                    <input type="checkbox" data-fbool="${idx}" ${f.value ? 'checked' : ''} />
                    <span>${f.value ? '已启用 (true)' : '已关闭 (false)'}</span>
                  </label>
                ` : `
                  <input type="text" data-ftext="${idx}" value="${esc(String(f.value ?? ''))}" style="background:var(--bg0);border:1px solid var(--line2);border-radius:5px;padding:6px 9px;" />
                `}
                ${f.hint ? `<span class="dim" style="font-size:11.5px;">${esc(f.hint)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-head"><span>技能包基础档案</span><span class="mono dim">METADATA</span></div>
          <label class="field">
            <span>唯一标识 ID (英文小写与连字符)</span>
            <input type="text" id="metaId" value="${esc(s.id)}" ${st.studioIsNew ? '' : 'readonly'} placeholder="例如: custom-latex-helper" />
          </label>
          <label class="field">
            <span>所属板块轮盘</span>
            <select id="metaCat">
              ${st.dashboard.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === s.categoryId ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span>技能包名称</span>
            <input type="text" id="metaTitle" value="${esc(s.title)}" placeholder="清晰直白的专业名称" />
          </label>
          <label class="field">
            <span>AI 自动触发条件 (常驻宿主上下文索引，保持精炼客观)</span>
            <textarea id="metaSummary" rows="2" placeholder="说明该技能包在什么任务场景下由 AI 自动启用…">${esc(s.summary)}</textarea>
          </label>
          <label class="field">
            <span>📖 详细注解与个人备注 (纯给你自己看的说明书/使用备忘，不占 AI 上下文)</span>
            <textarea id="metaAnnotation" rows="4" placeholder="记录这个技能里面装了什么脚本、适用范围、局限性或你自己的使用心得…">${esc(s.annotation || '')}</textarea>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <label class="field">
              <span>来源性质</span>
              <select id="metaOrigin">
                <option value="bespoke" ${s.origin === 'bespoke' ? 'selected' : ''}>自研精制 (Bespoke)</option>
                <option value="official" ${s.origin === 'official' ? 'selected' : ''}>官方原厂 (Official)</option>
                <option value="github-verified" ${s.origin === 'github-verified' ? 'selected' : ''}>GitHub 严选</option>
              </select>
            </label>
            <label class="field">
              <span>版本号 (SemVer)</span>
              <input type="text" id="metaVersion" value="${esc(s.version || '1.0.0')}" />
            </label>
          </div>
          <label class="field">
            <span>官方 / GitHub 溯源链接 (可选，仅限可信 HTTPS 源)</span>
            <input type="url" id="metaSourceUrl" value="${esc(s.sourceUrl || '')}" placeholder="https://github.com/..." />
          </label>
          <label class="field">
            <span>标签 (逗号分隔)</span>
            <input type="text" id="metaTags" value="${esc((s.tags || []).join(', '))}" placeholder="例如: LaTeX, 架构, 引文核验" />
          </label>
        </div>
      `;

      elLeft.querySelectorAll('[data-studio-agent]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncRightEditorToState();
          const k = btn.getAttribute('data-studio-agent');
          s.assigned[k] = !s.assigned[k];
          renderStudio();
        });
      });
      elLeft.querySelectorAll('[data-flabel]').forEach((inp) => {
        inp.addEventListener('input', () => {
          s.flavor[parseInt(inp.getAttribute('data-flabel'), 10)].label = inp.value;
        });
      });
      elLeft.querySelectorAll('[data-ftype]').forEach((sel) => {
        sel.addEventListener('change', () => {
          syncRightEditorToState();
          const item = s.flavor[parseInt(sel.getAttribute('data-ftype'), 10)];
          item.type = sel.value;
          if (sel.value === 'boolean') {
            item.value = Boolean(item.value && item.value !== 'false');
            delete item.options;
          } else if (sel.value === 'select') {
            item.options = Array.isArray(item.options) && item.options.length ? item.options : [String(item.value || '标准档'), '进阶档'];
            item.value = item.options[0];
          } else {
            item.value = String(item.value ?? '');
            delete item.options;
          }
          renderStudio();
        });
      });
      elLeft.querySelectorAll('[data-fopts]').forEach((inp) => {
        inp.addEventListener('change', () => {
          syncRightEditorToState();
          const item = s.flavor[parseInt(inp.getAttribute('data-fopts'), 10)];
          const opts = inp.value.split(/\s*\/\s*|\s*[,，]\s*/).map((x) => x.trim()).filter(Boolean);
          if (opts.length > 0) {
            item.options = opts;
            if (!opts.includes(item.value)) item.value = opts[0];
            renderStudio();
          }
        });
      });
      elLeft.querySelectorAll('[data-fval]').forEach((sel) => {
        sel.addEventListener('change', () => { s.flavor[parseInt(sel.getAttribute('data-fval'), 10)].value = sel.value; });
      });
      elLeft.querySelectorAll('[data-fbool]').forEach((chk) => {
        chk.addEventListener('change', () => {
          syncRightEditorToState();
          s.flavor[parseInt(chk.getAttribute('data-fbool'), 10)].value = chk.checked;
          renderStudio();
        });
      });
      elLeft.querySelectorAll('[data-ftext]').forEach((inp) => {
        inp.addEventListener('input', () => { s.flavor[parseInt(inp.getAttribute('data-ftext'), 10)].value = inp.value; });
      });
      elLeft.querySelectorAll('[data-del-flavor]').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncRightEditorToState();
          s.flavor.splice(parseInt(btn.getAttribute('data-del-flavor'), 10), 1);
          renderStudio();
        });
      });
      document.getElementById('btnAddFlavor').addEventListener('click', () => {
        syncRightEditorToState();
        s.flavor = s.flavor || [];
        const usedKeys = new Set(s.flavor.map((x) => x.key));
        let n = s.flavor.length + 1;
        while (usedKeys.has(`param_${n}`)) n++;
        s.flavor.push({ key: `param_${n}`, label: `自定义参数项 ${n}`, type: 'text', value: '默认设定', hint: '' });
        renderStudio();
      });

      const btnStudioDrift = document.getElementById('btnStudioDrift');
      if (btnStudioDrift) btnStudioDrift.addEventListener('click', () => openDriftModal(s.id));

      document.getElementById('editorMarkdown').value = s.body || '';
      document.getElementById('btnDeleteSkill').hidden = st.studioIsNew;
      document.getElementById('btnOpenFolder').hidden = st.studioIsNew;
      renderScriptPane();
      renderStudioSecurity(s.security);
      switchStudioTab(st.activeTab);
    }

    let activeDriftSkillId = null;
    let activeDriftLiveHash = null;
    async function openDriftModal(skillId) {
      try {
        const info = await rpc('inspectSkillDrift', { skillId });
        activeDriftSkillId = skillId;
        activeDriftLiveHash = info.liveHash || null;
        const sumEl = document.getElementById('driftSummary');
        const diffEl = document.getElementById('driftDiffBox');
        const btnAdopt = document.getElementById('btnDriftAdopt');
        const btnRestore = document.getElementById('btnDriftRestore');
        if (sumEl) {
          sumEl.innerHTML = `技能 <code class="mono">${esc(skillId)}</code> · 基线哈希 <code class="mono">${esc((info.stampedHash || '').slice(0, 10))}</code> → 当前磁盘 <code class="mono">${esc((info.liveHash || '').slice(0, 10))}</code> · 启发式检查：<strong>${esc(info.security.verdict)}</strong> (${esc(info.security.score)}/100)`;
        }
        if (diffEl) {
          diffEl.innerHTML = (info.diffText || '（无可见文本差异）').split('\n').map((line) => {
            if (line.startsWith('+ ')) return `<span class="diff-add">${esc(line)}</span>`;
            if (line.startsWith('- ')) return `<span class="diff-del">${esc(line)}</span>`;
            return esc(line);
          }).join('\n');
        }
        if (btnAdopt) btnAdopt.disabled = Boolean(!info.hasBaselineCopy || !info.security.passed || !info.scannable);
        if (btnRestore) btnRestore.disabled = !info.hasBaselineCopy;
        document.getElementById('dlgDrift').showModal();
      } catch (err) {
        showToast(err.message, true);
      }
    }

    async function saveStudioSkill(syncNow) {
      syncRightEditorToState();
      const st = getState();
      const s = st.studioSkill;
      try {
        const out = await rpc('saveSkill', {
          skill: {
            id: s.id,
            categoryId: s.categoryId,
            title: s.title,
            summary: s.summary,
            annotation: s.annotation || '',
            origin: s.origin,
            sourceUrl: s.sourceUrl,
            version: s.version,
            tags: s.tags,
            flavor: s.flavor,
            body: s.body,
            scripts: s.scriptFiles,
            removeScripts: Array.isArray(s.removedScripts) && s.removedScripts.length ? s.removedScripts : undefined,
            references: s.referenceFiles,
            assigned: s.assigned
          },
          syncNow
        });
        st.studioIsNew = false;
        st.studioSkill = structuredClone(out.skill);
        onDashboardUpdated(out.dashboard, out.skill.categoryId);
        renderStudio();
        const warnNote = out.syncReport && out.syncReport.warnings && out.syncReport.warnings.length
          ? `（注：${out.syncReport.warnings[0]}）`
          : '';
        showToast((syncNow ? `已保存「${out.skill.title}」并同步至 DeepSeek Harness` : `已保存「${out.skill.title}」（已生成快照）`) + warnNote);
      } catch (err) {
        if (err.details) {
          s.security = err.details;
          renderStudioSecurity(err.details);
          switchStudioTab('security');
        }
        showToast(err.message, true);
      }
    }

    function wireDomEvents() {
      document.querySelectorAll('.stab').forEach((btn) => {
        btn.addEventListener('click', () => switchStudioTab(btn.getAttribute('data-tab')));
      });
      document.getElementById('btnSaveOnly').addEventListener('click', () => saveStudioSkill(false));
      document.getElementById('btnSaveAndSync').addEventListener('click', () => saveStudioSkill(true));
      document.getElementById('btnCancelStudio').addEventListener('click', () => onExitStudio());
      document.getElementById('btnOpenFolder').addEventListener('click', () => {
        const s = getState().studioSkill;
        if (s && s.id) rpc('openCatalogFolder', { skillId: s.id });
      });

      const runDriftDecision = async (decision) => {
        if (!activeDriftSkillId) return;
        try {
          const out = await rpc('resolveSkillDrift', {
            skillId: activeDriftSkillId,
            decision,
            expectedLiveHash: activeDriftLiveHash
          });
          document.getElementById('dlgDrift').close();
          onDashboardUpdated(out.dashboard);
          const st = getState();
          if (st.tier === 'studio' && st.studioSkill && st.studioSkill.id === activeDriftSkillId) {
            st.studioSkill = structuredClone(out.result.skill);
            renderStudio();
          }
          showToast(decision === 'adopt' ? '已采纳磁盘改动并重新盖章同步！' : '已将该技能单卡还原至入库基线！');
        } catch (err) {
          showToast(err.message, true);
        }
      };
      const btnAdopt = document.getElementById('btnDriftAdopt');
      if (btnAdopt) btnAdopt.addEventListener('click', () => runDriftDecision('adopt'));
      const btnRestore = document.getElementById('btnDriftRestore');
      if (btnRestore) btnRestore.addEventListener('click', () => runDriftDecision('restore'));

      const dlgConfirm = document.getElementById('dlgConfirmDelete');
      document.getElementById('btnDeleteSkill').addEventListener('click', () => {
        const st = getState();
        const s = st.studioSkill;
        if (!s || st.studioIsNew) return;
        document.getElementById('confirmDeleteText').textContent =
          `确定要下架移除「${s.title}」吗？下架前会自动创建完整 SHA-256 快照，随时可在「快照版本」一键无损恢复。`;
        dlgConfirm.showModal();
      });

      document.getElementById('btnConfirmDeleteYes').addEventListener('click', async () => {
        const st = getState();
        const s = st.studioSkill;
        dlgConfirm.close();
        if (!s || st.studioIsNew) return;
        try {
          const out = await rpc('deleteSkill', { skillId: s.id });
          onDashboardUpdated(out.dashboard);
          onExitStudio();
          showToast(`已下架「${s.title}」（已留存安全快照）`);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    return { renderStudio, renderSecurityHtml, saveStudioSkill, openDriftModal, wireDomEvents };
  }

  return { createStudioController };
})();
