const { app, BrowserWindow, ipcMain, dialog, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const iconv = require('iconv-lite');

let mainWindow;
let isAlwaysOnTop = false;

// File path passed via OS "Open With" (cold start) — consumed once window ready.
let pendingOpenPath = null;

// Floating / edge-snap state lives in the main process so edge detection
// can react to real window movement (on('moved')) instead of polling.
let floatingMode = false;
let collapsed = false;
let collapsedEdge = 'left';    // which edge the icon is docked to
let suppressEdgeCheck = false; // guard around programmatic moves
let iconDragging = false;      // guard while user drags the collapsed icon

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1200, width - 100),
    height: Math.min(800, height - 100),
    minWidth: 400,
    minHeight: 300,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  Menu.setApplicationMenu(null);

  // Edge-snap: when the user drags the floating window near a screen edge,
  // tell the renderer to collapse it into a 48x48 icon.
  mainWindow.on('moved', () => {
    if (!floatingMode || collapsed || suppressEdgeCheck || iconDragging) return;
    const [x, y] = mainWindow.getPosition();
    const [w, h] = mainWindow.getSize();
    const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize;
    const t = 8;
    let edge = null;
    if (x <= t) edge = 'left';
    else if (y <= t) edge = 'top';
    else if (x + w >= aw - t) edge = 'right';
    if (edge) {
      collapsed = true;
      mainWindow.webContents.send('window:edge-snap', edge);
    }
  });
}

// --- Single-instance lock + "Open With" file handling ---
// When the user opens a file via the OS while the app is already running,
// Windows/macOS launches a second instance. We grab its argv and forward
// the path to the first instance, then bail out.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // Another instance already owns the lock — quit immediately; the first
  // instance received our argv via 'second-instance'.
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    // argv[1..] holds the file path passed by the OS.
    const filePath = extractFilePath(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (filePath) sendFileToRenderer(filePath);
  });

  app.whenReady().then(() => {
    createWindow();
    // Cold start: a file path may already be in argv before the window is
    // ready. Stash it; the renderer fetches it once loaded.
    pendingOpenPath = extractFilePath(process.argv);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Pull a Markdown/text file path out of process.argv (OS "Open With").
// Only matches explicit .md/.markdown/.txt extensions — no fuzzy fallback,
// otherwise internal Windows paths (e.g. temp dirs containing dots) get
// misread as documents when launching the portable exe directly.
function extractFilePath(argv) {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || a.startsWith('-')) continue;
    // skip the executable / app path itself
    if (a.endsWith('.exe') || a.toLowerCase().includes('electron')) continue;
    if (/\.(md|markdown|txt)$/i.test(a)) return a;
  }
  return null;
}

// Forward a file path to the renderer, either now (if ready) or as a
// pending request the renderer can poll.
function sendFileToRenderer(filePath) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('shell:openFile', filePath);
  } else {
    pendingOpenPath = filePath;
  }
}

// Renderer calls this once it's ready to receive a pending cold-start path.
ipcMain.handle('shell:getPendingPath', () => {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p;
});

// --- Window controls ---
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized());
ipcMain.handle('window:maximizable', () => mainWindow.isMaximizable());
ipcMain.handle('window:setAlwaysOnTop', (e, flag) => {
  isAlwaysOnTop = flag;
  mainWindow.setAlwaysOnTop(flag, 'floating');
});
ipcMain.handle('window:isAlwaysOnTop', () => isAlwaysOnTop);
ipcMain.handle('window:setSize', (e, w, h, animate) => {
  mainWindow.setMinimumSize(48, 48);
  mainWindow.setSize(w, h, animate || false);
});
ipcMain.handle('window:setMinimumSize', (e, w, h) => mainWindow.setMinimumSize(w, h));
ipcMain.handle('window:getPosition', () => mainWindow.getPosition());
ipcMain.handle('window:setPosition', (e, x, y) => mainWindow.setPosition(x, y));
ipcMain.handle('window:setResizable', (e, flag) => mainWindow.setResizable(flag));

