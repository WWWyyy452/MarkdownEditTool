// ============================================================
// Markdown Editor — Renderer
// ============================================================
(function () {
  'use strict';

  // ---------- DOM ----------
  const previewEl = document.getElementById('preview');
  const dividerEl = document.getElementById('divider');
  const editorPane = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  const mainContainer = document.getElementById('main-container');
  const titlebarFilename = document.getElementById('titlebar-filename');
  const titlebarTitle = document.getElementById('titlebar-title');
  const collapsedIcon = document.getElementById('collapsed-icon');
  const statusLines = document.getElementById('status-lines');
  const statusWords = document.getElementById('status-words');
  const statusChars = document.getElementById('status-chars');
  const statusCursor = document.getElementById('status-cursor');

  // ---------- State ----------
  let currentFilePath = null;
  let isFloating = false;
  let isCollapsed = false;
  let collapsedEdge = null;        // 'left' | 'top' | 'right'
  let savedBounds = null;           // {x, y} before collapse
  let isDragging = false;           // divider drag
  let isAlwaysOnTop = false;
  let lastPos = [0, 0];             // for edge-snap polling
  let edgePollTimer = null;
  let isLoadingDoc = false;         // suppress dirty-marking while loading docs

  // ---------- Multi-document / tab model ----------
  // Each document holds its own buffer + metadata. CodeMirror always shows the
  // active document; switching saves the active buffer and cursor, then loads
  // the target.
  let documents = [];
  let activeDocId = null;
  let nextDocId = 1;

  function uid() { return 'd' + (nextDocId++) + '_' + Date.now().toString(36); }
  function getActiveDoc() { return documents.find(d => d.id === activeDocId) || null; }

  // ---------- Toast notifications ----------
  function showToast(msg, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(() => {
      t.classList.add('fade-out');
      t.addEventListener('animationend', () => t.remove(), { once: true });
    }, 2500);
  }

  // Pull the live editor state (content + cursor) into a document object.
  function syncEditorToDoc(doc) {
    if (!doc) return;
    doc.content = cm.getValue();
    doc.cursor = cm.getCursor();
  }
  function loadDocIntoEditor(doc) {
    if (!doc) return;
    isLoadingDoc = true;
    cm.setValue(doc.content || '');
    cm.setCursor(doc.cursor || { line: 0, ch: 0 });
    isLoadingDoc = false;
    cm.focus();
  }
  // Create a document, add to the list, and make it active.
  function createDocument(name, filePath, content) {
    const doc = {
      id: uid(),
      name: name || '未命名',
      filePath: filePath || null,
      content: content || '',
      cursor: { line: 0, ch: 0 },
      dirty: false,
      versions: [],
    };
    documents.push(doc);
    switchDocument(doc.id);
    return doc;
  }
  function switchDocument(id) {
    const t = documents.find(d => d.id === id);
    if (!t || t.id === activeDocId) { renderTabs(); return; }
    // persist current editor state into outgoing doc
    const cur = getActiveDoc();
    if (cur) syncEditorToDoc(cur);
    activeDocId = t.id;
    loadDocIntoEditor(t);
    // keep module-level "currentFilePath" in sync for the pieces that use it
    currentFilePath = t.filePath || null;
    renderTabs();
    // update title bar + status
    updateTitleBar(t);
    renderPreview();
    updateStatus();
  }
  function updateTitleBar(doc) {
    if (!doc) { titlebarFilename.textContent = ''; titlebarTitle.textContent = 'Markdown Editor'; return; }
    titlebarTitle.textContent = doc.name;
    titlebarFilename.textContent = doc.filePath ? '— ' + doc.filePath : '';
  }
  // Save a document. Returns true on success (or no path + user cancels save-as →
  // treated as "proceed without saving" so the caller can still close).
  async function saveDocument(doc) {
    if (!doc) return true;
    syncEditorToDoc(doc);
    let filePath = doc.filePath;
    let content = doc.content;
    // No saved path yet → ask the user for a location
    if (!filePath) {
      const chosen = await window.api.saveFile(content);
      if (!chosen) return false; // user cancelled save-as → treat as discard
      filePath = chosen;
    } else {
      const ok = await window.api.writeFileByPath(filePath, content);
      if (!ok) return false;
    }
    const name = filePath.split(/[\\/]/).pop();
    doc.filePath = filePath;
    doc.name = name;
    doc.dirty = false;
    doc.content = content;
    currentFilePath = filePath;
    updateTitleBar(doc);
    renderTabs();
    return true;
  }
  async function closeDocument(id) {
    const idx = documents.findIndex(d => d.id === id);
    if (idx === -1) return;
    const doc = documents[idx];
    // If there are unsaved changes, ask the user what to do
    if (doc.dirty) {
      const choice = await window.api.savePrompt(doc.name);
      if (choice === 'cancel') return; // keep the tab open
      if (choice === 'save') {
        const saved = await saveDocument(doc);
        if (!saved) return; // save failed or user cancelled save-as → keep tab open
      }
      // choice === 'discard' → just close
    }
    // If it's the only document, replace with a blank untitled one instead of leaving zero
    if (documents.length === 1) {
      documents.splice(idx, 1);
      activeDocId = null;
      createDocument('未命名', null, '');
      return;
    }
    documents.splice(idx, 1);
    if (activeDocId === id) {
      const next = documents[Math.min(idx, documents.length - 1)];
      switchDocument(next.id);
    } else {
      renderTabs();
    }
  }
  function renderTabs() {
    const list = document.getElementById('tab-list');
    if (!list) return;
    list.innerHTML = '';
    documents.forEach(doc => {
      const tab = document.createElement('div');
      tab.className = 'tab' + (doc.id === activeDocId ? ' active' : '') + (doc.dirty ? ' dirty' : '');
      tab.dataset.id = doc.id;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = doc.name;
      tab.appendChild(name);
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeDocument(doc.id); });
      tab.appendChild(close);
      tab.addEventListener('click', () => switchDocument(doc.id));
      list.appendChild(tab);
    });
  }
  // When a file is opened into the active document (replacing its buffer).
  function openFileIntoActive(filePath, content, name) {
    let doc = getActiveDoc();
    // reuse active doc only if it's the blank untitled starter with no edits
    const reuse = doc && !doc.filePath && !doc.dirty && doc.name === '未命名' && documents.length === 1;
    if (!reuse || filePath) {
      // when opening a real file, prefer a fresh tab
      doc = null;
    }
    if (!doc) {
      doc = createDocument(name, filePath, content);
      recordRecentFile(filePath, name);
      return doc;
    }
    doc.name = name || doc.name;
    doc.filePath = filePath || null;
    doc.content = content;
    doc.cursor = { line: 0, ch: 0 };
    doc.dirty = false;
    activeDocId = doc.id;
    loadDocIntoEditor(doc);
    currentFilePath = doc.filePath;
    updateTitleBar(doc);
    renderTabs();
    renderPreview();
    updateStatus();
    recordRecentFile(filePath, name);
    return doc;
  }

  // ---------- File history (localStorage) ----------
  const HISTORY_KEY = 'md-editor-recent-files';
  const HISTORY_MAX = 12;
  let recentFiles = loadRecentFiles();

  function loadRecentFiles() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch { return []; }
  }
  function saveRecentFiles() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(recentFiles));
  }
  // Record a file (by absolute path) at the front of the history.
  function recordRecentFile(filePath, name) {
    if (!filePath) return;
    recentFiles = recentFiles.filter(f => f.path !== filePath);
    recentFiles.unshift({ path: filePath, name: name || filePath.split(/[\\/]/).pop(), time: Date.now() });
    recentFiles = recentFiles.slice(0, HISTORY_MAX);
    saveRecentFiles();
    renderHistoryDropdown(); // refresh if dropdown is open
  }
  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return '今天 ' + d.toTimeString().slice(0, 5);
    const diff = (now - d) / 86400000;
    if (diff < 2) return '昨天 ' + d.toTimeString().slice(0, 5);
    if (diff < 7) return Math.floor(diff) + ' 天前';
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function renderHistoryDropdown() {
    const list = document.getElementById('history-list');
    if (!list) return;
    if (recentFiles.length === 0) {
      list.innerHTML = '<div class="history-empty">暂无打开记录</div>';
      return;
    }
    list.innerHTML = '';
    recentFiles.forEach((entry, i) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML =
        '<div class="history-item-name">' + escapeHtml(entry.name) + '</div>' +
        '<div class="history-item-path">' + escapeHtml(entry.path) + '</div>' +
        '<div class="history-item-time">' + formatTime(entry.time) + '</div>';
      item.addEventListener('click', () => openRecentFile(entry));
      list.appendChild(item);
    });
  }
  function toggleHistoryDropdown() {
    const dd = document.getElementById('history-dropdown');
    if (!dd) return;
    if (dd.classList.contains('show')) {
      dd.classList.remove('show');
    } else {
      const btn = document.getElementById('btn-history');
      if (btn) {
        const r = btn.getBoundingClientRect();
        dd.style.top = Math.min(r.bottom + 4, window.innerHeight - 200) + 'px';
        dd.style.left = Math.max(8, r.right - 340) + 'px';
      }
      dd.classList.remove('hidden');
      renderHistoryDropdown();
      dd.classList.add('show');
    }
  }
  function hideHistoryDropdown() {
    const dd = document.getElementById('history-dropdown');
    if (dd) { dd.classList.remove('show'); dd.classList.add('hidden'); }
  }
  async function openRecentFile(entry) {
    hideHistoryDropdown();
    try {
      const result = await window.api.readFileByPath(entry.path);
      if (!result || result.error) {
        // file gone — drop it from history and open a notice in a new tab
        recentFiles = recentFiles.filter(f => f.path !== entry.path);
        saveRecentFiles();
        openFileIntoActive(null, '# ⚠️ 文件未找到\n\n`' + entry.path + '`', '未找到');
        return;
      }
      const name = (result.filePath || entry.path).split(/[\\/]/).pop();
      openFileIntoActive(result.filePath, result.content, name);
    } catch (err) { console.error('Open recent failed:', err); }
  }

  // ---------- CodeMirror ----------
  const cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
    mode: 'markdown',
    theme: 'dracula',
    lineNumbers: true,
    lineWrapping: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    tabSize: 2,
    indentWithTabs: false,
    indentUnit: 2,
    extraKeys: {
      Tab: function (c) {
        c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ', 'end');
      },
      'Shift-Tab': function (c) { c.indentSelection('delete'); },
    },
  });

  // ---------- marked config ----------
  const { marked, DOMPurify } = window;
  marked.setOptions({ gfm: true, breaks: false });

  const renderer = new marked.Renderer();
  // Unique ID counter for mermaid blocks
  let mermaidCounter = 0;
  // Code blocks with syntax highlighting (or mermaid placeholder)
  renderer.code = function ({ text, lang }) {
    const language = (lang || 'text').toLowerCase();
    if (language === 'mermaid') {
      const id = 'mermaid-' + (++mermaidCounter);
      return `<div class="mermaid" id="${id}">${escapeHtml(text)}</div>`;
    }
    const highlighted = syntaxHighlight(text, language);
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${langAttr}><code class="lang-${escapeHtml(language)}">${highlighted}</code></pre>`;
  };
  // Task lists: marked v18 GFM natively renders [ ]/[x] checkboxes, no override needed
  marked.use({ renderer });

  // ---------- Mermaid rendering ----------
  let mermaidApi = null;
  function initMermaid() {
    if (mermaidApi) return mermaidApi;
    mermaidApi = window.mermaid.mermaidAPI;
    mermaidApi.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    return mermaidApi;
  }
  // Render all .mermaid blocks in the preview. Called after innerHTML is set.
  function renderMermaidBlocks() {
    const blocks = previewEl.querySelectorAll('.mermaid:not([data-rendered])');
    if (blocks.length === 0) return;
    const api = initMermaid();
    blocks.forEach((block) => {
      const id = block.id;
      const code = block.textContent;
      try {
        api.render(id + '-svg', code).then((svgResult) => {
          block.innerHTML = svgResult.svg;
          block.setAttribute('data-rendered', '1');
        }).catch(() => {
          block.innerHTML = '<pre class="mermaid-error">图表渲染失败</pre>';
          block.setAttribute('data-rendered', '1');
        });
      } catch (e) {
        block.setAttribute('data-rendered', '1');
      }
    });
  }

  // ---------- Syntax highlighter (highlight.js) ----------
  const hljs = window.hljs;
  // Register only the most-used languages to keep the bundle lean; more can be
  // added on demand via hljs.registerLanguage if needed.
  function syntaxHighlight(code, lang) {
    if (!lang || lang === 'text') return escapeHtml(code);
    try {
      // Map common aliases → hljs language id
      const alias = ({
        'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'rb': 'ruby',
        'sh': 'bash', 'shell': 'bash', 'zsh': 'bash', 'yml': 'yaml',
        'md': 'markdown', 'cpp': 'c++', 'hpp': 'c++', 'c': 'c',
        'cs': 'csharp', 'kt': 'kotlin', 'rs': 'rust', 'go': 'golang',
        'ps1': 'powershell', 'docker': 'dockerfile', 'make': 'makefile',
        'tex': 'latex', 'html': 'xml', 'css': 'css', 'json': 'json',
      })[lang.toLowerCase()] || lang.toLowerCase();
      if (hljs.getLanguage(alias)) {
        return hljs.highlight(code, { language: alias, ignoreIllegals: true }).value;
      }
    } catch (e) { /* fall through */ }
    return escapeHtml(code);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- Render preview ----------
  function renderPreview() {
    const md = cm.getValue();
    const rawHtml = marked.parse(md);
    const linkedHtml = linkifyUrls(rawHtml);
    const clean = DOMPurify.sanitize(linkedHtml, {
      ADD_TAGS: ['input', 'div', 'svg', 'span'],
      ADD_ATTR: ['type', 'checked', 'disabled', 'data-lang', 'target', 'rel', 'id', 'class', 'data-rendered', 'viewBox', 'xmlns'],
    });
    previewEl.innerHTML = clean;
    renderMermaidBlocks();
    updateStatus();
  }

  function linkifyUrls(html) {
    const urlRegex = /(https?:\/\/[^\s<>"&]+[^\s<>"&.,;!?)\]])/g;
    return html.replace(/>([^<>]*?)</g, (full, inner) => {
      if (full.includes('href=')) return full;
      return '>' + inner.replace(urlRegex, (url) =>
        `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
      ) + '<';
    });
  }

  // ---------- Status bar ----------
  function updateStatus() {
    const v = cm.getValue();
    const lines = v.split('\n').length;
    const chars = v.length;
    const words = v.trim() ? v.trim().split(/\s+/).length : 0;
    statusLines.textContent = '行: ' + lines;
    statusWords.textContent = '词: ' + words;
    statusChars.textContent = '字符: ' + chars;
    const cursor = cm.getCursor();
    statusCursor.textContent = 'Ln ' + (cursor.line + 1) + ', Col ' + (cursor.ch + 1);
  }

  // ---------- Sync scroll ----------
  let scrollingEditor = false;
  let scrollingPreview = false;
  let scrollTimer = null;

  function syncEditorToPreview() {
    if (scrollingPreview) return;
    const info = cm.getScrollInfo();
    const ratio = info.height - info.clientHeight > 0 ? info.top / (info.height - info.clientHeight) : 0;
    const maxPreview = previewPane.scrollHeight - previewPane.clientHeight;
    scrollingEditor = true;
    previewPane.scrollTop = ratio * maxPreview;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrollingEditor = false; }, 60);
  }

  function syncPreviewToEditor() {
    if (scrollingEditor) return;
    const maxPreview = previewPane.scrollHeight - previewPane.clientHeight;
    const ratio = maxPreview > 0 ? previewPane.scrollTop / maxPreview : 0;
    const info = cm.getScrollInfo();
    scrollingPreview = true;
    cm.scrollTo(null, ratio * (info.height - info.clientHeight));
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrollingPreview = false; }, 60);
  }

  cm.on('scroll', syncEditorToPreview);
  previewPane.addEventListener('scroll', syncPreviewToEditor);
  cm.on('change', () => {
    // mark active doc dirty (skip while loading a doc into the editor)
    if (!isLoadingDoc) {
      const d = getActiveDoc();
      if (d && !d.dirty) { d.dirty = true; renderTabs(); }
    }
    renderPreview();
  });
  cm.on('cursorActivity', updateStatus);

  // ---------- Drag divider ----------
  dividerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    dividerEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    const startX = e.clientX;
    const startWidth = editorPane.offsetWidth;
    const containerWidth = mainContainer.offsetWidth;

    function onMove(ev) {
      if (!isDragging) return;
      let w = startWidth + (ev.clientX - startX);
      w = Math.max(containerWidth * 0.2, Math.min(containerWidth * 0.8, w));
      editorPane.style.width = w + 'px';
      editorPane.style.flex = 'none';
      cm.refresh();
    }
    function onUp() {
      isDragging = false;
      dividerEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ---------- Selection helpers ----------
  const wrapOrInsert = (before, after, placeholder) => {
    const sel = cm.getSelection();
    if (sel) {
      cm.replaceSelection(before + sel + after);
    } else {
      cm.replaceSelection(before + placeholder + after);
      const c = cm.getCursor();
      cm.setCursor(c.line, c.ch - after.length - placeholder.length);
    }
    cm.focus();
  };

  const orderedPrefixes = (lines) => {
    let n = 0;
    return lines.map((line) => {
      const isListItem = /^(\d+\.\s|[-*+]\s|[-*+]\s\[[ xX]\]\s)/.test(line);
      return isListItem ? ++n + '. ' : (n + 1) + '. ';
    });
  };

  const prefixEachLine = (prefixFn, ordered) => {
    const ranges = cm.listSelections();
    const lineSet = new Set();
    ranges.forEach((sel) => {
      const s = Math.min(sel.anchor.line, sel.head.line);
      const e = Math.max(sel.anchor.line, sel.head.line);
      for (let i = s; i <= e; i++) lineSet.add(i);
    });
    const lines = [...lineSet].sort((a, b) => a - b);
    const prefixes = ordered
      ? orderedPrefixes(lines.map((l) => cm.getLine(l)))
      : lines.map(() => prefixFn);
    lines.forEach((line, idx) => {
      cm.replaceRange(prefixes[idx], { line, ch: 0 });
    });
    cm.focus();
  };

  // ---------- Toolbar commands ----------
  const commands = {
    h2: () => prefixEachLine('## '),
    h3: () => prefixEachLine('### '),
    bold: () => wrapOrInsert('**', '**', '粗体文字'),
    italic: () => wrapOrInsert('*', '*', '斜体文字'),
    strikethrough: () => wrapOrInsert('~~', '~~', '删除文字'),
    inlinecode: () => wrapOrInsert('`', '`', 'code'),
    ul: () => prefixEachLine('- '),
    ol: () => prefixEachLine('.', true),
    task: () => prefixEachLine('- [ ] '),
    quote: () => prefixEachLine('> '),
    codeblock: () => {
      const sel = cm.getSelection();
      cm.replaceSelection(sel ? '```\n' + sel + '\n```' : '```javascript\n// 在此输入代码\n```');
      cm.focus();
    },
    table: () => {
      cm.replaceSelection('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
      cm.focus();
    },
    link: () => wrapOrInsert('[', '](https://example.com)', '链接文字'),
    image: () => {
      const sel = cm.getSelection() || '描述文字';
      cm.replaceSelection('![' + sel + '](https://example.com/image.png)');
      cm.focus();
    },
    hr: () => {
      const cur = cm.getCursor();
      const lineText = cm.getLine(cur.line);
      cm.replaceRange((lineText.length > 0 ? '\n' : '') + '---\n', { line: cur.line, ch: lineText.length });
      cm.focus();
    },
    open: () => openFile(),
    save: () => saveFile(),
    exporthtml: () => toggleExportMenu(),
    sample: () => loadSample(),
  };

  document.querySelectorAll('.tb-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (commands[cmd]) commands[cmd]();
    });
  });

  // History button + clear button
  const historyBtn = document.getElementById('btn-history');
  if (historyBtn) historyBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHistoryDropdown(); });
  const historyClearBtn = document.getElementById('history-clear');
  if (historyClearBtn) historyClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    recentFiles = [];
    saveRecentFiles();
    renderHistoryDropdown();
  });
  // Close dropdown when clicking outside
  document.addEventListener('mousedown', (e) => {
    const dd = document.getElementById('history-dropdown');
    if (dd && dd.classList.contains('show') && !dd.contains(e.target) && e.target !== historyBtn) {
      hideHistoryDropdown();
    }
  });

  // ---------- Keyboard shortcuts ----------
  cm.on('keydown', (cmObj, event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', h: 'h2', q: 'quote', k: 'link' };
    let cmd = map[key];
    // New tab / close tab shortcuts
    if (key === 'n') cmd = '__newtab';
    if (key === 'w') cmd = '__closetab';
    if (cmd === '__newtab') { event.preventDefault(); createDocument('未命名', null, ''); cm.focus(); return; }
    if (cmd === '__closetab') { event.preventDefault(); if (getActiveDoc()) closeDocument(getActiveDoc().id); cm.focus(); return; }
    // Ctrl+S → save
    if (key === 's') { event.preventDefault(); saveFile(); return; }
    // Ctrl+Z → version history undo (回退); fall through to native undo when no versions
    if (key === 'z' && !event.shiftKey) {
      const doc = getActiveDoc();
      if (doc && doc.versions && doc.versions.length > 0) {
        event.preventDefault();
        undoLastVersion();
        return;
      }
    }
    if (cmd) {
      event.preventDefault();
      commands[cmd]();
    }
  });

  // New tab button
  const tabNewBtn = document.getElementById('tab-new');
  if (tabNewBtn) tabNewBtn.addEventListener('click', () => { createDocument('未命名', null, ''); cm.focus(); });

  // ---------- File operations ----------
  async function openFile() {
    try {
      const result = await window.api.openFile();
      if (!result) return;
      const name = result.filePath.split(/[\\/]/).pop();
      openFileIntoActive(result.filePath, result.content, name);
    } catch (err) { console.error('Open failed:', err); }
  }

  async function saveFile() {
    try {
      const doc = getActiveDoc();
      let content = cm.getValue();
      let savePath = doc ? doc.filePath : null;
      // No saved path yet → prompt user for a location
      if (!savePath) {
        const chosen = await window.api.saveFile(content);
        if (!chosen) return;
        savePath = chosen;
      } else {
        // Already has a path → write in place without a dialog
        const ok = await window.api.writeFileByPath(savePath, content);
        if (!ok) return;
      }
      const name = savePath.split(/[\\/]/).pop();
      if (doc) {
        doc.filePath = savePath;
        doc.name = name;
        doc.dirty = false;
        doc.content = content;
      }
      currentFilePath = savePath;
      updateTitleBar(doc);
      renderTabs();
      updateStatus();
    } catch (err) { console.error('Save failed:', err); }
  }

  // Derive a base filename (without extension) from the current file path,
  // falling back to 'document' for unsaved buffers.
  function currentBaseName() {
    if (currentFilePath) return currentFilePath.replace(/\.[^.]+$/, '').split(/[\\/]/).pop();
    return 'document';
  }

  async function exportHTML() {
    hideExportMenu();
    try {
      const bodyHtml = DOMPurify.sanitize(marked.parse(cm.getValue()), {
        ADD_TAGS: ['input'],
        ADD_ATTR: ['type', 'checked', 'disabled', 'data-lang', 'target', 'rel'],
      });
      const path = await window.api.saveHTML(buildStyledHTML(bodyHtml), currentBaseName());
      if (path) showToast('导出 HTML 成功');
      else return; // user canceled
    } catch (err) { console.error('Export failed:', err); showToast('导出 HTML 失败', 'error'); }
  }

  async function exportPDF() {
    hideExportMenu();
    try {
      const bodyHtml = DOMPurify.sanitize(marked.parse(cm.getValue()), {
        ADD_TAGS: ['input'],
        ADD_ATTR: ['type', 'checked', 'disabled', 'data-lang', 'target', 'rel'],
      });
      const path = await window.api.savePDF(buildStyledHTML(bodyHtml), currentBaseName());
      if (path) showToast('导出 PDF 成功');
      else return;
    } catch (err) { console.error('Export PDF failed:', err); showToast('导出 PDF 失败', 'error'); }
  }

  async function exportDOCX() {
    hideExportMenu();
    try {
      const path = await window.api.saveDOCX(cm.getValue(), currentBaseName());
      if (path) showToast('导出 Word 成功');
      else return;
    } catch (err) { console.error('Export DOCX failed:', err); showToast('导出 Word 失败', 'error'); }
  }

  // --- Export dropdown menu ---
  function toggleExportMenu() {
    const existing = document.getElementById('export-dropdown');
    if (existing) { existing.remove(); return; }
    const btn = document.querySelector('[data-cmd="exporthtml"]');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.id = 'export-dropdown';
    dd.className = 'export-dropdown';
    dd.style.top = (r.bottom + 4) + 'px';
    dd.style.left = Math.max(8, r.right - 180) + 'px';
    dd.innerHTML =
      '<div class="export-option" data-fmt="html"><span>🌐</span> 导出为 HTML</div>' +
      '<div class="export-option" data-fmt="pdf"><span>📄</span> 导出为 PDF</div>' +
      '<div class="export-option" data-fmt="docx"><span>📝</span> 导出为 Word</div>';
    dd.addEventListener('click', (e) => {
      const opt = e.target.closest('.export-option');
      if (!opt) return;
      const fmt = opt.dataset.fmt;
      if (fmt === 'html') exportHTML();
      else if (fmt === 'pdf') exportPDF();
      else if (fmt === 'docx') exportDOCX();
    });
    document.body.appendChild(dd);
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('mousedown', function onClose(e) {
        if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('mousedown', onClose); }
      });
    }, 0);
  }

  function hideExportMenu() {
    const dd = document.getElementById('export-dropdown');
    if (dd) dd.remove();
  }

  function buildStyledHTML(bodyHtml) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Markdown Document</title>
