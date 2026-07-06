(function () {
  'use strict';

  const WORK_FILE = 'Program.cs';

  const STATE = {
    overlayMode: null, // null | 'docs' | 'solutions'
    docs: [],
    solutions: [],
    activeDocId: null,
    activeSolutionId: null,
    buildRunning: false,
    content: '',
    savedContent: '',
    dirty: false,
    diagnostics: [],
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showToast(message, type) {
    const root = $('#toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function setRunState(running) {
    const el = $('#status-run-state');
    if (!el) return;
    el.textContent = running ? '● Running…' : '';
    el.classList.toggle('running', running);
    $('#btn-run').disabled = running;
    $('#btn-build').disabled = running;
  }

  function updateDirtyTab() {
    $('#main-tab').classList.toggle('dirty', STATE.dirty);
  }

  async function fetchApi(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (res.status === 502) {
        throw new Error('Сборка упала (502): сервер Render перегружен. Подождите 1 мин и нажмите F5 снова.');
      }
      throw new Error(res.ok ? 'Некорректный ответ сервера' : 'Сервер недоступен. Обновите страницу.');
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const KEYWORDS = new Set([
    'using', 'namespace', 'class', 'public', 'private', 'protected', 'internal', 'static', 'void',
    'async', 'await', 'return', 'if', 'else', 'throw', 'new', 'var', 'for', 'foreach', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'true', 'false', 'null',
    'int', 'double', 'float', 'decimal', 'long', 'short', 'byte', 'char', 'string', 'bool',
    'object', 'dynamic', 'sealed', 'readonly', 'const', 'struct', 'enum', 'interface', 'override',
    'virtual', 'abstract', 'base', 'this', 'in', 'out', 'ref', 'params',
  ]);

  function highlightLine(line) {
    if (!line) return '\u00a0';

    const tokens = [];
    let i = 0;

    while (i < line.length) {
      if (line.startsWith('//', i)) {
        tokens.push({ kind: 'comment', text: line.slice(i) });
        break;
      }

      if (line[i] === '"') {
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') {
            j += 2;
            continue;
          }
          if (line[j] === '"') {
            j++;
            break;
          }
          j++;
        }
        tokens.push({ kind: 'string', text: line.slice(i, j) });
        i = j;
        continue;
      }

      const word = line.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (word) {
        tokens.push({ kind: 'word', text: word[0] });
        i += word[0].length;
        continue;
      }

      tokens.push({ kind: 'other', text: line[i] });
      i += 1;
    }

    return tokens
      .map((token) => {
        const text = escapeHtml(token.text);
        if (token.kind === 'comment') return `<span class="cm">${text}</span>`;
        if (token.kind === 'string') return `<span class="st">${text}</span>`;
        if (token.kind === 'word') {
          if (KEYWORDS.has(token.text)) return `<span class="kw">${text}</span>`;
          if (/^[A-Z]/.test(token.text)) return `<span class="ty">${text}</span>`;
        }
        return text;
      })
      .join('');
  }

  function getLineSeverity(lineNum) {
    const items = STATE.diagnostics.filter((d) => d.line === lineNum);
    if (items.some((d) => d.severity === 'error')) return 'error';
    if (items.some((d) => d.severity === 'warning')) return 'warning';
    return '';
  }

  function splitLines(code) {
    return code.split('\n');
  }

  function highlightCode(code) {
    return splitLines(code)
      .map((line, index) => {
        const severity = getLineSeverity(index + 1);
        const cls = severity ? `code-line line-${severity}` : 'code-line';
        return `<span class="${cls}">${highlightLine(line)}</span>`;
      })
      .join('');
  }

  function syncEditorHeight() {
    const input = $('#code-input');
    const highlight = $('#code-highlight');
    const scroll = $('#editor-scroll');
    if (!input || !highlight || !scroll) return;

    const lineCount = Math.max(splitLines(input.value).length, 1);
    const height = Math.max(scroll.clientHeight, lineCount * 19 + 16);
    input.style.height = height + 'px';
    highlight.style.height = height + 'px';
  }

  function updateLineNumbers(code) {
    const count = Math.max(splitLines(code).length, 1);
    $('#line-numbers').innerHTML = Array.from({ length: count }, (_, i) => {
      const lineNum = i + 1;
      const severity = getLineSeverity(lineNum);
      const cls = severity ? ` class="line-${severity}"` : '';
      return `<span${cls}>${lineNum}</span>`;
    }).join('');
  }

  function setDiagnostics(items) {
    STATE.diagnostics = items || [];
    renderProblems();
    renderEditor();
    updateDiagnostics(
      STATE.diagnostics.filter((d) => d.severity === 'error').length,
      STATE.diagnostics.filter((d) => d.severity === 'warning').length
    );
  }

  function renderProblems() {
    const body = $('#problems-body');
    const badge = $('#problems-badge');
    const count = STATE.diagnostics.length;
    if (!body) return;

    if (count === 0) {
      body.innerHTML = '<div class="problems-empty">Проблем не обнаружено</div>';
      badge.classList.add('hidden');
      badge.textContent = '0';
      return;
    }

    badge.classList.remove('hidden');
    badge.textContent = String(count);
    body.innerHTML = STATE.diagnostics
      .map(
        (d, idx) => `<div class="problem-item ${d.severity}" data-idx="${idx}">
          <span class="problem-icon">${d.severity === 'error' ? '✕' : '⚠'}</span>
          <div>
            <div class="problem-title">${escapeHtml(d.message)}</div>
            <div class="problem-meta">${escapeHtml(d.file)}(${d.line},${d.column}) · ${escapeHtml(d.code)}</div>
          </div>
        </div>`
      )
      .join('');

    body.querySelectorAll('.problem-item').forEach((el) => {
      el.addEventListener('click', () => {
        const d = STATE.diagnostics[Number(el.dataset.idx)];
        if (d) scrollToLine(d.line, d.column);
      });
    });
  }

  function scrollToLine(line, column) {
    const scroll = $('#editor-scroll');
    const lineHeight = 19;
    const padding = 8;
    const top = padding + (line - 1) * lineHeight;
    scroll.scrollTop = Math.max(0, top - scroll.clientHeight / 3);
    $('#line-numbers').scrollTop = scroll.scrollTop;

    const input = $('#code-input');
    const lines = input.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1; i++) pos += (lines[i] || '').length + 1;
    pos += Math.max(0, (column || 1) - 1);
    input.focus();
    input.setSelectionRange(pos, pos);
    updateCursorPosition();
  }

  function showPanel(name) {
    const terminal = $('#terminal-body');
    const problems = $('#problems-body');
    $$('.terminal-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.panel === name);
    });
    if (name === 'problems') {
      terminal.classList.add('hidden');
      problems.classList.remove('hidden');
    } else {
      terminal.classList.remove('hidden');
      problems.classList.add('hidden');
    }
  }

  function updateCursorPosition() {
    const input = $('#code-input');
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = (before.split('\n').pop() || '').length + 1;
    $('#status-cursor').textContent = `Ln ${line}, Col ${col}`;
  }

  function commitEditor() {
    STATE.content = $('#code-input').value;
    STATE.dirty = STATE.content !== STATE.savedContent;
    $('#titlebar-title').textContent = `Program.cs${STATE.dirty ? ' *' : ''} — Compiler`;
    updateDirtyTab();
  }

  function renderEditor() {
    const input = $('#code-input');
    input.value = STATE.content;
    $('#code-highlight').innerHTML = highlightCode(STATE.content);
    updateLineNumbers(STATE.content);
    syncEditorHeight();
    updateCursorPosition();
    $('#breadcrumb').innerHTML = '<span style="color:var(--text-primary)">Program.cs</span>';
    $('#titlebar-title').textContent = `Program.cs${STATE.dirty ? ' *' : ''} — Compiler`;
  }

  async function loadProgram() {
    const data = await fetchApi('/api/file?path=' + encodeURIComponent(WORK_FILE));
    if (!data.success) throw new Error(data.error || 'Не удалось открыть Program.cs');
    STATE.content = data.content;
    STATE.savedContent = data.content;
    STATE.dirty = false;
    renderEditor();
  }

  async function saveProgram() {
    commitEditor();
    const data = await fetchApi('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: WORK_FILE, content: STATE.content }),
    });
    if (!data.success) throw new Error(data.error || 'Ошибка сохранения');
    if (data.content && data.content !== STATE.content) {
      STATE.content = data.content;
      STATE.savedContent = data.content;
      renderEditor();
    } else {
      STATE.savedContent = STATE.content;
    }
    STATE.dirty = false;
    updateDirtyTab();
    $('#titlebar-title').textContent = 'Program.cs — Compiler';
    return data.corrected;
  }

  function appendTerminalLine(body, text, cls) {
    if (!text) return;
    const div = document.createElement('div');
    div.className = 'terminal-line' + (cls ? ' ' + cls : '');
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function appendPrompt(body) {
    const div = document.createElement('div');
    div.className = 'terminal-line';
    div.innerHTML = 'PS C:\\Projects\\Compiler> <span class="terminal-cursor"></span>';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function updateDiagnostics(errors, warnings) {
    $('#status-errors-count').textContent = String(errors);
    $('#status-warnings-count').textContent = String(warnings);
  }

  function showProgramOutput(payload) {
    const bar = $('#program-output-bar');
    const body = $('#program-output-body');
    const meta = $('#program-output-meta');
    if (!payload || (typeof payload === 'object' && !payload.blocks?.length && !payload.raw)) {
      bar.classList.add('hidden');
      body.innerHTML = '';
      meta.textContent = '';
      return;
    }

    bar.classList.remove('hidden');

    if (typeof payload === 'string') {
      meta.textContent = '';
      body.innerHTML = `<pre class="program-output-text">${escapeHtml(payload)}</pre>`;
      return;
    }

    meta.textContent = payload.stdinNote || '';
    const blockLabels = ['Инициализация', 'После ввода', 'Результат', 'Вывод'];
    body.innerHTML = payload.blocks.map((block, i) => {
      const title = blockLabels[i] || `Вывод ${i + 1}`;
      if (block.type === 'vars') {
        const vars = Object.entries(block.vars)
          .map(([name, value]) => `<div class="output-var"><span class="output-var-name">${escapeHtml(name)}</span><span class="output-var-value">${escapeHtml(value)}</span></div>`)
          .join('');
        return `<div class="output-block"><div class="output-block-title">${escapeHtml(title)}</div><div class="output-vars">${vars}</div></div>`;
      }
      return `<div class="output-block"><div class="output-block-title">${escapeHtml(title)}</div><div class="output-text-line">${escapeHtml(block.text)}</div></div>`;
    }).join('');
  }

  function displayBuildResult(result) {
    const body = $('#terminal-body');
    result.lines.forEach((line) => appendTerminalLine(body, line.text, line.cls));

    const diagnostics = result.diagnostics || [];
    setDiagnostics(diagnostics);

    if (result.success && result.programOutput) {
      showProgramOutput(result.programOutput);
      showPanel('terminal');
    } else if (result.success) {
      showProgramOutput('');
    } else {
      showProgramOutput('');
    }

    if (diagnostics.length > 0) {
      showPanel('problems');
      scrollToLine(diagnostics[0].line, diagnostics[0].column);
    }
  }

  async function executeBuild({ runAfter = true } = {}) {
    if (STATE.buildRunning) return;
    STATE.buildRunning = true;
    setRunState(true);
    const body = $('#terminal-body');
    const endpoint = runAfter ? '/api/run' : '/api/build';
    $('#terminal-panel').classList.remove('collapsed');
    $('#panel-resizer').classList.remove('hidden');
    body.innerHTML = '';

    try {
      appendTerminalLine(body, 'Сохранение Program.cs...', 'dim');
      const corrected = await saveProgram();
      if (corrected) {
        appendTerminalLine(body, 'Автоисправление: Writeline → WriteLine, using System', 'warn');
        showToast('Код автоматически исправлен', 'success');
      }
      appendTerminalLine(body, runAfter ? 'Сборка и запуск...' : 'Сборка...', 'dim');
      const result = await fetchApi(endpoint, { method: 'POST' });
      displayBuildResult(result);
      if (result.success) {
        showToast(runAfter ? 'Программа выполнена' : 'Сборка успешна', 'success');
      } else if ((result.diagnostics || []).length === 0) {
        showToast('Ошибка сборки — см. TERMINAL', 'error');
      }
    } catch (err) {
      appendTerminalLine(body, String(err.message || err), 'error');
      setDiagnostics([]);
      updateDiagnostics(1, 0);
      showToast(String(err.message || err), 'error');
    }

    appendPrompt(body);
    STATE.buildRunning = false;
    setRunState(false);
  }

  async function runBuild() {
    await executeBuild({ runAfter: true });
  }

  async function runBuildOnly() {
    await executeBuild({ runAfter: false });
  }

  function insertSolutionIntoEditor(code) {
    if (!code) return;
    closeOverlay();
    STATE.content = code;
    STATE.dirty = true;
    renderEditor();
    $('#code-input').focus();
    showToast('Код вставлен в Program.cs — нажмите F5', 'success');
  }

  async function copySolutionCode(code) {
    try {
      await navigator.clipboard.writeText(code);
      showToast('Код скопирован в буфер обмена', 'success');
    } catch {
      showToast('Не удалось скопировать', 'error');
    }
  }

  async function loadSolutions() {
    try {
      const res = await fetch('solutions.json');
      STATE.solutions = res.ok ? await res.json() : [];
    } catch {
      STATE.solutions = [];
    }
    renderSolutionsSidebar();
    if (STATE.solutions.length) selectSolution(STATE.solutions[0].id);
    else $('#solutions-content').innerHTML = '<div class="docs-empty">Добавьте решения в solutions.json</div>';
  }

  function renderSolutionsSidebar(filter) {
    const q = (filter || '').toLowerCase().trim();
    $('#solutions-sidebar').innerHTML = STATE.solutions
      .map((item) => {
        const hay = `${item.id} ${item.title} ${item.formula} ${item.code}`.toLowerCase();
        const match = !q || hay.includes(q);
        return `<div class="docs-topic${item.id === STATE.activeSolutionId ? ' active' : ''}${match ? '' : ' hidden-by-search'}" data-id="${item.id}">
          <span class="docs-topic-id">#${item.id}</span><span class="docs-topic-title">${escapeHtml(item.title)}</span></div>`;
      })
      .join('');
    $('#solutions-sidebar').querySelectorAll('.docs-topic').forEach((el) => {
      el.addEventListener('click', () => selectSolution(el.dataset.id));
    });
  }

  function selectSolution(id) {
    STATE.activeSolutionId = id;
    const item = STATE.solutions.find((s) => s.id === id);
    if (!item) return;
    renderSolutionsSidebar($('#solutions-search').value);
    const body = [
      `<h2>${escapeHtml(item.title)}</h2>`,
      `<div class="solutions-formula">${escapeHtml(item.formula)}</div>`,
      `<div class="solution-actions">
        <button type="button" class="solution-btn solution-btn-primary" data-action="insert" data-id="${escapeHtml(item.id)}">Вставить в редактор</button>
        <button type="button" class="solution-btn" data-action="copy" data-id="${escapeHtml(item.id)}">Копировать</button>
      </div>`,
      '<h3>Код на C#</h3>',
      `<pre><code>${escapeHtml(item.code)}</code></pre>`,
    ].join('\n');
    $('#solutions-content').innerHTML = body;
  }

  function initSolutionsActions() {
    $('#solutions-content').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const item = STATE.solutions.find((s) => s.id === btn.dataset.id);
      if (!item) return;
      if (btn.dataset.action === 'insert') insertSolutionIntoEditor(item.code);
      if (btn.dataset.action === 'copy') copySolutionCode(item.code);
    });
  }

  async function loadDocs() {
    try {
      const res = await fetch('docs.json');
      STATE.docs = res.ok ? await res.json() : [];
    } catch {
      STATE.docs = [];
    }
    renderDocsSidebar();
    if (STATE.docs.length) selectDoc(STATE.docs[0].id);
    else $('#docs-content').innerHTML = '<div class="docs-empty">Добавьте билеты в docs.json</div>';
  }

  function renderDocsSidebar(filter) {
    const q = (filter || '').toLowerCase().trim();
    $('#docs-sidebar').innerHTML = STATE.docs
      .map((doc) => {
        const match = !q || doc.id.toLowerCase().includes(q) || doc.title.toLowerCase().includes(q) || doc.content.toLowerCase().includes(q);
        return `<div class="docs-topic${doc.id === STATE.activeDocId ? ' active' : ''}${match ? '' : ' hidden-by-search'}" data-id="${doc.id}">
          <span class="docs-topic-id">#${doc.id}</span><span class="docs-topic-title">${escapeHtml(doc.title)}</span></div>`;
      })
      .join('');
    $('#docs-sidebar').querySelectorAll('.docs-topic').forEach((el) => {
      el.addEventListener('click', () => selectDoc(el.dataset.id));
    });
  }

  function selectDoc(id) {
    STATE.activeDocId = id;
    const doc = STATE.docs.find((d) => d.id === id);
    if (!doc) return;
    renderDocsSidebar($('#docs-search').value);
    $('#docs-content').innerHTML = markdownToHtml(doc.content);
  }

  function markdownToHtml(md) {
    const lines = md.split('\n');
    const out = [];
    let inUl = false, inOl = false, inPre = false, preBuf = [];
    const close = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
    const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const line of lines) {
      if (inPre) {
        if (line.trim() === '```') { out.push('<pre><code>' + escapeHtml(preBuf.join('\n')) + '</code></pre>'); preBuf = []; inPre = false; }
        else preBuf.push(line);
        continue;
      }
      if (line.trim().startsWith('```')) { close(); inPre = true; continue; }
      if (line.startsWith('## ')) { close(); out.push('<h2>' + inline(line.slice(3)) + '</h2>'); continue; }
      if (line.startsWith('### ')) { close(); out.push('<h3>' + inline(line.slice(4)) + '</h3>'); continue; }
      if (line.startsWith('> ')) { close(); out.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>'); continue; }
      const ul = line.match(/^- (.+)$/); if (ul) { if (!inUl) { close(); out.push('<ul>'); inUl = true; } out.push('<li>' + inline(ul[1]) + '</li>'); continue; }
      const ol = line.match(/^\d+\. (.+)$/); if (ol) { if (!inOl) { close(); out.push('<ol>'); inOl = true; } out.push('<li>' + inline(ol[1]) + '</li>'); continue; }
      close();
      out.push(line.trim() === '' ? '' : '<p>' + inline(line) + '</p>');
    }
    close();
    return out.join('\n');
  }

  function openOverlay(mode) {
    if (STATE.overlayMode === mode) {
      closeOverlay();
      return;
    }
    STATE.overlayMode = mode;
    $('#code-view').classList.add('hidden');
    $('#docs-view').classList.toggle('active', mode === 'docs');
    $('#solutions-view').classList.toggle('active', mode === 'solutions');
    if (mode === 'docs') {
      $('#breadcrumb').innerHTML = '<span>docs</span><span class="sep">›</span><span style="color:var(--text-primary)">Билеты</span>';
      $('#docs-search').focus();
    } else {
      $('#breadcrumb').innerHTML = '<span>solutions</span><span class="sep">›</span><span style="color:var(--text-primary)">Задания</span>';
      $('#solutions-search').focus();
    }
  }

  function closeOverlay() {
    if (!STATE.overlayMode) return;
    STATE.overlayMode = null;
    $('#code-view').classList.remove('hidden');
    $('#docs-view').classList.remove('active');
    $('#solutions-view').classList.remove('active');
    renderEditor();
  }

  function toggleDocsMode() {
    openOverlay('docs');
  }

  function toggleSolutionsMode() {
    openOverlay('solutions');
  }

  function initEditor() {
    const input = $('#code-input');
    const scroll = $('#editor-scroll');
    input.addEventListener('input', () => {
      commitEditor();
      if (STATE.diagnostics.length) setDiagnostics([]);
      showProgramOutput('');
      $('#code-highlight').innerHTML = highlightCode(STATE.content);
      updateLineNumbers(STATE.content);
      syncEditorHeight();
    });
    input.addEventListener('wheel', (e) => {
      scroll.scrollTop += e.deltaY;
      scroll.scrollLeft += e.deltaX;
      e.preventDefault();
    }, { passive: false });
    scroll.addEventListener('scroll', () => {
      $('#line-numbers').scrollTop = scroll.scrollTop;
    });
    input.addEventListener('click', updateCursorPosition);
    input.addEventListener('keyup', updateCursorPosition);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = input.selectionStart;
        const end = input.selectionEnd;
        input.setRangeText('    ', s, end, 'end');
        input.dispatchEvent(new Event('input'));
      }
    });
  }

  function initPanelResizer() {
    const resizer = $('#panel-resizer');
    const panel = $('#terminal-panel');
    const editorPanel = document.querySelector('.editor-panel');
    const MIN_H = 80;
    const MAX_RATIO = 0.75;

    const saved = localStorage.getItem('terminalHeight');
    if (saved) {
      const h = parseInt(saved, 10);
      if (h >= MIN_H) panel.style.height = h + 'px';
    }

    function syncResizerVisibility() {
      resizer.classList.toggle('hidden', panel.classList.contains('collapsed'));
    }

    function clampHeight(height) {
      const maxH = Math.max(MIN_H, editorPanel.clientHeight * MAX_RATIO);
      return Math.min(Math.max(height, MIN_H), maxH);
    }

    let startY = 0;
    let startH = 0;

    resizer.addEventListener('mousedown', (e) => {
      if (panel.classList.contains('collapsed')) return;
      e.preventDefault();
      startY = e.clientY;
      startH = panel.offsetHeight;
      document.body.classList.add('resizing-panel');

      const onMove = (ev) => {
        const next = clampHeight(startH + (startY - ev.clientY));
        panel.style.height = next + 'px';
      };

      const onUp = () => {
        document.body.classList.remove('resizing-panel');
        localStorage.setItem('terminalHeight', String(panel.offsetHeight));
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        syncEditorHeight();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    resizer.addEventListener('dblclick', () => {
      panel.style.height = '160px';
      localStorage.setItem('terminalHeight', '160');
      syncEditorHeight();
    });

    syncResizerVisibility();
  }

  function initHotkeys() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveProgram().then(() => showToast('Сохранено', 'success')).catch(() => {}); }
      if (e.ctrlKey && e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); runBuildOnly(); }
      if (e.key === 'F5') { e.preventDefault(); runBuild(); }
      if (e.ctrlKey && e.shiftKey && e.key === '1') { e.preventDefault(); toggleDocsMode(); }
      if (e.ctrlKey && e.shiftKey && e.key === '2') { e.preventDefault(); toggleSolutionsMode(); }
      if (e.key === 'Escape' && STATE.overlayMode) { e.preventDefault(); closeOverlay(); }
    });
  }

  async function checkHealth() {
    const el = $('#status-dotnet');
    if (!el) return;
    try {
      const data = await fetchApi('/api/health');
      if (data.dotnet) {
        el.textContent = `● .NET ${data.dotnetVersion || ''}`.trim();
        el.classList.add('ok');
        el.classList.remove('bad');
      } else {
        el.textContent = '● .NET не найден';
        el.classList.add('bad');
        el.classList.remove('ok');
      }
    } catch {
      el.textContent = '● Сервер offline';
      el.classList.add('bad');
      el.classList.remove('ok');
    }
  }

  function initStatusBar() {
    let lastClick = 0;
    $('#status-diagnostics').addEventListener('click', () => {
      const now = Date.now();
      if (now - lastClick < 400) toggleDocsMode();
      lastClick = now;
    });
  }

  function initSearch() {
    $('#docs-search').addEventListener('input', (e) => {
      renderDocsSidebar(e.target.value);
      const q = e.target.value.toLowerCase().trim();
      const visible = STATE.docs.filter((d) => !q || d.id.includes(q) || d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
      if (visible.length && !visible.find((d) => d.id === STATE.activeDocId)) selectDoc(visible[0].id);
      if (!visible.length) $('#docs-content').innerHTML = '<div class="docs-empty">Ничего не найдено</div>';
    });
    $('#solutions-search').addEventListener('input', (e) => {
      renderSolutionsSidebar(e.target.value);
      const q = e.target.value.toLowerCase().trim();
      const visible = STATE.solutions.filter((s) => {
        const hay = `${s.id} ${s.title} ${s.formula} ${s.code}`.toLowerCase();
        return !q || hay.includes(q);
      });
      if (visible.length && !visible.find((s) => s.id === STATE.activeSolutionId)) selectSolution(visible[0].id);
      if (!visible.length) $('#solutions-content').innerHTML = '<div class="docs-empty">Ничего не найдено</div>';
    });
  }

  async function init() {
    initEditor();
    initPanelResizer();
    initHotkeys();
    initStatusBar();
    initSearch();
    initSolutionsActions();
    loadDocs();
    loadSolutions();
    checkHealth();
    renderProblems();
    $('#btn-run').addEventListener('click', runBuild);
    $('#btn-build').addEventListener('click', runBuildOnly);
    $('#btn-save').addEventListener('click', () => saveProgram().catch((e) => appendTerminalLine($('#terminal-body'), e.message, 'error')));
    $('#toggle-terminal').addEventListener('click', () => {
      $('#terminal-panel').classList.toggle('collapsed');
      $('#panel-resizer').classList.toggle('hidden', $('#terminal-panel').classList.contains('collapsed'));
    });
    $$('.terminal-tab').forEach((tab) => {
      tab.addEventListener('click', () => showPanel(tab.dataset.panel));
    });
    $('#status-errors-count').parentElement.addEventListener('click', (e) => {
      if (STATE.diagnostics.length) {
        e.stopPropagation();
        showPanel('problems');
      }
    });
    try {
      await loadProgram();
    } catch (err) {
      appendTerminalLine($('#terminal-body'), err.message, 'error');
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        appendTerminalLine($('#terminal-body'), 'Локально: python server.py', 'dim');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