// --- Floating mode (driven by main process) ---
ipcMain.handle('window:enterFloating', async () => {
  if (floatingMode) return;
  floatingMode = true;
  collapsed = false;
  suppressEdgeCheck = true;
  mainWindow.setMinimumSize(300, 200);
  mainWindow.setSize(380, 520);
  // Release the guard after the resize/move settles
  setTimeout(() => { suppressEdgeCheck = false; }, 400);
});

ipcMain.handle('window:exitFloating', async () => {
  if (!floatingMode) return;
  floatingMode = false;
  collapsed = false;
  suppressEdgeCheck = true;
  mainWindow.setMinimumSize(400, 300);
  mainWindow.setSize(1200, 800);
  setTimeout(() => { suppressEdgeCheck = false; }, 400);
});

ipcMain.handle('window:isFloating', () => floatingMode);

// Collapse to 48x48 at the given edge (renderer asks main to resize)
ipcMain.handle('window:collapseTo', async (e, edge) => {
  suppressEdgeCheck = true;
  mainWindow.setMinimumSize(48, 48);
  mainWindow.setSize(48, 48);
  const { width: aw } = screen.getPrimaryDisplay().workAreaSize;
  const pos = mainWindow.getPosition();
  let cx = pos[0];
  if (edge === 'left') cx = 0;
  else if (edge === 'right') cx = aw - 48;
  mainWindow.setPosition(cx, pos[1]);
  setTimeout(() => { suppressEdgeCheck = false; }, 300);
});

// Restore from collapsed icon back to floating window
ipcMain.handle('window:restoreFromCollapse', async (e, edge) => {
  collapsed = false;
  suppressEdgeCheck = true;
  mainWindow.setMinimumSize(300, 200);
  mainWindow.setSize(380, 520);
  const { width: aw } = screen.getPrimaryDisplay().workAreaSize;
  let cx = 200;
  if (edge === 'left') cx = 60;
  else if (edge === 'right') cx = aw - 440;
  mainWindow.setPosition(cx, 100);
  setTimeout(() => { suppressEdgeCheck = false; }, 400);
});

// Tell the main process the user is dragging the collapsed icon, so edge-snap
// should be suppressed for the duration of the drag.
ipcMain.handle('window:setIconDragging', (e, flag) => { iconDragging = flag; });

// After dragging the collapsed icon, snap it to the nearest screen edge (48x48).
// Called by the renderer on drag-end. Returns the chosen edge so the renderer
// can keep its collapsedEdge consistent for later restore.
ipcMain.handle('window:snapToNearestEdge', () => {
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize;
  // Compute distance of window center to each edge
  const cx = x + w / 2, cy = y + h / 2;
  const dists = {
    left: cx,
    right: aw - cx,
    top: cy,
    bottom: ah - cy,
  };
  // Find nearest edge; bias slightly toward left/right (side docks preferred)
  let edge = 'left', best = dists.left;
  for (const k of ['right', 'top', 'bottom']) {
    if (dists[k] < best) { best = dists[k]; edge = k; }
  }
  // Position flush to that edge (48x48)
  suppressEdgeCheck = true;
  mainWindow.setMinimumSize(48, 48);
  mainWindow.setSize(48, 48);
  let nx = x, ny = y;
  if (edge === 'left') nx = 0;
  else if (edge === 'right') nx = aw - 48;
  else if (edge === 'top') ny = 0;
  else if (edge === 'bottom') ny = ah - 48;
  // keep the other axis clamped on-screen
  nx = Math.max(0, Math.min(aw - 48, nx));
  ny = Math.max(0, Math.min(ah - 48, ny));
  mainWindow.setPosition(nx, ny);
  collapsed = true;
  collapsedEdge = edge;
  setTimeout(() => { suppressEdgeCheck = false; }, 300);
  return edge;
});