<style>
  body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:860px;margin:0 auto;padding:40px 24px;background:#0d1117;color:#c9d1d9;line-height:1.7}
  h1,h2,h3,h4{color:#e6edf3;margin-top:1.6em;margin-bottom:.6em}
  h1{font-size:2em;border-bottom:1px solid #21262d;padding-bottom:.3em}
  h2{font-size:1.5em;border-bottom:1px solid #21262d;padding-bottom:.3em}
  h3{font-size:1.25em}
  a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
  code{background:#161b22;color:#e6edf3;padding:.2em .4em;border-radius:4px;border:1px solid #30363d;font-size:.9em}
  pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;overflow-x:auto}
  pre code{background:none;border:none;padding:0;font-size:.875em}
  blockquote{border-left:4px solid #30363d;padding:.5em 1em;margin:1em 0;color:#8b949e;background:#161b22;border-radius:0 4px 4px 0}
  table{border-collapse:collapse;margin:1em 0;width:100%}
  th,td{border:1px solid #30363d;padding:8px 12px;text-align:left}
  th{background:#161b22;color:#e6edf3;font-weight:600}
  hr{border:none;border-top:2px solid #21262d;margin:2em 0}
  img{max-width:100%}
  li.task-list-item{list-style:none;position:relative}
  li.task-list-item input[type=checkbox]{position:absolute;left:-1.6em;top:4px}
  .token-keyword{color:#ff7b72}.token-string{color:#a5d6ff}.token-number{color:#79c0ff}
  .token-comment{color:#8b949e;font-style:italic}.token-function{color:#d2a8ff}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  function loadSampleIntoActive() {
    const sample = `# Markdown 编辑器示例

> 这是一个功能丰富的 **Markdown 编辑器**，支持实时预览和语法高亮。

## 文字格式化

你可以使用 **粗体**、*斜体*、~~删除线~~ 和 \`行内代码\` 来格式化文字。

## 列表

### 无序列表

- 项目一
- 项目二
  - 嵌套项目
  - 另一个嵌套

### 有序列表

1. 第一步
2. 第二步
3. 第三步

### 任务清单

- [x] 已完成任务
- [ ] 待办事项
- [ ] 另一个待办

## 引用

> 生活就像海洋，只有意志坚强的人才能到达彼岸。

## 代码块

\`\`\`javascript
function greet(name) {
  console.log(\`Hello, \${name}!\`);
  return true;
}

// 调用函数
greet('世界');
\`\`\`

## 表格

| 功能 | 支持 | 说明 |
| --- | --- | --- |
| 语法高亮 | 是 | CodeMirror |
| 实时预览 | 是 | Marked.js |
| 快捷键 | 是 | Ctrl+B/I/H/Q/K |

## 链接和图片

这是一个 [示例链接](https://example.com) 的演示。

---

*祝你使用愉快！*
`;
    return sample;
  }
  // Backwards-compatible alias used by the toolbar "示例" button: opens the
  // sample Markdown in a fresh document tab.
  function loadSample() {
    createDocument('示例文档', null, loadSampleIntoActive());
  }

  // ---------- Drag & drop file open ----------
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      document.body.classList.add('dragging-over');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      document.body.classList.remove('dragging-over');
    }
  });
  document.addEventListener('drop', async (e) => {
    document.body.classList.remove('dragging-over');
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['md', 'markdown', 'txt'].includes(ext)) return;
    try {
      const text = await file.text();
      openFileIntoActive(null, text, file.name);
    } catch (err) { console.error('Drop open failed:', err); }
  });

  // Drag overlay element
  const overlay = document.createElement('div');
  overlay.className = 'drag-overlay';
  overlay.textContent = '放开以打开文件';
  document.body.appendChild(overlay);

  // ---------- Titlebar window controls ----------
  document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-max').addEventListener('click', async () => {
    await window.api.maximize();
    document.getElementById('btn-max').textContent = (await window.api.isMaximized()) ? '❐' : '□';
  });
  document.getElementById('btn-close').addEventListener('click', () => window.api.close());

  // Double click titlebar to maximize/restore
  document.querySelector('.titlebar-drag').addEventListener('dblclick', async () => {
    await window.api.maximize();
    document.getElementById('btn-max').textContent = (await window.api.isMaximized()) ? '❐' : '□';
  });

  // ---------- Always on top ----------
  const pinBtn = document.getElementById('btn-pin');
  pinBtn.addEventListener('click', async () => {
    isAlwaysOnTop = !isAlwaysOnTop;
    await window.api.setAlwaysOnTop(isAlwaysOnTop);
    pinBtn.classList.toggle('active', isAlwaysOnTop);
    pinBtn.title = isAlwaysOnTop ? '取消置顶' : '置顶显示';
  });

  // ---------- Floating mode (main-process driven edge detection) ----------
  const floatBtn = document.getElementById('btn-float');

  floatBtn.addEventListener('click', async () => {
    isFloating ? exitFloatingMode() : enterFloatingMode();
  });

  async function enterFloatingMode() {
    isFloating = true;
    document.body.classList.add('floating-mode');
    editorPane.style.display = 'none';
    // Ensure on top in floating mode
    if (!isAlwaysOnTop) {
      isAlwaysOnTop = true;
      await window.api.setAlwaysOnTop(true);
      pinBtn.classList.add('active');
      pinBtn.title = '取消置顶';
    }
    floatBtn.classList.add('active');
    floatBtn.title = '退出悬浮模式';
    await window.api.enterFloating();
    cm.refresh();
  }

  async function exitFloatingMode() {
    isFloating = false;
    isCollapsed = false;
    collapsedEdge = null;
    document.body.classList.remove('floating-mode');
    document.body.classList.remove('collapsed-mode');
    if (collapsedIcon) collapsedIcon.classList.remove('show');
    editorPane.style.display = '';
    editorPane.style.width = '';
    editorPane.style.flex = '';
    floatBtn.classList.remove('active');
    floatBtn.title = '悬浮模式';
    await window.api.exitFloating();
    cm.refresh();
    renderPreview();
  }

  // Edge-collapse driven by main process window:edge-snap event.
  // The main process detects when the user drags the floating window to a
  // screen edge and sends this event. Programmatic moves are guarded there.
  window.api.onEdgeSnap((edge) => {
    if (isCollapsed) return;
    isCollapsed = true;
    collapsedEdge = edge;
    document.body.classList.add('collapsed-mode');
    // Show the restore icon (fills the 48x48 window, clickable)
    if (collapsedIcon) collapsedIcon.classList.add('show');
    // Ask the main process to actually resize the window to the 48x48 icon
    window.api.collapseTo(edge);
  });

  // Restore from collapsed icon (click) — replaced by drag-aware handlers below
  let iconDrag = null; // { startMx, startMy, winX, winY, ready, didDrag }

  collapsedIcon.addEventListener('mousedown', (e) => {
    if (!isCollapsed) return;
    e.preventDefault();
    collapsedIcon.style.cursor = 'grabbing';
    iconDrag = { startMx: e.clientX, startMy: e.clientY, winX: 0, winY: 0, ready: false, didDrag: false };
    // Tell main process to suppress edge-snap while we drag the icon
    window.api.setIconDragging(true);
    // Capture the window position at drag start (async IPC)
    window.api.getPosition().then((pos) => {
      if (iconDrag) { iconDrag.winX = pos[0]; iconDrag.winY = pos[1]; iconDrag.ready = true; }
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!iconDrag || !iconDrag.ready) return;
    const dx = e.clientX - iconDrag.startMx;
    const dy = e.clientY - iconDrag.startMy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) iconDrag.didDrag = true;
    if (iconDrag.didDrag) {
      const nx = Math.round(iconDrag.winX + dx);
      const ny = Math.round(iconDrag.winY + dy);
      window.api.setPosition(nx, ny);
    }
  });

  document.addEventListener('mouseup', () => {
    if (!iconDrag) return;
    const wasDrag = iconDrag.didDrag;
    iconDrag = null;
    collapsedIcon.style.cursor = 'grab';
    // Re-enable edge-snap detection
    window.api.setIconDragging(false);
    if (!wasDrag) {
      // No significant movement → treat as a click → restore the floating window
      if (!isCollapsed) return;
      isCollapsed = false;
      collapsedIcon.classList.remove('show');
      collapsedIcon.style.cssText = '';
      document.body.classList.remove('collapsed-mode');
      window.api.restoreFromCollapse(collapsedEdge);
      cm.refresh();
      renderPreview();
    } else if (isCollapsed) {
      // Dragged → snap the 48x48 icon to the nearest screen edge and stay docked
      window.api.snapToNearestEdge().then((edge) => {
        if (edge) collapsedEdge = edge;
      });
    }
  });

  // ---------- Draggable panels ----------
  // Makes a panel draggable by its header element. Works for TOC and AI panels.
  function makeDraggable(panel, headerSelector) {
    if (!panel) return;
    const header = panel.querySelector(headerSelector);
    if (!header) return;
    header.style.cursor = 'grab';
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      dragging = true;
      header.style.cursor = 'grabbing';
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.position = 'fixed';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // No bounds constraint — allow dragging outside the window
      panel.style.left = (origX + dx) + 'px';
      panel.style.top = (origY + dy) + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        header.style.cursor = 'grab';
      }
    });
  }

  // Make AI panel resizable
  function makeResizable(panel) {
    if (!panel) return;
    const minW = 280, minH = 200;
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let edge = '';

    // Create resize handle (bottom-right corner)
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    panel.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      document.body.style.cursor = 'nwse-resize';
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newW = Math.max(minW, startW + dx);
      const newH = Math.max(minH, startH + dy);
      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        document.body.style.cursor = '';
      }
    });
  }

  // ---------- TOC (Document Outline) ----------
  const tocPanel = document.getElementById('toc-panel');
  const tocList = document.getElementById('toc-list');
  let tocData = []; // [{ level, text, line }]

  function buildTOC() {
    const lines = cm.getValue().split('\n');
    const headings = [];
    lines.forEach((line, i) => {
      const m = /^(#{1,6})\s+(.+)$/.exec(line);
      if (m) {
        headings.push({ level: m[1].length, text: m[2].replace(/#+$/, '').trim(), line: i });
      }
    });
    tocData = headings;
    renderTOC();
  }

  function renderTOC() {
    if (!tocList) return;
    tocList.innerHTML = '';
    if (tocData.length === 0) {
      tocList.innerHTML = '<div class="toc-empty">暂无标题</div>';
      return;
    }
    tocData.forEach((h, idx) => {
      const item = document.createElement('div');
      item.className = 'toc-item level-' + h.level;
      item.textContent = h.text;
      item.style.paddingLeft = (8 + (h.level - 1) * 14) + 'px';
      item.addEventListener('click', () => {
        cm.setCursor({ line: h.line, ch: 0 });
        cm.focus();
        // Briefly highlight the line
        cm.addLineClass(h.line, 'background', 'toc-highlight-line');
        setTimeout(() => cm.removeLineClass(h.line, 'background', 'toc-highlight-line'), 1200);
      });
      tocList.appendChild(item);
    });
  }

  function toggleTOC() {
    if (!tocPanel) return;
    if (tocPanel.classList.contains('hidden')) {
      tocPanel.classList.remove('hidden');
      buildTOC();
    } else {
      tocPanel.classList.add('hidden');
    }
  }

  const tocBtn = document.getElementById('btn-toc');
  if (tocBtn) tocBtn.addEventListener('click', toggleTOC);
  const tocCloseBtn = document.getElementById('toc-close');
  if (tocCloseBtn) tocCloseBtn.addEventListener('click', () => tocPanel.classList.add('hidden'));

  // Rebuild TOC on content change (debounced)
  let tocTimer = null;
  cm.on('change', () => {
    if (tocTimer) clearTimeout(tocTimer);
    tocTimer = setTimeout(buildTOC, 500);
  });

  // Make TOC panel draggable by its header
  makeDraggable(tocPanel, '.toc-header');

  // ---------- Theme switching ----------
  const PREVIEW_THEMES = ['dark', 'light', 'sepia', 'nord'];
  const EDITOR_THEMES = [
    { id: 'dracula', name: 'Dracula (暗)' },
    { id: 'eclipse', name: 'Eclipse (亮)' },
    { id: 'idea', name: 'Idea (亮)' },
  ];
  let currentPreviewTheme = localStorage.getItem('md-preview-theme') || 'dark';
  let currentEditorTheme = localStorage.getItem('md-editor-theme') || 'dracula';
  let customCSS = localStorage.getItem('md-custom-css') || '';

  function applyPreviewTheme(theme) {
    currentPreviewTheme = theme;
    if (!previewPane) return;
    PREVIEW_THEMES.forEach(t => previewPane.classList.remove('preview-theme-' + t));
    previewPane.classList.add('preview-theme-' + theme);
    localStorage.setItem('md-preview-theme', theme);
  }

  function applyEditorTheme(theme) {
    currentEditorTheme = theme;
    cm.setOption('theme', theme);
    localStorage.setItem('md-editor-theme', theme);
  }

  function applyCustomCSS(css) {
    customCSS = css;
    let styleEl = document.getElementById('custom-preview-css');
    if (!css) {
      if (styleEl) styleEl.remove();
      localStorage.removeItem('md-custom-css');
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'custom-preview-css';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    localStorage.setItem('md-custom-css', css);
  }

  // Apply saved themes on load
  applyPreviewTheme(currentPreviewTheme);
  applyEditorTheme(currentEditorTheme);
  applyCustomCSS(customCSS);

  // ---------- AI Agent ----------
  const aiPanel = document.getElementById('ai-panel');
  const aiOutput = document.getElementById('ai-output');
  const aiInput = document.getElementById('ai-input');
  const aiSendBtn = document.getElementById('ai-send');
  const aiStatus = document.getElementById('ai-status');
  let agentStreaming = false;
  let agentMessages = []; // full conversation history (sent to main process each turn)
  let currentAssistantEl = null; // assistant bubble currently receiving streamed text

  // Make AI panel draggable and resizable
  makeDraggable(aiPanel, '.ai-header');
  makeResizable(aiPanel);

  // AI config (stored in localStorage, user fills in via Settings)
  function getAIConfig() {
    return {
      url: localStorage.getItem('md-ai-url') || '',
      key: localStorage.getItem('md-ai-key') || '',
      model: localStorage.getItem('md-ai-model') || '',
      temperature: parseFloat(localStorage.getItem('md-ai-temperature') || '0.7'),
      thinking: localStorage.getItem('md-ai-thinking') === '1',
    };
  }

  function updateAIStatus() {
    const cfg = getAIConfig();
    if (aiStatus) {
      if (!cfg.url) {
        aiStatus.textContent = '未配置 API — 请先在 ⚙ 设置 中填写接口信息';
        aiStatus.style.color = '#52525b';
      } else {
        aiStatus.textContent = '已配置: ' + cfg.model + ' @ ' + new URL(cfg.url).hostname;
        aiStatus.style.color = '#7c3aed';
      }
    }
  }

  function toggleAIPanel() {
    if (!aiPanel) return;
    if (aiPanel.classList.contains('hidden')) {
      aiPanel.classList.remove('hidden');
      updateAIStatus();
    } else {
      aiPanel.classList.add('hidden');
    }
  }

  const aiCloseBtn = document.getElementById('ai-close');
  if (aiCloseBtn) aiCloseBtn.addEventListener('click', () => aiPanel.classList.add('hidden'));

  const aiClearBtn = document.getElementById('ai-clear');
  if (aiClearBtn) aiClearBtn.addEventListener('click', clearAgentConversation);

  // ---- Chat rendering ----

  function scrollAiOutput() {
    aiOutput.scrollTop = aiOutput.scrollHeight;
  }

  function appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'ai-msg ai-msg-user';
    el.innerHTML = '<div class="ai-msg-bubble">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
    aiOutput.appendChild(el);
    scrollAiOutput();
  }

  // Create (or return existing) assistant bubble for streaming text into.
  function ensureAssistantBubble() {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 'ai-msg ai-msg-assistant';
      currentAssistantEl.innerHTML = '<div class="ai-msg-bubble"></div>';
      aiOutput.appendChild(currentAssistantEl);
    }
    return currentAssistantEl.querySelector('.ai-msg-bubble');
  }

  function appendAssistantText(text) {
    const bubble = ensureAssistantBubble();
    bubble.textContent += text;
    scrollAiOutput();
  }

  function finalizeAssistantBubble() {
    // Remove trailing cursor if present.
    if (currentAssistantEl) {
      const cursor = currentAssistantEl.querySelector('.ai-cursor');
      if (cursor) cursor.remove();
    }
    currentAssistantEl = null;
  }

  // Edit/insert tools require user confirmation before applying. Read/selection
  // tools run immediately.
  function toolNeedsConfirm(name) {
    return name === 'edit_document' || name === 'insert_at_cursor';
  }

  // Render a tool-call card. Returns the card element (so we can update it later).
  // For edit/insert tools this renders a confirmation UI (diff + buttons) and
  // does NOT apply anything until the user clicks 应用.
  function appendToolCard(toolName, toolArgsJson) {
    const el = document.createElement('div');
    el.className = 'ai-tool-card';
    el.dataset.toolName = toolName;

    if (toolNeedsConfirm(toolName)) {
      let args = {};
      try { args = JSON.parse(toolArgsJson); } catch { /* ignore */ }
      el.innerHTML =
        '<div class="ai-tool-head"><span class="ai-tool-name">🔧 ' + escapeHtml(toolName) + '</span>' +
        '<span class="ai-tool-status ai-status-pending">待确认</span></div>' +
        confirmPreviewHtml(toolName, args) +
        '<div class="ai-tool-confirm">' +
        '<button class="ai-btn ai-btn-apply">✓ 应用</button>' +
        '<button class="ai-btn ai-btn-cancel">✕ 取消</button>' +
        '</div>';
      aiOutput.appendChild(el);
      scrollAiOutput();
      attachConfirmHandlers(el, toolName);
      return el;
    }

    // Non-confirm tools: show args, status "running".
    let argsStr = toolArgsJson;
    try { argsStr = JSON.stringify(JSON.parse(toolArgsJson), null, 2); } catch { /* keep raw */ }
    const displayArgs = argsStr.length > 300 ? argsStr.slice(0, 300) + '…' : argsStr;
    el.innerHTML =
      '<div class="ai-tool-head"><span class="ai-tool-name">🔧 ' + escapeHtml(toolName) + '</span>' +
      '<span class="ai-tool-status">运行中…</span></div>' +
      '<pre class="ai-tool-args">' + escapeHtml(displayArgs) + '</pre>' +
      '<div class="ai-tool-result"></div>';
    aiOutput.appendChild(el);
    scrollAiOutput();
    return el;
  }

  // Preview shown inside a confirmation card (before the user decides).
  function confirmPreviewHtml(toolName, args) {
    if (toolName === 'edit_document') {
      return buildDiffHtml({ old: args.old_text || '', new: args.new_text || '' });
    }
    if (toolName === 'insert_at_cursor') {
      const txt = args.text || '';
      const display = txt.length > 200 ? txt.slice(0, 200) + '…' : txt;
      return '<div class="ai-diff"><div class="ai-diff-new"><span class="ai-diff-label">插入</span>' + escapeHtml(display) + '</div></div>';
    }
    return '';
  }

  // Build a before/after diff block (inline — the model replaces whole snippets,
  // so showing old→new is the clearest view).
  function buildDiffHtml(diff) {
    const oldText = (diff.old || '').trim();
    const newText = (diff.new || '').trim();
    const trunc = (s) => s.length > 200 ? s.slice(0, 200) + '…' : s;
    return (
      '<div class="ai-diff">' +
      '<div class="ai-diff-old"><span class="ai-diff-label">原文</span>' + escapeHtml(trunc(oldText)) + '</div>' +
      '<div class="ai-diff-arrow">↓</div>' +
      '<div class="ai-diff-new"><span class="ai-diff-label">改为</span>' + escapeHtml(trunc(newText)) + '</div>' +
      '</div>'
    );
  }

  // Wire 应用/取消 buttons on a confirmation card. The actual requestId and
  // parsed args are attached later by handleExecTool (for confirm tools).
  function attachConfirmHandlers(el, toolName) {
    el.querySelector('.ai-btn-apply').addEventListener('click', () => {
      if (el.dataset.resolved) return;
      const requestId = el._requestId;
      const args = el._args;
      if (!requestId || !args) return;
      el.dataset.resolved = '1';
      let result;
      try {
        result = toolName === 'edit_document' ? applyEditDocument(args) : applyInsertAtCursor(args);
      } catch (err) {
        window.api.sendToolResult(requestId, null, err.message);
        setCardStatus(el, '错误');
        return;
      }
      setCardStatus(el, '已应用');
      window.api.sendToolResult(requestId, result, null);
    });

    el.querySelector('.ai-btn-cancel').addEventListener('click', () => {
      if (el.dataset.resolved) return;
      el.dataset.resolved = '1';
      setCardStatus(el, '已取消');
      window.api.sendToolResult(el._requestId, JSON.stringify({ ok: false, msg: '用户取消了修改。' }), null);
    });
  }

  // Update a confirmation card's status text + disable its buttons.
  function setCardStatus(el, statusText) {
    if (!el) return;
    const statusEl = el.querySelector('.ai-tool-status');
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.classList.remove('ai-status-pending');
    }
    const confirmRow = el.querySelector('.ai-tool-confirm');
    if (confirmRow) confirmRow.style.display = 'none';
  }

  // Apply an edit (extracted so both the confirm handler and the fallback path
  // share one implementation). Returns a structured result string.
  function applyEditDocument(args) {
    const fullText = cm.getValue();
    const idx = fullText.indexOf(args.old_text);
    if (idx === -1) {
      return JSON.stringify({ ok: false, msg: '未在文档中找到指定的原文，替换失败。' });
    }
    // Snapshot the pre-edit state so the user can undo/rollback.
    const doc = getActiveDoc();
    if (doc) {
      const trunc = (s) => s.length > 20 ? s.slice(0, 20) + '…' : s;
      snapshotVersion(doc, '替换: ' + trunc(args.old_text) + ' → ' + trunc(args.new_text));
    }
    const before = fullText.slice(0, idx);
    const line = before.split('\n').length - 1;
    const ch = before.length - before.lastIndexOf('\n') - 1;
    const endLine = line + args.old_text.split('\n').length - 1;
    const lastNewline = args.old_text.lastIndexOf('\n');
    const endCh = lastNewline === -1 ? ch + args.old_text.length : args.old_text.length - lastNewline - 1;
    cm.replaceRange(args.new_text, { line, ch }, { line: endLine, ch: endCh });
    if (doc && !doc.dirty) { doc.dirty = true; renderTabs(); }
    renderPreview();
    renderVersionList();
    return JSON.stringify({ ok: true, msg: '已应用修改。', diff: { old: args.old_text, new: args.new_text } });
  }

  function applyInsertAtCursor(args) {
    // Snapshot the pre-edit state so the user can undo/rollback.
    const doc = getActiveDoc();
    if (doc) {
      const trunc = (s) => s.length > 30 ? s.slice(0, 30) + '…' : s;
      snapshotVersion(doc, '插入: ' + trunc(args.text));
    }
    cm.replaceSelection(args.text);
    if (doc && !doc.dirty) { doc.dirty = true; renderTabs(); }
    renderPreview();
    renderVersionList();
    return JSON.stringify({ ok: true, msg: '已插入文本。', inserted: args.text });
  }

  // Update a non-confirm tool card with its result.
  function updateToolCard(el, result) {
    if (!el || el.dataset.resolved) return;
    el.querySelector('.ai-tool-status').textContent = '完成';
    el.querySelector('.ai-tool-status').classList.add('done');
    const resultEl = el.querySelector('.ai-tool-result');

    // Try to parse a structured result.
    let payload = null;
    try { payload = JSON.parse(result); } catch { /* plain string */ }

    if (payload && payload.diff) {
      resultEl.innerHTML = buildDiffHtml(payload.diff);
    } else if (payload && payload.inserted) {
      resultEl.innerHTML = '<div class="ai-diff"><div class="ai-diff-new"><span class="ai-diff-label">插入</span>' +
        escapeHtml(payload.inserted.length > 200 ? payload.inserted.slice(0, 200) + '…' : payload.inserted) + '</div></div>';
    } else {
      const msg = (payload && payload.msg) ? payload.msg : result;
      const displayResult = msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
      resultEl.textContent = displayResult;
    }
    scrollAiOutput();
  }

  function clearAgentConversation() {
    agentMessages = [];
    aiOutput.innerHTML = '';
    currentAssistantEl = null;
  }

  // ---- Tool execution (dispatched by main process) ----

  window.api.onExecTool(({ requestId, name, args }) => {
    // Confirm tools (edit/insert) were already rendered as a confirmation card
    // by onAgentToolStart. We just attach the requestId + args so the 应用/取消
    // buttons can apply or cancel. The result is sent later, on user action.
    if (toolNeedsConfirm(name)) {
      const card = dequeuePendingCard(name);
      if (card) {
        card._requestId = requestId;
        card._args = args;
      } else {
        // No matching card (shouldn't happen) — reject so the loop doesn't hang.
        window.api.sendToolResult(requestId, null, '未找到对应的确认卡片');
      }
      return;
    }

    // Non-confirm tools run immediately.
    let result = '';
    try {
      switch (name) {
        case 'read_document':
          result = cm.getValue();
          break;
        case 'get_selection': {
          const sel = cm.getSelection();
          const cursor = cm.getCursor();
          result = JSON.stringify({ selection: sel, cursor });
          break;
        }
        default:
          result = '错误: 未知工具 ' + name;
      }
    } catch (err) {
      window.api.sendToolResult(requestId, null, err.message);
      return;
    }
    window.api.sendToolResult(requestId, result, null);
  });

  // ---- Stream event handlers (set up once) ----

  window.api.onAgentText((chunk) => {
    appendAssistantText(chunk);
  });

  // Pending confirmation cards keyed by toolName (queue — the model may batch
  // several edits in one response). onExecTool pops from this queue.
  function enqueuePendingCard(toolName, card) {
    if (!window._pendingConfirmCards) window._pendingConfirmCards = {};
    if (!window._pendingConfirmCards[toolName]) window._pendingConfirmCards[toolName] = [];
    window._pendingConfirmCards[toolName].push(card);
  }
  function dequeuePendingCard(toolName) {
    const q = window._pendingConfirmCards && window._pendingConfirmCards[toolName];
    return (q && q.shift()) || null;
  }

  window.api.onAgentToolStart(({ toolName, toolArgs }) => {
    finalizeAssistantBubble();
    const card = appendToolCard(toolName, toolArgs || '{}');
    if (toolNeedsConfirm(toolName)) {
      // Confirm card: stash for onExecTool to attach requestId/args.
      enqueuePendingCard(toolName, card);
    } else {
      // Non-confirm card: stash on a queue keyed by toolName so tool_result
      // can find it (multiple calls may share a name).
      if (!window._toolCardQueues) window._toolCardQueues = {};
      if (!window._toolCardQueues[toolName]) window._toolCardQueues[toolName] = [];
      window._toolCardQueues[toolName].push(card);
    }
  });

  window.api.onAgentToolResult(({ toolName, result }) => {
    // Confirm tools resolve their own cards via the 应用/取消 buttons, so
    // skip those here to avoid double-updating.
    if (toolNeedsConfirm(toolName)) return;
    const queue = window._toolCardQueues && window._toolCardQueues[toolName];
    const card = queue && queue.shift();
    updateToolCard(card, result);
  });

  window.api.onAgentDone(() => {
    finalizeAssistantBubble();
    cleanupAgentTurn();
  });

  // ---- Send a message ----

  function sendAgentMessage(text) {
    if (agentStreaming) return;
    const cfg = getAIConfig();
    if (!cfg.url) {
      appendUserMessage(text);
      currentAssistantEl = null;
      ensureAssistantBubble().innerHTML =
        '⚠️ 请先在设置中配置 API 接口地址。<br><br>点击工具栏的 ⚙ 设置 按钮，在「AI 助手」标签页填写接口信息。';
      finalizeAssistantBubble();
      return;
    }
    agentStreaming = true;
    if (aiSendBtn) aiSendBtn.disabled = true;
    if (aiInput) aiInput.value = '';

    appendUserMessage(text);
    agentMessages.push({ role: 'user', content: text });

    // Reset tool-card queues for this turn.
    window._toolCardQueues = {};

    window.api.agentChat({ cfg, messages: agentMessages })
      .then((finalMessages) => {
        // Sync authoritative history (includes system/assistant/tool messages).
        agentMessages = finalMessages;
      })
      .catch((err) => {
        finalizeAssistantBubble();
        ensureAssistantBubble().innerHTML = '❌ 错误: ' + escapeHtml(err.message || String(err));
        finalizeAssistantBubble();
      })
      .finally(() => {
        // Safety net in case agent:done was missed.
        if (agentStreaming) cleanupAgentTurn();
      });
  }

  function cleanupAgentTurn() {
    agentStreaming = false;
    if (aiSendBtn) aiSendBtn.disabled = false;
  }

  // ---- Action buttons (quick prompts) ----

  document.querySelectorAll('.ai-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      const sel = cm.getSelection();
      const target = sel ? '以下选中的文字' : '当前文档全文';
      const prompts = {
        continue: '基于' + target + '继续写作，保持风格和语气一致。在文档末尾插入续写内容。',
        polish: '润色' + target + '，改善表达和流畅度，保持原意。直接修改文档。',
        translate: '将' + target + '翻译为英文（如果已经是英文则翻译为中文）。直接修改文档。',
        summary: '简要总结' + target + '的核心要点。在文档末尾插入总结。',
      };
      sendAgentMessage(prompts[act]);
    });
  });

  // ---- Input handling ----

  if (aiSendBtn) {
    aiSendBtn.addEventListener('click', () => {
      const text = aiInput.value.trim();
      if (text) sendAgentMessage(text);
    });
  }
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = aiInput.value.trim();
        if (text) sendAgentMessage(text);
      }
    });
  }

  // ---------- Version History ----------
  const MAX_VERSIONS = 50;
  let activeDiffLineClasses = []; // tracks {handle} for CodeMirror line highlights
  let activeDiffVersionId = null; // which version is currently being compared

  const versionPanel = document.getElementById('version-panel');
  const versionListEl = document.getElementById('version-list');
  const versionDiffEl = document.getElementById('version-diff');

  // Capture a snapshot of the current editor state into doc.versions.
  function snapshotVersion(doc, label) {
    if (!doc) return;
    if (!doc.versions) doc.versions = [];
    doc.versions.push({
      id: 'v' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      content: cm.getValue(),
      cursor: cm.getCursor(),
      timestamp: Date.now(),
      label: label || '快照',
    });
    // Enforce cap — drop oldest.
    while (doc.versions.length > MAX_VERSIONS) doc.versions.shift();
  }

  // Restore a version's content + cursor into the editor.
  function restoreVersion(doc, version) {
    if (!doc || !version) return;
    cm.setValue(version.content);
    cm.setCursor(version.cursor || { line: 0, ch: 0 });
    if (!doc.dirty) { doc.dirty = true; renderTabs(); }
    renderPreview();
    updateStatus();
    cm.focus();
  }

  // Undo the last AI edit: pop the newest version and restore it.
  function undoLastVersion() {
    const doc = getActiveDoc();
    if (!doc || !doc.versions || doc.versions.length === 0) return;
    const version = doc.versions.pop();
    restoreVersion(doc, version);
    renderVersionList();
  }

  // Roll back to a specific version index, discarding all versions after it.
  function rollbackToVersion(doc, index) {
    if (!doc || !doc.versions) return;
    if (index < 0 || index >= doc.versions.length) return;
    const version = doc.versions[index];
    doc.versions.length = index + 1; // keep [0..index]
    restoreVersion(doc, version);
    renderVersionList();
  }

  // Clear CodeMirror line highlights from a previous diff.
  function clearVersionDiff() {
    activeDiffLineClasses.forEach((h) => {
      try { cm.removeLineClass(h.line, 'wrap', 'ai-diff-line-added'); } catch {}
      try { cm.removeLineClass(h.line, 'wrap', 'ai-diff-line-removed'); } catch {}
    });
    activeDiffLineClasses = [];
    activeDiffVersionId = null;
    if (versionDiffEl) { versionDiffEl.innerHTML = ''; versionDiffEl.classList.add('hidden'); }
  }

  // Show a line-level diff between a version and the current editor content.
  function showVersionDiff(version) {
    const doc = getActiveDoc();
    if (!doc || !version) return;
    clearVersionDiff();
    activeDiffVersionId = version.id;

    const oldText = version.content;
    const newText = cm.getValue();
    const parts = window.Diff.diffLines(oldText, newText);

    // Highlight added lines in the editor (lines present in newText but not old).
    let newLine = 0;
    const addedLines = [];
    parts.forEach((part) => {
      const lines = part.value.split('\n');
      // diffLines keeps the trailing newline as part of the last element, which
      // produces a trailing empty string when split — skip it for line counting.
      const count = part.value.endsWith('\n') ? lines.length - 1 : lines.length;
      if (part.added) {
        for (let i = 0; i < count; i++) {
          const ln = newLine + i;
          cm.addLineClass(ln, 'wrap', 'ai-diff-line-added');
          activeDiffLineClasses.push({ line: ln });
        }
      }
      if (!part.removed) {
        newLine += count;
      }
    });

    // Build an in-panel diff preview (red removed + green added, with line numbers).
    let oldLine = 1;
    let newLineNum = 1;
    let html = '<div class="version-diff-title">与当前文档的差异</div>';
    html += '<div class="version-diff-scroll">';
    parts.forEach((part) => {
      const lines = part.value.split('\n');
      if (part.value.endsWith('\n')) lines.pop(); // drop trailing empty
      lines.forEach((line) => {
        if (part.removed) {
          html += '<div class="version-diff-line version-diff-removed"><span class="version-diff-lnum">' + oldLine + '</span><span class="version-diff-sign">-</span><span class="version-diff-text">' + escapeHtml(line) + '</span></div>';
          oldLine++;
        } else if (part.added) {
          html += '<div class="version-diff-line version-diff-added"><span class="version-diff-lnum">' + newLineNum + '</span><span class="version-diff-sign">+</span><span class="version-diff-text">' + escapeHtml(line) + '</span></div>';
          newLineNum++;
        } else {
          // Show a couple of context lines around changes.
          html += '<div class="version-diff-line version-diff-context"><span class="version-diff-lnum">' + newLineNum + '</span><span class="version-diff-sign"> </span><span class="version-diff-text">' + escapeHtml(line) + '</span></div>';
          oldLine++;
          newLineNum++;
        }
      });
    });
    html += '</div>';
    html += '<button id="version-diff-close" class="version-diff-close-btn">关闭对比</button>';

    if (versionDiffEl) {
      versionDiffEl.innerHTML = html;
      versionDiffEl.classList.remove('hidden');
      const closeBtn = document.getElementById('version-diff-close');
      if (closeBtn) closeBtn.addEventListener('click', clearVersionDiff);
    }
  }

  // Render the version list (newest first).
  function renderVersionList() {
    if (!versionListEl) return;
    const doc = getActiveDoc();
    const versions = (doc && doc.versions) ? doc.versions : [];
    versionListEl.innerHTML = '';

    if (versions.length === 0) {
      versionListEl.innerHTML = '<div class="version-empty">暂无版本（AI 编辑应用后自动创建）</div>';
    }

    // Iterate newest-first.
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i];
      const item = document.createElement('div');
      item.className = 'version-item' + (v.id === activeDiffVersionId ? ' version-item-active' : '');

      const timeStr = new Date(v.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

      item.innerHTML =
        '<div class="version-item-top"><span class="version-item-label">' + escapeHtml(v.label) + '</span>' +
        '<span class="version-item-time">' + timeStr + '</span></div>' +
        '<div class="version-item-actions">' +
        '<button class="version-item-btn version-compare-btn" data-index="' + i + '">对比</button>' +
        '<button class="version-item-btn version-restore-btn" data-index="' + i + '">恢复</button>' +
        '</div>';

      versionListEl.appendChild(item);
    }

    // Wire up the per-item buttons.
    versionListEl.querySelectorAll('.version-compare-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const d = getActiveDoc();
        if (!d || !d.versions || idx == null) return;
        // Toggle: clicking the active version clears the diff.
        if (d.versions[idx].id === activeDiffVersionId) {
          clearVersionDiff();
          renderVersionList();
        } else {
          showVersionDiff(d.versions[idx]);
          renderVersionList();
        }
      });
    });
    versionListEl.querySelectorAll('.version-restore-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        const d = getActiveDoc();
        if (!d) return;
        clearVersionDiff();
        rollbackToVersion(d, idx);
      });
    });

    // Keep the list scrolled so the newest entry is visible.
    versionListEl.scrollTop = 0;
  }

  function toggleVersionPanel() {
    if (!versionPanel) return;
    if (versionPanel.classList.contains('hidden')) {
      clearVersionDiff();
      renderVersionList();
      versionPanel.classList.remove('hidden');
    } else {
      versionPanel.classList.add('hidden');
    }
  }

  // --- Wire up version panel controls ---
  const versionCloseBtn = document.getElementById('version-close');
  if (versionCloseBtn) versionCloseBtn.addEventListener('click', () => { clearVersionDiff(); versionPanel.classList.add('hidden'); });

  const versionUndoBtn = document.getElementById('version-undo');
  if (versionUndoBtn) versionUndoBtn.addEventListener('click', undoLastVersion);

  const versionSnapshotBtn = document.getElementById('version-snapshot');
  if (versionSnapshotBtn) versionSnapshotBtn.addEventListener('click', () => {
    const doc = getActiveDoc();
    if (!doc) return;
    snapshotVersion(doc, '手动快照');
    renderVersionList();
  });

  // Toolbar button to toggle the version panel.
  const versionBtn = document.getElementById('btn-version');
  if (versionBtn) versionBtn.addEventListener('click', toggleVersionPanel);

  // Make the version panel draggable by its header.
  if (versionPanel) makeDraggable(versionPanel, '.version-header');

  // ---------- Settings Modal ----------
  const settingsOverlay = document.getElementById('settings-overlay');

  function openSettings() {
    if (!settingsOverlay) return;
    // Load current values
    const cfg = getAIConfig();
    const setUrl = document.getElementById('set-api-url');
    const setKey = document.getElementById('set-api-key');
    const setModel = document.getElementById('set-api-model');
    const setTemp = document.getElementById('set-temperature');
    const setTempVal = document.getElementById('set-temp-val');
    if (setUrl) setUrl.value = cfg.url;
    if (setKey) setKey.value = cfg.key;
    if (setModel) setModel.value = cfg.model;
    if (setTemp) { setTemp.value = cfg.temperature; if (setTempVal) setTempVal.textContent = cfg.temperature; }
    // Thinking mode
    const setThinking = document.getElementById('set-thinking');
    const setThinkingStatus = document.getElementById('set-thinking-status');
    if (setThinking) {
      setThinking.checked = cfg.thinking;
      if (setThinkingStatus) setThinkingStatus.textContent = cfg.thinking ? '开启' : '关闭';
    }
    const setEditorTheme = document.getElementById('set-editor-theme');
    if (setEditorTheme) setEditorTheme.value = currentEditorTheme;
    const setCustomCSS = document.getElementById('set-custom-css');
    if (setCustomCSS) setCustomCSS.value = customCSS;
    // Mark active theme swatch
    document.querySelectorAll('.theme-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.theme === currentPreviewTheme);
    });
    settingsOverlay.classList.remove('hidden');
  }

  function closeSettings() {
    if (settingsOverlay) settingsOverlay.classList.add('hidden');
  }

  function saveSettings() {
    const cfg = {
      url: document.getElementById('set-api-url').value.trim(),
      key: document.getElementById('set-api-key').value.trim(),
      model: document.getElementById('set-api-model').value.trim(),
      temperature: parseFloat(document.getElementById('set-temperature').value),
    };
    localStorage.setItem('md-ai-url', cfg.url);
    localStorage.setItem('md-ai-key', cfg.key);
    localStorage.setItem('md-ai-model', cfg.model);
    localStorage.setItem('md-ai-temperature', cfg.temperature);
    // Thinking mode
    const thinking = document.getElementById('set-thinking').checked;
    localStorage.setItem('md-ai-thinking', thinking ? '1' : '0');
    // Theme
    const editorTheme = document.getElementById('set-editor-theme').value;
    applyEditorTheme(editorTheme);
    const customCSS = document.getElementById('set-custom-css').value;
    applyCustomCSS(customCSS);
    closeSettings();
    updateAIStatus();
  }

  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  const settingsCloseBtn = document.getElementById('settings-close');
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
  const settingsSaveBtn = document.getElementById('settings-save');
  if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveSettings);
  const settingsResetBtn = document.getElementById('settings-reset');
  if (settingsResetBtn) settingsResetBtn.addEventListener('click', () => {
    localStorage.removeItem('md-ai-url');
    localStorage.removeItem('md-ai-key');
    localStorage.removeItem('md-ai-model');
    localStorage.removeItem('md-ai-temperature');
    localStorage.removeItem('md-preview-theme');
    localStorage.removeItem('md-editor-theme');
    localStorage.removeItem('md-custom-css');
    location.reload();
  });

  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById('settings-tab-' + tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // Theme swatch click
  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      const theme = swatch.dataset.theme;
      applyPreviewTheme(theme);
      document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });

  // Temperature slider
  const tempSlider = document.getElementById('set-temperature');
  const tempVal = document.getElementById('set-temp-val');
  if (tempSlider) tempSlider.addEventListener('input', () => {
    if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
  });

  // Thinking mode toggle
  const thinkingToggle = document.getElementById('set-thinking');
  const thinkingStatus = document.getElementById('set-thinking-status');
  if (thinkingToggle) {
    thinkingToggle.addEventListener('change', () => {
      if (thinkingStatus) thinkingStatus.textContent = thinkingToggle.checked ? '开启' : '关闭';
    });
  }

  // Close settings on overlay click
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });
  }

  // AI button in toolbar
  const aiBtn = document.getElementById('btn-ai');
  if (aiBtn) aiBtn.addEventListener('click', toggleAIPanel);

  // ---------- Initial load ----------
  updateAIStatus();

  // ---------- Shell: open file passed via OS "Open With" ----------
  // Track the last path we opened so a cold-start pending path and the
  // warm-start 'shell:openFile' event (which can carry the same path)
  // don't double-open the file.
  let lastOpenedPath = null;
  function dedupedOpenFileByPath(filePath) {
    if (!filePath) return;
    if (lastOpenedPath === filePath) return;
    lastOpenedPath = filePath;
    openFileByPath(filePath);
  }

  // Warm start: app already running, OS routes the file to it. Register
  // this listener BEFORE polling the cold-start pending path so we never
  // miss an event that fires in the same tick.
  window.api.onShellOpenFile(filePath => dedupedOpenFileByPath(filePath));
  // Cold start: main process may have stashed a path from process.argv.
  // If a file is being opened, skip the sample document.
  window.api.getPendingPath().then(filePath => {
    if (filePath) {
      dedupedOpenFileByPath(filePath);
    } else {
      createDocument('示例文档', null, loadSampleIntoActive());
    }
  });

  async function openFileByPath(filePath) {
    try {
      const result = await window.api.readFileByPath(filePath);
      if (result && result.error) {
        // file missing — surface a notice but still open a stub
        createDocument(filePath.split(/[\\/]/).pop(), null, '# ⚠️ 文件未找到\n\n`' + filePath + '`');
        showToast('文件未找到: ' + filePath, 'error');
        return;
      }
      const name = filePath.split(/[\\/]/).pop();
      openFileIntoActive(result.filePath, result.content, name);
    } catch (err) {
      console.error('Shell open failed:', err);
      showToast('打开文件失败', 'error');
    }
  }
})();
