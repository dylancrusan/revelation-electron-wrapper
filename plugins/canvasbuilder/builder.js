/*
 * canvasbuilder/builder.js — Builder Extension Entry Point
 *
 * Mounts the canvas editor directly into #canvas-editor-panel (always visible)
 * and wires the inspector panel controls to canvas-editor.js exports.
 */
import {
  initCanvasEditor,
  renderCanvas,
  applyLayout,
  removeBg,
  getBlockStyle,
  setBlockStyleProp,
  getBodyInfo
} from './canvas-editor.js';
import { renderNotes } from './notes-preview.js';

function ensureStyles() {
  const id = 'canvasbuilder-styles';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id   = id;
  link.rel  = 'stylesheet';
  link.href = new URL('./styles.css', import.meta.url).href;
  document.head.appendChild(link);
}

export function getBuilderExtensions(ctx = {}) {
  const host = ctx.host;
  if (!host) return [];

  ensureStyles();

  const slug   = String(ctx.slug   || '').trim();
  const dir    = String(ctx.dir    || '').trim();
  const mdFile = String(ctx.mdFile || '').trim();

  // Shared state for context-aware inspector color picker
  let _notesSelRange = null;
  let _syncNotes     = null;

  // ── Canvas panel ───────────────────────────────────────────────────────────
  const canvasPanel = document.getElementById('canvas-editor-panel');
  if (!canvasPanel) return [];

  initCanvasEditor(canvasPanel, { host, slug, dir, mdFile });

  // Render immediately and on every host event
  renderCanvas();
  host.on('selection:changed', () => {
    renderCanvas();
    syncInspector();
  });
  host.on('document:changed', () => {
    renderCanvas();
    syncInspector();
  });
  host.on('save:before', () => {
    if (_syncNotes) _syncNotes();
  });

  // ── Inspector wiring ───────────────────────────────────────────────────────
  function syncInspector() {
    const style  = getBlockStyle();
    const info   = getBodyInfo();
    const zone   = style.zone || 'center';

    // Zone grid — highlight active button
    document.querySelectorAll('#insp-zone-grid .insp-zone-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.zone === zone);
    });

    // Block type
    const bts = document.getElementById('insp-block-type-select');
    if (bts) bts.value = info.blockType || 'p';

    // Text bg
    const tbs = document.getElementById('insp-text-bg-select');
    if (tbs) tbs.value = info.textBg || '';

    // Font, size
    const fontSel = document.getElementById('insp-font-select');
    if (fontSel) fontSel.value = style.font || '';

    const sizeSel = document.getElementById('insp-size-select');
    if (sizeSel) sizeSel.value = style.size || '';

    // Color swatch
    const colorBtn = document.getElementById('insp-color-btn');
    if (colorBtn) {
      const swatch = colorBtn.querySelector('.insp-color-swatch');
      if (swatch) swatch.style.background = style.color || '#ffffff';
    }

    // Bold / italic / underline
    const boldBtn      = document.getElementById('insp-bold-btn');
    const italicBtn    = document.getElementById('insp-italic-btn');
    const underlineBtn = document.getElementById('insp-underline-btn');
    if (boldBtn)      boldBtn.classList.toggle('is-active', !!style.bold);
    if (italicBtn)    italicBtn.classList.toggle('is-active', !!style.italic);
    if (underlineBtn) underlineBtn.classList.toggle('is-active', !!style.underline);

    // Align
    document.querySelectorAll('.insp-align-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.align === (style.align || 'center'));
    });

    // Remove-bg button visibility
    const removeBgBtn = document.getElementById('insp-remove-bg-btn');
    if (removeBgBtn) removeBgBtn.hidden = !info.hasBg;
  }

  // Zone grid
  document.querySelectorAll('#insp-zone-grid .insp-zone-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyLayout(btn.dataset.zone);
      syncInspector();
    });
  });

  // Background buttons
  const inspBgBtn = document.getElementById('insp-bg-btn');
  if (inspBgBtn) {
    inspBgBtn.addEventListener('click', () => {
      document.getElementById('add-top-media-btn')?.click();
    });
  }

  const inspTintBtn = document.getElementById('insp-tint-btn');
  if (inspTintBtn) {
    inspTintBtn.addEventListener('click', () => {
      document.getElementById('add-top-tint-btn')?.click();
    });
  }

  const inspRemoveBgBtn = document.getElementById('insp-remove-bg-btn');
  if (inspRemoveBgBtn) {
    inspRemoveBgBtn.addEventListener('click', () => {
      removeBg();
      syncInspector();
    });
  }

  // Block type
  const blockTypeSel = document.getElementById('insp-block-type-select');
  if (blockTypeSel) {
    blockTypeSel.addEventListener('change', () => {
      setBlockStyleProp('blockType', blockTypeSel.value);
      syncInspector();
    });
  }

  // Text bg
  const textBgSel = document.getElementById('insp-text-bg-select');
  if (textBgSel) {
    textBgSel.addEventListener('change', () => {
      setBlockStyleProp('textBg', textBgSel.value);
      syncInspector();
    });
  }

  // Font
  const fontSel = document.getElementById('insp-font-select');
  if (fontSel) {
    // Populate fonts from the builder's font picker if available
    _populateFontSelect(fontSel);
    fontSel.addEventListener('change', () => {
      setBlockStyleProp('font', fontSel.value);
    });
  }

  // Size
  const sizeSel = document.getElementById('insp-size-select');
  if (sizeSel) {
    sizeSel.addEventListener('change', () => {
      setBlockStyleProp('size', sizeSel.value);
    });
  }

  // Color — xcp palette, context-aware (canvas text or notes text)
  const colorBtn  = document.getElementById('insp-color-btn');
  const colorMenu = document.getElementById('insp-color-menu');
  if (colorBtn && colorMenu) {
    colorBtn.addEventListener('mousedown', () => {
      const notesEl = document.getElementById('notes-rendered');
      const sel = window.getSelection();
      if (notesEl && sel && sel.rangeCount > 0 && notesEl.contains(sel.anchorNode)) {
        _notesSelRange = sel.getRangeAt(0).cloneRange();
      } else {
        _notesSelRange = null;
      }
    });

    colorBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!colorMenu.hasChildNodes()) {
        colorMenu.appendChild(_buildXcpMenu(hex => {
          const notesEl = document.getElementById('notes-rendered');
          if (_notesSelRange && notesEl && _syncNotes) {
            notesEl.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(_notesSelRange);
            if (!sel.isCollapsed) {
              document.execCommand('foreColor', false, hex);
              _syncNotes();
            }
          } else {
            setBlockStyleProp('color', hex);
            const swatch = colorBtn.querySelector('.insp-color-swatch');
            if (swatch) swatch.style.background = hex;
            syncInspector();
          }
          colorMenu.hidden = true;
        }));
      }
      colorMenu.hidden = !colorMenu.hidden;
    });

    document.addEventListener('click', e => {
      if (!colorBtn.contains(e.target) && !colorMenu.contains(e.target)) {
        colorMenu.hidden = true;
      }
    });
  }

  // Bold / Italic / Underline
  const boldBtn      = document.getElementById('insp-bold-btn');
  const italicBtn    = document.getElementById('insp-italic-btn');
  const underlineBtn = document.getElementById('insp-underline-btn');

  if (boldBtn) {
    boldBtn.addEventListener('click', () => {
      const s = getBlockStyle();
      setBlockStyleProp('bold', !s.bold);
      syncInspector();
    });
  }
  if (italicBtn) {
    italicBtn.addEventListener('click', () => {
      const s = getBlockStyle();
      setBlockStyleProp('italic', !s.italic);
      syncInspector();
    });
  }
  if (underlineBtn) {
    underlineBtn.addEventListener('click', () => {
      const s = getBlockStyle();
      setBlockStyleProp('underline', !s.underline);
      syncInspector();
    });
  }

  // Align
  document.querySelectorAll('.insp-align-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setBlockStyleProp('align', btn.dataset.align);
      syncInspector();
    });
  });

  // Show Code button
  const showCodeBtn   = document.getElementById('show-code-btn');
  const builderMiddle = document.querySelector('.builder-middle');
  const midHandle     = document.getElementById('mid-right-resize-handle');
  if (showCodeBtn && builderMiddle) {
    showCodeBtn.addEventListener('click', () => {
      const isShown = !builderMiddle.hidden;
      builderMiddle.hidden = isShown;
      if (midHandle) midHandle.hidden = isShown;
      showCodeBtn.textContent = isShown ? 'Show Code ▾' : 'Hide Code ▲';
      showCodeBtn.classList.toggle('is-active', !isShown);
    });
  }

  // Initial inspector sync
  syncInspector();

  // Resize drag handles
  setupPreviewCanvasResize();
  setupCanvasNotesResize();
  setupWysiwygNotesResize();
  setupColumnResize();
  setupInspectorResize();

  // Notes WYSIWYG editor
  const notesEditor   = document.getElementById('notes-editor');
  const notesRendered = document.getElementById('notes-rendered');
  if (notesEditor && notesRendered) {

    function rgbToHex(color) {
      if (/^#[0-9a-fA-F]{3,6}$/.test(color)) return color.toLowerCase();
      const m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (!m) return null;
      return '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
    }

    function htmlToMarkdown(container) {
      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType !== Node.ELEMENT_NODE) return '';
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') return '\n';
        if (tag === 'hr') return '---\n';
        if (tag === 'ul' || tag === 'ol') {
          return Array.from(node.children).map((li, i) => {
            const content = walk(li).replace(/\n+$/, '');
            return tag === 'ol' ? `${i + 1}. ${content}` : `- ${content}`;
          }).join('\n') + '\n';
        }
        const inner = Array.from(node.childNodes).map(walk).join('');
        switch (tag) {
          case 'strong': case 'b':  return `**${inner}**`;
          case 'em':     case 'i':  return `*${inner}*`;
          case 'del': case 's': case 'strike': return `~~${inner}~~`;
          case 'u':    return inner;
          case 'code': return `\`${inner}\``;
          case 'a':    return `[${inner}](${node.getAttribute('href') || ''})`;
          case 'h1':   return `# ${inner}\n`;
          case 'h2':   return `## ${inner}\n`;
          case 'h3':   return `### ${inner}\n`;
          case 'span':
          case 'font': {
            const colorVal = (node.style && node.style.color) || node.getAttribute('color') || '';
            const hex = colorVal ? rgbToHex(colorVal) : null;
            return hex ? `{${hex}:${inner}}` : inner;
          }
          case 'p': case 'div': {
            if (node.classList.contains('notes-preview-gap')) return '\n';
            if (!inner.trim()) return '\n';
            return inner.endsWith('\n') ? inner : inner + '\n';
          }
          default: return inner;
        }
      }
      const raw = Array.from(container.childNodes).map(walk).join('');
      return raw.replace(/\n{3,}/g, '\n\n').trimEnd();
    }

    function syncToMarkdown() {
      const md = htmlToMarkdown(notesRendered);
      notesEditor.value = md;
      notesEditor.dispatchEvent(new Event('input', { bubbles: true }));
      notesRendered.classList.toggle('is-empty', !notesRendered.textContent.trim());
    }
    _syncNotes = syncToMarkdown;

    function loadFromMarkdown() {
      const md = notesEditor.value.trim();
      notesRendered.innerHTML = md ? renderNotes(notesEditor.value) : '';
      notesRendered.classList.toggle('is-empty', !md);
    }

    loadFromMarkdown();

    notesRendered.addEventListener('input', syncToMarkdown);

    notesRendered.addEventListener('paste', e => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    notesRendered.addEventListener('keydown', e => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        // Let the browser handle undo/redo natively; just stop it reaching the builder.
        e.stopPropagation();
        return;
      }
      if (e.shiftKey) return;
      if (key === 'b' || key === 'i' || key === 'u') {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'b') { document.execCommand('bold');   syncToMarkdown(); }
        if (key === 'i') { document.execCommand('italic'); syncToMarkdown(); }
        // 'u' is intentionally blocked — no clean Markdown for underline
      }
    });

    host.on('selection:changed', () => {
      requestAnimationFrame(loadFromMarkdown);
    });
  }

  return [];
}