// --- Encoding-aware file reading ---
// Read a file and decode it to UTF-8, auto-detecting legacy encodings
// (GBK/GB18030/BIG5 etc.) so Chinese Windows files don't show as garbled.
function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);

  // BOM detection
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return iconv.decode(buf, 'utf-8'); // BOM present, strip it via utf-8 decode
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return iconv.decode(buf, 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return iconv.decode(buf, 'utf-16be');
  }

  // Try UTF-8 first — if it round-trips cleanly, it's UTF-8.
  const utf8 = iconv.decode(buf, 'utf-8');
  if (iconv.encode(utf8, 'utf-8').equals(buf)) {
    return utf-8;
  }

  // Not valid UTF-8: try Chinese legacy encodings.
  for (const enc of ['gb18030', 'gbk', 'gb2312', 'big5']) {
    const decoded = iconv.decode(buf, enc);
    // Heuristic: if decoding produced CJK characters and no lone surrogates, accept it.
    if (/[一-鿿　-〿＀-￯]/.test(decoded)) {
      return decoded;
    }
  }

  // Fallback: return UTF-8 as-is (may contain replacement chars, but won't crash).
  return utf8;
}

// --- File history support ---
// Read a file by absolute path (used by the recent-files history list).
ipcMain.handle('file:readByPath', async (e, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { error: 'notfound' };
    const content = readTextFile(filePath);
    return { filePath, content };
  } catch (err) {
    return { error: err.message };
  }
});
// Write content to an absolute path without showing a dialog (save in place).
ipcMain.handle('file:writeByPath', async (e, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch (err) {
    return false;
  }
});

// Clear history (no-op placeholder kept for symmetry / future use)
ipcMain.handle('file:clearHistory', () => true);

// --- Save prompt ---
// Synchronous message box asking whether to save unsaved changes.
// Returns: 'save' | 'discard' | 'cancel'
ipcMain.handle('dialog:savePrompt', (e, fileName) => {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '保存更改',
    message: '是否保存对「' + (fileName || '未命名') + '」的更改？',
    detail: '如果不保存，你的更改将会丢失。',
  });
  // Map button index → action
  return ['save', 'discard', 'cancel'][result] || 'cancel';
});

// --- File operations ---
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Text/Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = readTextFile(filePath);
  return { filePath, content };
});

ipcMain.handle('dialog:saveFile', async (e, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Markdown', extensions: ['md'] }],
    defaultPath: 'untitled.md',
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

// --- Export PDF ---
// Wrap body HTML in a light-themed document so the PDF reads like a normal
// printed page instead of capturing the app's dark preview theme.
function wrapPrintHtml(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 2cm 2.2cm; size: A4; }
  body{
    font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;
    max-width:none;margin:0;padding:0;
    background:#fff;color:#1f2937;line-height:1.7;
    font-size:14px;
  }
  h1,h2,h3,h4,h5,h2{color:#111827;margin-top:1.4em;margin-bottom:.5em;font-weight:700}
  h1{font-size:1.9em;border-bottom:2px solid #e5e7eb;padding-bottom:.3em}
  h2{font-size:1.45em;border-bottom:1px solid #e5e7eb;padding-bottom:.25em}
  h3{font-size:1.2em}
  p{margin:.6em 0}
  a{color:#2563eb;text-decoration:none}
  code{background:#f3f4f6;color:#1f2937;padding:.15em .4em;border-radius:4px;border:1px solid #e5e7eb;font-size:.88em;font-family:Consolas,monospace}
  pre{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:14px;overflow-x:auto}
  pre code{background:none;border:none;padding:0;font-size:.85em}
  blockquote{border-left:4px solid #d1d5db;padding:.4em 1em;margin:1em 0;color:#4b5563;background:#f9fafb;border-radius:0 4px 4px 0}
  table{border-collapse:collapse;margin:1em 0;width:100%}
  th,td{border:1px solid #d1d5db;padding:7px 12px;text-align:left;font-size:.92em}
  th{background:#f3f4f6;color:#111827;font-weight:600}
  hr{border:none;border-top:2px solid #e5e7eb;margin:2em 0}
  img{max-width:100%}
  ul,ol{padding-left:1.5em;margin:.6em 0}
  li{margin:.25em 0}
  /* highlight.js overrides for light theme */
  .hljs{background:transparent;color:#1f2937}
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

ipcMain.handle('dialog:savePDF', async (e, html, baseName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: (baseName || 'document') + '.pdf',
  });
  if (result.canceled || !result.filePath) return null;
  // Extract body content from the full HTML doc, then re-wrap with light theme
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  // Create an offscreen window to render the HTML, then print to PDF
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(wrapPrintHtml(bodyHtml)));
  const data = await pdfWin.webContents.printToPDF({
    marginsType: 0,
    printBackground: true,
    pageSize: 'A4',
    landscape: false,
  });
  pdfWin.destroy();
  fs.writeFileSync(result.filePath, data);
  return result.filePath;
});

ipcMain.handle('dialog:saveHTML', async (e, html, baseName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'HTML', extensions: ['html'] }],
    defaultPath: (baseName || 'document') + '.html',
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, html, 'utf-8');
  return result.filePath;
});

// --- Export DOCX ---
// Build a .docx from raw Markdown by lexing it with `marked` and converting
// the token stream into docx elements.
ipcMain.handle('dialog:saveDOCX', async (e, markdown, baseName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    defaultPath: (baseName || 'document') + '.docx',
  });
  if (result.canceled || !result.filePath) return null;

  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    BorderStyle, ImageRun, ExternalHyperlink, LevelFormat,
    Header, Footer, PageNumber } = require('docx');
  // marked v18 is ESM-only → use dynamic import
  const { marked } = await import('marked');

  // ---- inline: convert a single marked token (or array) into TextRuns ----
  // `baseColor` forces a text color (used for headings → black).
  function inlineRuns(token, baseColor) {
    const runs = [];
    const cc = baseColor; // inherit color if set
    if (typeof token === 'string') return [new TextRun(cc ? { text: token, color: cc } : { text: token })];
    if (Array.isArray(token)) { token.forEach(t => runs.push(...inlineRuns(t, cc))); return runs; }
    switch (token.type) {
      case 'text': // marked v18 text token may carry .tokens (sub-inline)
        if (token.tokens) return inlineRuns(token.tokens, cc);
        return [new TextRun(cc ? { text: token.text, color: cc } : { text: token.text })];
      case 'strong': return inlineRuns(token.tokens || token.text, cc).map(r => new TextRun({ ...r.options, bold: true, color: cc || r.options?.color }));
      case 'em': return inlineRuns(token.tokens || token.text, cc).map(r => new TextRun({ ...r.options, italics: true, color: cc || r.options?.color }));
      case 'del': return inlineRuns(token.tokens || token.text, cc).map(r => new TextRun({ ...r.options, strike: true, color: cc || r.options?.color }));
      case 'codespan': return [new TextRun({ text: token.text, font: 'Consolas', color: '282828' })];
      case 'link': return [new ExternalHyperlink({ children: inlineRuns(token.tokens || token.text, cc).map(r => new TextRun({ ...r.options, color: '0563C1', underline: {} })), link: token.href })];
      case 'checkbox': return [new TextRun({ text: token.checked ? '☑ ' : '☐ ', font: { name: 'Segoe UI Symbol', hint: 'default' } })];
      case 'br': return [new TextRun({ break: 1 })];
      case 'escape': return [new TextRun(cc ? { text: token.text, color: cc } : { text: token.text })];
      case 'image': {
        // images in inline context — best effort placeholder
        return [new TextRun({ text: `[图片]`, italics: true, color: '888888' })];
      }
      default: return token.text ? [new TextRun(cc ? { text: token.text, color: cc } : { text: token.text })] : [];
    }
  }

  // ---- block: convert one marked block token into a docx element (or array) ----
  function blockToElements(token) {
    switch (token.type) {
      case 'heading': {
        const map = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6 };
        const level = map[token.depth] || HeadingLevel.HEADING_6;
        // force black text to override Word's built-in blue heading color
        return [new Paragraph({ heading: level, children: inlineRuns(token.tokens || token.text, '000000') })];
      }
      case 'paragraph': {
        // may contain an image child — handle image paragraphs specially
        const first = token.tokens?.[0];
        if (first?.type === 'image') {
          return [new Paragraph({ children: [new TextRun({ text: `[图片: ${first.href}]`, italics: true, color: '888888' })] })];
        }
        return [new Paragraph({ children: inlineRuns(token.tokens || token.text), spacing: { after: 120, line: 360 }, indent: { firstLine: 480 } })];
      }
      case 'blockquote': {
        return (token.tokens || []).map(t =>
          new Paragraph({ children: inlineRuns(t.tokens || t.text), indent: { left: 720 }, border: { left: { style: BorderStyle.SINGLE, size: 3, color: '999999' } }, spacing: { after: 80 } })
        );
      }
      case 'code': {
        return token.text.split('\n').map(line =>
          new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], shading: { fill: 'F5F5F5' }, spacing: { after: 0 } })
        );
      }
      case 'list': {
        const fmt = token.ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET;
        const out = [];
        token.items.forEach((item) => {
          // item.tokens may be: [checkbox, text, ...] for task items, or [text, ...] for normal
          // collect all runs from the leading inline tokens (checkbox + text)
          const runs = [];
          let subLists = [];
          (item.tokens || []).forEach((t) => {
            if (t.type === 'list') { subLists.push(t); return; }
            runs.push(...inlineRuns(t));
          });
          if (runs.length === 0) runs.push(new TextRun(item.text));
          out.push(new Paragraph({ numbering: { reference: 'md-list', level: 0 }, children: runs }));
          // nested lists
          subLists.forEach((sub) => sub.items.forEach((si) => {
            const sruns = [];
            (si.tokens || []).forEach((t) => { if (t.type !== 'list') sruns.push(...inlineRuns(t)); });
            if (sruns.length === 0) sruns.push(new TextRun(si.text));
            out.push(new Paragraph({ numbering: { reference: 'md-list', level: 1 }, children: sruns }));
          }));
        });
        return out;
      }
      case 'table': {
        const { Table, TableRow, TableCell, WidthType } = require('docx');
        // Use fixed DXA widths (1 inch = 1440 DXA). Letter/A4 usable width
        // with default margins ≈ 9000 DXA. Distribute evenly across columns.
        const COLS = token.header.length;
        const COL_WIDTH = Math.floor(9000 / COLS);
        const rows = [];
        // header
        rows.push(new TableRow({ tableHeader: true, children: token.header.map(c =>
          new TableCell({ children: [new Paragraph({ children: inlineRuns(c.tokens || c.text, '000000') })], width: { size: COL_WIDTH, type: WidthType.DXA } })
        )}));
        // body
        token.rows.forEach(r => rows.push(new TableRow({ children: r.map(c =>
          new TableCell({ children: [new Paragraph({ children: inlineRuns(c.tokens || c.text) })], width: { size: COL_WIDTH, type: WidthType.DXA } })
        )})));
        return [new Table({
          width: { size: COLS * COL_WIDTH, type: WidthType.DXA },
          columnSizes: Array(COLS).fill(COL_WIDTH),
          rows,
        })];
      }
      case 'hr': {
        return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } }, children: [] })];
      }
      case 'space': return [];
      case 'html': return [];
      default: return token.text ? [new Paragraph({ children: [new TextRun(token.text)] })] : [];
    }
  }

  const tokens = marked.lexer(markdown);
  const elements = [];
  for (const t of tokens) {
    const els = blockToElements(t);
    if (els) elements.push(...els);
  }

  const doc = new Document({
    creator: 'Markdown Editor',
    title: 'Markdown Document',
    styles: {
      default: {
        document: {
          run: {
            font: { name: 'SimSun', hint: 'eastAsia' },
            size: 24, // 12pt
          },
          paragraph: {
            spacing: { line: 360 }, // 1.5 倍行距
          },
        },
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 44, bold: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 36, bold: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1, keepNext: true } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 30, bold: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 160, after: 80 }, outlineLevel: 2, keepNext: true } },
        { id: 'Heading4', name: 'Heading 4', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 140, after: 70 }, outlineLevel: 3, keepNext: true } },
        { id: 'Heading5', name: 'Heading 5', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 24, bold: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 120, after: 60 }, outlineLevel: 4, keepNext: true } },
        { id: 'Heading6', name: 'Heading 6', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 24, bold: true, italics: true, color: '000000', font: { name: 'SimSun', hint: 'eastAsia' } },
          paragraph: { spacing: { before: 100, after: 50 }, outlineLevel: 5, keepNext: true } },
      ],
    },
    numbering: {
      config: [{ reference: 'md-list', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '◦', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
      ] }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: baseName || 'Markdown Document', size: 18, color: '888888', font: { name: 'SimSun', hint: 'eastAsia' } })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ children: ['- ', PageNumber.CURRENT, ' -'], size: 18, color: '888888', font: { name: 'SimSun', hint: 'eastAsia' } }),
            ],
          })],
        }),
      },
      children: elements,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// --- AI Agent (runs in main process to avoid CORS) ---