function makeDragOverlay(cursor) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:${cursor};`;
  document.body.appendChild(el);
  return el;
}

function setupPreviewCanvasResize() {
  const handle = document.getElementById('preview-canvas-resize-handle');
  const previewFrame = document.getElementById('preview-frame');
  const canvasEditorPanel = document.getElementById('canvas-editor-panel');
  if (!handle || !previewFrame || !canvasEditorPanel) return;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    const container = handle.parentElement;
    const frameWrap = previewFrame.parentElement;
    const startY = e.clientY;
    const startH = frameWrap.offsetHeight;

    handle.classList.add('is-resizing');
    const overlay = makeDragOverlay('row-resize');

    function onMouseMove(e) {
      const containerH = container.offsetHeight;
      const newH = Math.max(80, Math.min(containerH - 80, startH + (e.clientY - startY)));
      frameWrap.style.flex = `0 0 ${(newH / containerH) * 100}%`;
    }

    function onMouseUp() {
      handle.classList.remove('is-resizing');
      overlay.remove();
      const pct = (frameWrap.offsetHeight / container.offsetHeight) * 100;
      localStorage.setItem('builder-preview-canvas-split', pct);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupWysiwygNotesResize() {
  const handle = document.getElementById('wysiwyg-notes-resize-handle');
  const wysiwygPanel = document.querySelector('.builder-slide-wysiwyg');
  const notesPanel = document.querySelector('.builder-notes');
  if (!handle || !wysiwygPanel || !notesPanel) return;

  const minH = 100;

  const savedWysiwyg = localStorage.getItem('builder-wysiwyg-height');
  const savedNotes = localStorage.getItem('builder-notes-height');
  if (savedWysiwyg) wysiwygPanel.style.height = savedWysiwyg + 'px';
  if (savedNotes) notesPanel.style.height = savedNotes + 'px';

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startWysiwygH = wysiwygPanel.offsetHeight;
    const startNotesH = notesPanel.offsetHeight;

    handle.classList.add('is-resizing');
    const overlay = makeDragOverlay('row-resize');

    function onMouseMove(e) {
      const delta = e.clientY - startY;
      wysiwygPanel.style.height = Math.max(minH, startWysiwygH + delta) + 'px';
      notesPanel.style.height = Math.max(minH, startNotesH - delta) + 'px';
    }

    function onMouseUp() {
      handle.classList.remove('is-resizing');
      overlay.remove();
      localStorage.setItem('builder-wysiwyg-height', wysiwygPanel.offsetHeight);
      localStorage.setItem('builder-notes-height', notesPanel.offsetHeight);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupCanvasNotesResize() {
  const handle = document.getElementById('canvas-notes-resize-handle');
  const notesPanel = document.querySelector('.builder-right > .builder-notes');
  if (!handle || !notesPanel) return;

  const savedNotes = localStorage.getItem('builder-canvas-notes-height');
  notesPanel.style.height = (savedNotes || '180') + 'px';

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startNotesH = notesPanel.offsetHeight;

    handle.classList.add('is-resizing');
    const overlay = makeDragOverlay('row-resize');

    function onMouseMove(e) {
      const delta = startY - e.clientY;
      notesPanel.style.height = Math.max(80, Math.min(600, startNotesH + delta)) + 'px';
    }

    function onMouseUp() {
      handle.classList.remove('is-resizing');
      overlay.remove();
      localStorage.setItem('builder-canvas-notes-height', notesPanel.offsetHeight);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupColumnResize() {
  const handle = document.getElementById('mid-right-resize-handle');
  const middleEl = document.querySelector('.builder-middle');
  if (!handle || !middleEl) return;

  const saved = localStorage.getItem('builder-col-middle-width');
  if (saved) middleEl.style.width = saved + 'px';

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = middleEl.offsetWidth;
    handle.classList.add('is-resizing');
    const overlay = makeDragOverlay('col-resize');

    function onMouseMove(e) {
      middleEl.style.width = Math.max(300, Math.min(900, startWidth + (e.clientX - startX))) + 'px';
    }

    function onMouseUp() {
      handle.classList.remove('is-resizing');
      overlay.remove();
      localStorage.setItem('builder-col-middle-width', middleEl.offsetWidth);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function setupInspectorResize() {
  const handle = document.getElementById('right-insp-resize-handle');
  const inspEl = document.getElementById('builder-inspector');
  if (!handle || !inspEl) return;

  const saved = localStorage.getItem('builder-inspector-width');
  if (saved) inspEl.style.width = saved + 'px';

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = inspEl.offsetWidth;
    handle.classList.add('is-resizing');
    const overlay = makeDragOverlay('col-resize');

    function onMouseMove(e) {
      const newWidth = Math.max(170, Math.min(520, startWidth + (startX - e.clientX)));
      inspEl.style.width = newWidth + 'px';
    }

    function onMouseUp() {
      handle.classList.remove('is-resizing');
      overlay.remove();
      localStorage.setItem('builder-inspector-width', inspEl.offsetWidth);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function _buildXcpMenu(onPick) {
  const THEME = [
    // Row 1: 40% tint
    '#666666','#C9C9C9','#FFFFFF','#E08585','#F4B183','#FFD966','#A9D18E','#9DC3E6','#6CA0D1','#B093CD',
    // Row 3: base — Black, Gray, White, Red, Orange, Gold, Green, LightBlue, Navy, Violet
    '#333333','#A5A5A5','#DFDFDF','#CC3333','#ED7D31','#FFC000','#70AD47','#5B9BD5','#2D5F8E','#7B4EA8',
    // Row 4: 25% shade
    '#000000','#7F7F7F','#BFBFBF','#992626','#C55A11','#BF9000','#538135','#2E75B6','#21476A','#5C3A7E',
  ];
  const STANDARD = [
    '#C00000','#FF0000','#FF6600','#FFC000','#FFFF00','#92D050','#00B050','#00B0F0','#002060','#7030A0',
  ];

  const frag = document.createDocumentFragment();

  const themeLabel = document.createElement('div');
  themeLabel.className = 'xcp-section-label';
  themeLabel.textContent = 'THEME COLORS';
  frag.appendChild(themeLabel);

  const themeGrid = document.createElement('div');
  themeGrid.className = 'xcp-theme-grid';
  THEME.forEach(hex => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'xcp-swatch';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('mousedown', e => e.preventDefault());
    s.addEventListener('click', () => onPick(hex));
    themeGrid.appendChild(s);
  });
  frag.appendChild(themeGrid);

  const divider = document.createElement('div');
  divider.className = 'xcp-divider';
  frag.appendChild(divider);

  const stdLabel = document.createElement('div');
  stdLabel.className = 'xcp-section-label xcp-section-label--standard';
  stdLabel.textContent = 'STANDARD COLORS';
  frag.appendChild(stdLabel);

  const stdGrid = document.createElement('div');
  stdGrid.className = 'xcp-standard-grid';
  STANDARD.forEach(hex => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'xcp-swatch xcp-swatch--std';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('mousedown', e => e.preventDefault());
    s.addEventListener('click', () => onPick(hex));
    stdGrid.appendChild(s);
  });
  frag.appendChild(stdGrid);

  return frag;
}

function _populateFontSelect(sel) {
  // If the builder has a global font list available, use it
  try {
    const fonts = window.__revBuilderState?.fonts || window.__revFontList || [];
    if (!fonts.length) return;
    fonts.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id || f.name || f;
      opt.textContent = f.name || f;
      sel.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}