// Tool definitions (OpenAI function-calling format). All tools execute in the
// renderer process (they need CodeMirror access); the main process dispatches
// them via IPC and awaits results using a deferred-promise pattern.
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: '读取当前编辑器中打开的文档全文内容。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_document',
      description: '在当前文档中精确查找一段文本并替换为新文本。old_text 必须与文档中的内容完全匹配（包括空白字符）。',
      parameters: {
        type: 'object',
        properties: {
          old_text: { type: 'string', description: '要查找并替换的原文（必须完全匹配）' },
          new_text: { type: 'string', description: '替换后的新文本' },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'insert_at_cursor',
      description: '在编辑器当前光标位置插入文本（如果有选区则替换选区）。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要插入的文本' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_selection',
      description: '获取编辑器中当前选中的文本和光标位置。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// System prompt injected as the first message of every agent session.
const AGENT_SYSTEM_PROMPT = `你是 Markdown 编辑器的 AI 助手，能自主编辑当前打开的文档。你可以使用工具读取和修改文档内容。

规则：
- 主动使用工具完成任务，不要只说"我会帮你…"然后停下
- 编辑前先读取文档内容，了解上下文
- 一次可以执行多个工具调用
- 完成任务后简要总结你做了什么
- 用用户的语言回复（默认中文）`;

// Pending renderer-tool requests: requestId -> { resolve, reject }.
const pendingTools = new Map();

// Dispatch a tool to the renderer and await its result.
function execRendererTool(sender, name, args) {
  return new Promise((resolve, reject) => {
    const requestId = 'tool_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    pendingTools.set(requestId, { resolve, reject });
    sender.send('agent:execTool', { requestId, name, args });
    // Safety timeout. Edit/insert tools wait for the user to confirm, so this
    // must be long enough to read the diff and decide (read/selection tools
    // return near-instantly, so the bound is driven by user interaction).
    setTimeout(() => {
      if (pendingTools.has(requestId)) {
        pendingTools.delete(requestId);
        reject(new Error('工具执行超时: ' + name));
      }
    }, 120000);
  });
}

// The renderer calls back here with a tool's result.
ipcMain.on('agent:toolResult', (e, { requestId, result, error }) => {
  const pending = pendingTools.get(requestId);
  if (!pending) return;
  pendingTools.delete(requestId);
  if (error) pending.reject(new Error(error));
  else pending.resolve(result);
});

// One streaming API call. Resolves { content, toolCalls }.
// content = concatenated text, toolCalls = [{ id, function: { name, arguments } }].
function streamApiCall(sender, cfg, messages) {
  return new Promise((resolve, reject) => {
    try {
      const apiUrl = new URL(cfg.url);
      const bodyObj = {
        model: cfg.model,
        messages,
        stream: true,
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
      };
      if (cfg.thinking) {
        bodyObj.thinking = { type: 'enabled', budget_tokens: 4000 };
        bodyObj.reasoning_effort = 'high';
      } else if (cfg.temperature != null) {
        bodyObj.temperature = cfg.temperature;
      }
      const body = JSON.stringify(bodyObj);
      const options = {
        hostname: apiUrl.hostname,
        port: apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80),
        path: apiUrl.pathname + apiUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
        },
      };
      const req = (apiUrl.protocol === 'https:' ? https : http).request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let errBody = '';
          res.on('data', (d) => { errBody += d; });
          res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + errBody.slice(0, 300))));
          return;
        }
        let buffer = '';
        let content = '';
        // Accumulate tool-call fragments by index.
        const toolCallChunks = {};
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) {
                content += delta.content;
                sender.send('agent:text', delta.content);
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallChunks[idx]) {
                    toolCallChunks[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                  }
                  if (tc.id) toolCallChunks[idx].id = tc.id;
                  if (tc.type) toolCallChunks[idx].type = tc.type;
                  if (tc.function?.name) toolCallChunks[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCallChunks[idx].function.arguments += tc.function.arguments;
                }
              }
            } catch { /* skip malformed */ }
          }
        });
        res.on('end', () => {
          // Assemble tool calls in index order, parsing accumulated arguments JSON.
          const toolCalls = Object.keys(toolCallChunks)
            .sort((a, b) => Number(a) - Number(b))
            .map((idx) => {
              const tc = toolCallChunks[idx];
              let parsedArgs = {};
              try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch { /* leave empty */ }
              return { id: tc.id, function: { name: tc.function.name, arguments: parsedArgs } };
            });
          resolve({ content, toolCalls });
        });
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// The agentic loop. Returns the full message history when done.
async function runAgentLoop(sender, cfg, messages) {
  const MAX_ROUNDS = 15;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let content = '';
    let toolCalls = [];
    try {
      const result = await streamApiCall(sender, cfg, messages);
      content = result.content;
      toolCalls = result.toolCalls;
    } catch (err) {
      throw err;
    }

    if (!toolCalls || toolCalls.length === 0) {
      // Pure text response — agent is done.
      messages.push({ role: 'assistant', content: content || '' });
      return messages;
    }

    // Register the assistant message that contains the tool calls.
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
      })),
    });

    // Execute each tool and append its result.
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments;
      sender.send('agent:tool_start', { toolName, toolArgs: JSON.stringify(toolArgs) });
      let resultStr = '';
      try {
        const result = await execRendererTool(sender, toolName, toolArgs);
        resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        resultStr = '错误: ' + err.message;
      }
      sender.send('agent:tool_result', { toolName, result: resultStr });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
    }
    // Loop back — the model sees tool results and may call more tools.
  }
  // Max rounds reached — force stop.
  messages.push({ role: 'assistant', content: '（已达到最大工具调用轮数，任务可能未完成）' });
  return messages;
}

ipcMain.handle('ai:agentChat', async (e, { cfg, messages }) => {
  const sender = e.sender;
  // Seed system prompt on first message.
  // Seed system prompt if the conversation doesn't already have one.
  if (!messages.some((m) => m.role === 'system')) {
    messages.unshift({ role: 'system', content: AGENT_SYSTEM_PROMPT });
  }
  const finalMessages = await runAgentLoop(sender, cfg, messages);
  sender.send('agent:done');
  return finalMessages;
});
