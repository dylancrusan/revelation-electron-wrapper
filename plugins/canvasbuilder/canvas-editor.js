/*
 * Visual canvas editor for slide layout/background editing.
 * Adapted from http_admin/builder/canvas-editor.js for the canvasbuilder plugin.
 *
 * Replaces direct builder-internal access (state, markDirty, topEditorEl, editorEl)
 * with the public BuilderHost API: host.getDocument(), host.getSelection(), host.transact().
 */
import { bodyToHtml, htmlToBody } from './slide-wysiwyg.js';

const CANVAS_BRIDGE = 'revelation-builder-preview-bridge';
let canvasBridgeToken = '';
let canvasIframeEl = null;

function generateCanvasBridgeToken() {
  if (canvasBridgeToken) return canvasBridgeToken;
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    canvasBridgeToken = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    canvasBridgeToken = Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
  }
  return canvasBridgeToken;
}

function sendCanvasCommand(command, payload) {
  if (!canvasIframeEl || !canvasIframeEl.contentWindow) return;
  canvasIframeEl.contentWindow.postMessage({
    bridge: CANVAS_BRIDGE,
    type: 'builder-command',
    token: generateCanvasBridgeToken(),
    command,
    payload: payload || {}
  }, '*');
}

// --- Injected via initCanvasEditor ---
let _host = null;
let _slug = '';
let _dir = '';
let _mdFile = '';

function navigateCanvas() {
  const sel = _host.getSelection();
  sendCanvasCommand('slide', { h: sel.h, v: sel.v });
}

function getCurrentSlide() {
  const { h, v } = _host.getSelection();
  return _host.getDocument().stacks[h]?.[v] || null;
}

function mutateCurrentSlide(label, mutator) {
  const { h, v } = _host.getSelection();
  const doc = _host.getDocument();
  const newStacks = doc.stacks.map((col, ch) =>
    col.map((slide, cv) => (ch === h && cv === v) ? { ...slide, ...mutator(slide) } : slide)
  );
  _host.transact(label, tx => tx.replaceStacks(newStacks));
}

let canvasEl = null;
let canvasActive = false;
let lastRenderedSlideKey = null;

const LAYOUT_ZONES = [
  { id: 'center',      macro: null,              label: 'Center',       ax: 50, ay: 50 },
  { id: 'upperthird',  macro: '{{upperthird}}',  label: 'Upper Third',  ax: 50, ay: 22 },
  { id: 'lowerthird',  macro: '{{lowerthird}}',  label: 'Lower Third',  ax: 50, ay: 78 },
  { id: 'shiftright',  macro: '{{shiftright}}',  label: 'Right',        ax: 72, ay: 50 },
  { id: 'shiftleft',   macro: '{{shiftleft}}',   label: 'Left',         ax: 28, ay: 50 },
  { id: 'topleft',     macro: '{{topleft}}',     label: 'Top Left',     ax: 28, ay: 22 },
  { id: 'topright',    macro: '{{topright}}',    label: 'Top Right',    ax: 72, ay: 22 },
  { id: 'bottomleft',  macro: '{{bottomleft}}',  label: 'Bottom Left',  ax: 28, ay: 78 },
  { id: 'bottomright', macro: '{{bottomright}}', label: 'Bottom Right', ax: 72, ay: 78 },
];

const LAYOUT_MACROS = ['{{upperthird}}', '{{lowerthird}}', '{{shiftright}}', '{{shiftleft}}',
                       '{{topleft}}', '{{topright}}', '{{bottomleft}}', '{{bottomright}}'];

function parseLayoutId(top) {
  if (!top) return 'center';
  if (top.includes('{{upperthird}}'))  return 'upperthird';
  if (top.includes('{{lowerthird}}'))  return 'lowerthird';
  if (top.includes('{{shiftright}}'))  return 'shiftright';
  if (top.includes('{{shiftleft}}'))   return 'shiftleft';
  if (top.includes('{{topleft}}'))     return 'topleft';
  if (top.includes('{{topright}}'))    return 'topright';
  if (top.includes('{{bottomleft}}'))  return 'bottomleft';
  if (top.includes('{{bottomright}}')) return 'bottomright';
  return 'center';
}

function parseBg(top) {
  if (!top) return null;
  const result = {};
  const tint = top.match(/\{\{bgtint:([^}]+)\}\}/);
  if (tint) result.tint = tint[1].trim();
  const bg = top.match(/!\[background(?:[^\]]*)\]\(([^)]+)\)/);
  if (bg) {
    const isVideo = /\.(mp4|webm|mov)$/i.test(bg[1]);
    result.image = { type: isVideo ? 'video' : 'image', value: bg[1] };
  } else {
    const fit = top.match(/!\[fit\]\(([^)]+)\)/);
    if (fit) result.image = { type: 'fit', value: fit[1] };
  }
  return (result.tint || result.image) ? result : null;
}

function stripLayoutMacros(top) {
  let t = top;
  LAYOUT_MACROS.forEach(m => {
    t = t.replace(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g'), '');
  });
  return t.trim();
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveMediaPath(value) {
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  if (value.startsWith('/')) return value;
  if (value.startsWith('media:')) {
    const tag = value.slice(6).trim();
    const yaml = window.jsyaml;
    if (yaml) {
      try {
        const fm = _host.getDocument().frontmatter || '';
        const m = fm.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?$/);
        const yamlText = m ? m[1] : fm.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
        const data = yaml.load(yamlText) || {};
        const entry = data.media && data.media[tag];
        if (entry && entry.filename) return '/' + _dir + '/' + _slug + '/' + entry.filename;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  return '/' + _dir + '/' + _slug + '/' + value;
}

function updateCanvasScale(stageEl) {
  const el = stageEl || (canvasEl && canvasEl.querySelector('.canvas-stage'));
  if (!el) return;
  const w = el.offsetWidth;
  if (w > 0) el.style.fontSize = (w / 1920 * 100) + 'px';
}

function parseBlockStyle(top) {
  const defaults = { zone: 'center', color: '#ffffff', font: '', size: '', align: 'center', bold: false, italic: false, underline: false };
  const m = (top || '').match(/\{\{canvas_block_1:([^}]+)\}\}/);
  if (!m) return defaults;
  const out = Object.assign({}, defaults);
  m[1].split(',').forEach(function(pair) {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k === 'bold' || k === 'italic' || k === 'underline') out[k] = v === '1';
    else out[k] = v;
  });
  return out;
}

function serializeBlockStyle(style, top) {
  const macro = '{{canvas_block_1:zone=' + (style.zone || 'center') +
    ',color=' + (style.color || '#ffffff') +
    ',font=' + (style.font || '') +
    ',size=' + (style.size || '') +
    ',align=' + (style.align || 'center') +
    ',bold=' + (style.bold ? '1' : '0') +
    ',italic=' + (style.italic ? '1' : '0') +
    ',underline=' + (style.underline ? '1' : '0') + '}}';
  const cleaned = (top || '').replace(/\{\{canvas_block_1:[^}]+\}\}\n?/g, '').trimEnd();
  return cleaned ? cleaned + '\n' + macro : macro;
}

function getBlockStyle() {
  const slide = getCurrentSlide();
  return parseBlockStyle(slide ? slide.top : null);
}

function setBlockStyleProp(key, value) {
  const slide = getCurrentSlide();
  if (!slide) return;

  // blockType and textBg affect the slide body/top differently
  if (key === 'blockType') {
    const newBody = applyBodyBlockType(slide.body, value);
    mutateCurrentSlide('Change block type', () => ({ body: newBody }));
    renderCanvas();
    return;
  }
  if (key === 'textBg') {
    const newTop = applyTextBg(slide.top, value);
    mutateCurrentSlide('Apply text background', () => ({ top: newTop }));
    renderCanvas();
    return;
  }

  const style = parseBlockStyle(slide.top);
  style[key] = value;
  if (!style.zone || style.zone === 'center') {
    const zoneFromLayout = parseLayoutId(slide.top);
    if (zoneFromLayout) style.zone = zoneFromLayout;
  }
  const newTop = serializeBlockStyle(style, slide.top);
  mutateCurrentSlide('Update block style', () => ({ top: newTop }));
  renderCanvas();
}

function getBodyInfo() {
  const slide = getCurrentSlide();
  return {
    blockType: slide ? detectBodyBlockType(slide.body) : 'p',
    textBg:    slide ? detectTextBg(slide.top) : '',
    hasBg:     slide ? !!parseBg(slide.top) : false
  };
}

function nearestZone(pctX, pctY) {
  const find = id => LAYOUT_ZONES.find(z => z.id === id);
  const dx = Math.abs(pctX - 50);
  const dy = Math.abs(pctY - 50);
  const inCornerX = pctX < 35 || pctX > 65;
  const inCornerY = pctY < 35 || pctY > 65;
  if (inCornerX && inCornerY) {
    if (pctX < 50 && pctY < 50) return find('topleft');
    if (pctX > 50 && pctY < 50) return find('topright');
    if (pctX < 50 && pctY > 50) return find('bottomleft');
    return find('bottomright');
  }
  if (dx > dy) {
    if (pctX > 55) return find('shiftright');
    if (pctX < 45) return find('shiftleft');
  } else {
    if (pctY < 33) return find('upperthird');
    if (pctY > 67) return find('lowerthird');
  }
  return find('center');
}

function applyLayout(zoneId) {
  const slide = getCurrentSlide();
  if (!slide) return;
  const zone = LAYOUT_ZONES.find(z => z.id === zoneId);
  if (!zone) return;
  let top = stripLayoutMacros(slide.top || '');
  if (zone.macro) top = top ? top + '\n' + zone.macro : zone.macro;
  const blockStyle = parseBlockStyle(top);
  blockStyle.zone = zoneId;
  top = serializeBlockStyle(blockStyle, top);
  mutateCurrentSlide('Apply layout', () => ({ top }));
  renderCanvas();
}

function removeBg() {
  const slide = getCurrentSlide();
  if (!slide) return;
  let top = slide.top || '';
  top = top.replace(/!\[(?:background[^\]]*|fit)\]\([^)]+\)\n?/g, '').trim();
  top = top.replace(/\{\{bgtint:[^}]+\}\}\n?/g, '').trim();
  mutateCurrentSlide('Remove background', () => ({ top }));
  renderCanvas();
}

function detectBodyBlockType(body) {
  const lines = (body || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^(!|\{\{|:audio:|:ATTRIB:|:AI:|\+\+|\|\||:[a-zA-Z])/.test(t)) continue;
    if (t.startsWith('##### ')) return 'h5';
    if (t.startsWith('#### '))  return 'h4';
    if (t.startsWith('### '))   return 'h3';
    if (t.startsWith('## '))    return 'h2';
    if (t.startsWith('# '))     return 'h1';
    if (t.startsWith('- '))     return 'ul';
    return 'p';
  }
  return 'p';
}

function detectTextBg(body) {
  const b = body || '';
  if (/\{\{darkbg\}\}|^:darkbg:$/m.test(b))  return 'darkbg';
  if (/\{\{lightbg\}\}|^:lightbg:$/m.test(b)) return 'lightbg';
  return '';
}

function applyTextBg(body, value) {
  let b = (body || '')
    .replace(/\{\{darkbg\}\}[ \t]*\n?/g, '')
    .replace(/\{\{lightbg\}\}[ \t]*\n?/g, '')
    .replace(/^:darkbg:[ \t]*\n?/gm, '')
    .replace(/^:lightbg:[ \t]*\n?/gm, '')
    .trim();
  if (value === 'darkbg')  b = '{{darkbg}}\n'  + b;
  if (value === 'lightbg') b = '{{lightbg}}\n' + b;
  return b;
}

function applyBodyBlockType(body, newType) {
  const lines = (body || '').split('\n');
  let applied = false;
  return lines.map(function(line) {
    if (applied) return line;
    const t = line.trim();
    if (!t || /^(!|\{\{|:audio:|:ATTRIB:|:AI:|\+\+|\|\||:[a-zA-Z])/.test(t)) return line;
    applied = true;
    const content = t.replace(/^#{1,5} /, '').replace(/^- /, '');
    if (newType === 'h1') return '# '    + content;
    if (newType === 'h2') return '## '   + content;
    if (newType === 'h3') return '### '  + content;
    if (newType === 'h4') return '#### ' + content;
    if (newType === 'h5') return '##### '+ content;
    if (newType === 'ul') return '- '    + content;
    return content;
  }).join('\n');
}

function renderBodyPreview(body) {
  var rawLines = (body || '').split('\n').filter(function(l) {
    var t = l.trim();
    if (!t) return false;
    if (t.startsWith(':note:') || t.startsWith('Note:')) return false;
    if (t.startsWith(':ATTRIB:')) return false;
    if (t.startsWith('<!--')) return false;
    if (t === '||') return false;
    if (/^!\[background/i.test(t)) return false;
    if (!t.replace(/\{\{[^}]+\}\}/g, '').trim()) return false;
    return true;
  });
  if (!rawLines.length) return '<span class="canvas-placeholder">Double-click to add text</span>';

  function renderInline(text) {
    if (/<\/?[a-zA-Z]/.test(text)) return text;
    var s = text.replace(/\{\{[^}]+\}\}/g, '').trim();
    if (!s) return '';
    return escHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
  }

  function isBlock(line) {
    return line.startsWith('- ') || /^#{1,3} /.test(line) || line.startsWith('> ');
  }

  var lines = [];
  var j = 0;
  while (j < rawLines.length) {
    var cur = rawLines[j];
    if (!isBlock(cur) && cur.endsWith('  ')) {
      var combined = cur.replace(/  $/, '');
      while (j + 1 < rawLines.length && !isBlock(rawLines[j + 1])) {
        j++;
        var next = rawLines[j];
        if (next.endsWith('  ')) {
          combined += '\n' + next.replace(/  $/, '');
        } else {
          combined += '\n' + next;
          break;
        }
      }
      lines.push(combined);
    } else {
      lines.push(cur);
    }
    j++;
  }

  var out = '';
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    var content;
    if (line.startsWith('# ')) {
      content = renderInline(line.slice(2));
      if (content) out += '<div class="canvas-h1">' + content + '</div>';
      i++;
    } else if (line.startsWith('## ')) {
      content = renderInline(line.slice(3));
      if (content) out += '<div class="canvas-h2">' + content + '</div>';
      i++;
    } else if (line.startsWith('### ')) {
      content = renderInline(line.slice(4));
      if (content) out += '<div class="canvas-h3">' + content + '</div>';
      i++;
    } else if (line.startsWith('- ')) {
      var items = '';
      while (i < lines.length && lines[i].startsWith('- ')) {
        content = renderInline(lines[i].slice(2));
        if (content) items += '<div class="canvas-li">• ' + content + '</div>';
        i++;
      }
      if (items) out += '<div class="canvas-ul">' + items + '</div>';
    } else if (line.startsWith('> ')) {
      var bqParts = [];
      var bqc = renderInline(line.slice(2).replace(/  $/, ''));
      if (bqc) bqParts.push(bqc);
      while (i + 1 < lines.length) {
        var nx = lines[i + 1];
        if (nx.startsWith('> ')) {
          i++;
          bqc = renderInline(lines[i].slice(2).replace(/  $/, ''));
          if (bqc) bqParts.push(bqc);
        } else if (!isBlock(nx) && i + 2 < lines.length && lines[i + 2].startsWith('> ')) {
          i++;
          bqc = renderInline(lines[i].replace(/  $/, ''));
          if (bqc) bqParts.push(bqc);
        } else {
          break;
        }
      }
      if (bqParts.length) out += '<div class="canvas-blockquote">' + bqParts.join('<br>') + '</div>';
      i++;
    } else {
      var parts = line.split('\n');
      var rendered = [];
      for (var k = 0; k < parts.length; k++) {
        var part = renderInline(parts[k]);
        if (part) rendered.push(part);
      }
      content = rendered.join('<br>');
      if (content) out += '<div class="canvas-p">' + content + '</div>';
      i++;
    }
  }
  return out || '<span class="canvas-placeholder">Double-click to add text</span>';
}

function renderCanvas() {
  if (!canvasEl) return;
  const slide = getCurrentSlide();
  if (!slide) {
    canvasEl.innerHTML = '<div class="canvas-empty">No slide selected</div>';
    canvasIframeEl = null;
    lastRenderedSlideKey = null;
    return;
  }

  const sel = _host.getSelection();
  const slideKey = sel.h + ':' + sel.v;
  if (lastRenderedSlideKey !== null && lastRenderedSlideKey !== slideKey) {
    exitEditModeUI();
  }
  lastRenderedSlideKey = slideKey;

  const layoutId = parseLayoutId(slide.top);
  const bg = parseBg(slide.top);

  if (!canvasEl.querySelector('.canvas-stage')) {
    const zoneHints = LAYOUT_ZONES.map(z =>
      '<div class="canvas-zone-hint canvas-zh-' + z.id + '" data-zone="' + z.id + '"><span>' + z.label + '</span></div>'
    ).join('');

    canvasEl.innerHTML =
      '<div class="canvas-bg-actions">' +
        '<button class="canvas-act-btn canvas-edit-btn" type="button">Edit Text</button>' +
        '<button class="canvas-act-btn" type="button" data-action="change-bg">Background</button>' +
        '<button class="canvas-act-btn" type="button" data-action="change-tint">Tint</button>' +
        '<button class="canvas-act-btn canvas-act-remove" type="button" data-action="remove-bg" hidden>Remove Bg</button>' +
      '</div>' +
      '<div class="canvas-stage-wrap">' +
        '<div class="canvas-stage">' +
          '<div class="canvas-zone-hints" hidden>' + zoneHints + '</div>' +
          '<div class="canvas-text-block canvas-zone-' + layoutId + '">' +
            '<div class="canvas-text-inner"></div>' +
          '</div>' +
          '<div class="canvas-text-editor slide-wysiwyg-editor" contenteditable="true" spellcheck="true" hidden placeholder="Type slide text here…"></div>' +
          '<div class="canvas-drag-hint">Double-click to edit · Drag to reposition</div>' +
        '</div>' +
      '</div>';

    wireEvents(canvasEl);

    // Iframe shows the saved presentation for background reference
    canvasIframeEl = document.createElement('iframe');
    canvasIframeEl.className = 'canvas-iframe';
    canvasIframeEl.sandbox = 'allow-scripts';
    canvasIframeEl.setAttribute('referrerpolicy', 'no-referrer');
    canvasIframeEl.title = 'Slide preview';

    const params = new URLSearchParams();
    params.set('p', _mdFile);
    params.set('builderPreview', '1');
    params.set('builderPreviewToken', generateCanvasBridgeToken());
    params.set('forceControls', '0');
    canvasIframeEl.src = window.location.origin + '/' + _dir + '/' + _slug + '/index.html?' + params.toString();

    const stage = canvasEl.querySelector('.canvas-stage');
    stage.insertBefore(canvasIframeEl, stage.firstChild);
  }

  const removeBtn = canvasEl.querySelector('.canvas-act-remove');
  if (removeBtn) removeBtn.hidden = !bg;

  const textBlock = canvasEl.querySelector('.canvas-text-block');
  if (textBlock) {
    LAYOUT_ZONES.forEach(z => textBlock.classList.remove('canvas-zone-' + z.id));
    textBlock.classList.add('canvas-zone-' + layoutId);
    const textInner = textBlock.querySelector('.canvas-text-inner');
    if (textInner && textInner.style.display !== 'none') {
      textInner.innerHTML = renderBodyPreview(slide.body);
    }
  }

  navigateCanvas();
}

function wireEvents(container) {
  const stage        = container.querySelector('.canvas-stage');
  const textBlock    = container.querySelector('.canvas-text-block');
  const zoneHints    = container.querySelector('.canvas-zone-hints');
  const editBtn      = container.querySelector('.canvas-edit-btn');
  const textInner    = container.querySelector('.canvas-text-inner');
  const textarea     = container.querySelector('.canvas-text-editor');
  const dragHint     = container.querySelector('.canvas-drag-hint');
  const changeBgBtn  = container.querySelector('[data-action="change-bg"]');
  const changeTintBtn= container.querySelector('[data-action="change-tint"]');
  const removeBgBtn  = container.querySelector('[data-action="remove-bg"]');

  const enterEditMode = function() {
    const slide = getCurrentSlide();
    textarea.innerHTML = bodyToHtml(slide ? (slide.body || '') : '');
    const layoutId = parseLayoutId(slide ? (slide.top || '') : '');
    LAYOUT_ZONES.forEach(z => textarea.classList.remove('canvas-zone-' + z.id));
    textarea.classList.add('canvas-zone-' + layoutId);
    textarea.hidden = false;
    if (changeBgBtn)   changeBgBtn.hidden   = true;
    if (changeTintBtn) changeTintBtn.hidden = true;
    if (removeBgBtn)   removeBgBtn.hidden   = true;
    textInner.style.display = 'none';
    if (dragHint) dragHint.hidden = true;
    editBtn.textContent = 'Save Text';
    editBtn.classList.add('is-saving');
    textarea.focus();
  };

  const exitEditMode = function() {
    LAYOUT_ZONES.forEach(z => textarea.classList.remove('canvas-zone-' + z.id));
    textarea.hidden = true;
    if (changeBgBtn)   changeBgBtn.hidden   = false;
    if (changeTintBtn) changeTintBtn.hidden = false;
    const slide = getCurrentSlide();
    if (removeBgBtn) removeBgBtn.hidden = !parseBg(slide ? slide.top : null);
    textInner.style.display = '';
    if (dragHint) dragHint.hidden = false;
    editBtn.textContent = 'Edit Text';
    editBtn.classList.remove('is-saving');
  };

  container.querySelectorAll('.canvas-act-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'change-bg') {
        // Delegate to the core builder's media button if available
        document.getElementById('add-top-media-btn')?.click();
      } else if (action === 'change-tint') {
        document.getElementById('add-top-tint-btn')?.click();
      } else if (action === 'remove-bg') {
        removeBg();
      }
    });
  });

  if (editBtn && textarea && textInner) {
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!textarea.hidden) {
        commitEdit(textarea);
      } else {
        enterEditMode();
      }
    });

    textarea.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        commitEdit(textarea);
      }
      if (e.key === 'Escape') exitEditMode();
    });
  }

  if (!textBlock || !stage || !zoneHints) return;

  let dragging = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let offsetX = 0;
  let offsetY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;

  textBlock.addEventListener('dblclick', e => {
    if (textarea && !textarea.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    enterEditMode();
  });

  textBlock.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (textarea && !textarea.hidden) return;

    const stageRect = stage.getBoundingClientRect();
    const blockRect = textBlock.getBoundingClientRect();
    offsetX = e.clientX - blockRect.left;
    offsetY = e.clientY - blockRect.top;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    dragging = false;

    function onMouseMove(e) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;

      if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        dragging = true;
        textBlock.classList.add('is-dragging');
        LAYOUT_ZONES.forEach(z => textBlock.classList.remove('canvas-zone-' + z.id));
        textBlock.style.position  = 'absolute';
        textBlock.style.left      = (blockRect.left - stageRect.left) + 'px';
        textBlock.style.top       = (blockRect.top  - stageRect.top)  + 'px';
        textBlock.style.transform = 'none';
        textBlock.style.width     = blockRect.width + 'px';
        zoneHints.hidden = false;
        if (dragHint) dragHint.hidden = true;
      }

      if (!dragging) return;
      const sr = stage.getBoundingClientRect();
      let nl = e.clientX - sr.left - offsetX;
      let nt = e.clientY - sr.top  - offsetY;
      nl = Math.max(0, Math.min(nl, sr.width  - textBlock.offsetWidth));
      nt = Math.max(0, Math.min(nt, sr.height - textBlock.offsetHeight));
      textBlock.style.left = nl + 'px';
      textBlock.style.top  = nt + 'px';
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      const px = ((e.clientX - sr.left) / sr.width)  * 100;
      const py = ((e.clientY - sr.top)  / sr.height) * 100;
      const near = nearestZone(px, py);
      zoneHints.querySelectorAll('.canvas-zone-hint').forEach(h => {
        h.classList.toggle('is-near', h.dataset.zone === near.id);
      });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!dragging) return;

      dragging = false;
      textBlock.classList.remove('is-dragging');
      zoneHints.hidden = true;
      if (dragHint) dragHint.hidden = false;

      textBlock.style.position  = '';
      textBlock.style.left      = '';
      textBlock.style.top       = '';
      textBlock.style.transform = '';
      textBlock.style.width     = '';

      const sr = stage.getBoundingClientRect();
      const px = ((lastMouseX - sr.left) / sr.width)  * 100;
      const py = ((lastMouseY - sr.top)  / sr.height) * 100;
      const near = nearestZone(px, py);
      applyLayout(near.id);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function exitEditModeUI() {
  if (!canvasEl) return;
  const textarea    = canvasEl.querySelector('.canvas-text-editor');
  const textInner   = canvasEl.querySelector('.canvas-text-inner');
  const dragHint    = canvasEl.querySelector('.canvas-drag-hint');
  const editBtn     = canvasEl.querySelector('.canvas-edit-btn');
  const changeBgBtn = canvasEl.querySelector('[data-action="change-bg"]');
  const changeTintBtn = canvasEl.querySelector('[data-action="change-tint"]');
  const removeBgBtn = canvasEl.querySelector('[data-action="remove-bg"]');
  if (textarea) {
    LAYOUT_ZONES.forEach(z => textarea.classList.remove('canvas-zone-' + z.id));
    textarea.hidden = true;
  }
  if (changeBgBtn)   changeBgBtn.hidden   = false;
  if (changeTintBtn) changeTintBtn.hidden = false;
  const slide = getCurrentSlide();
  if (removeBgBtn) removeBgBtn.hidden = !parseBg(slide ? slide.top : null);
  if (textInner) textInner.style.display = '';
  if (dragHint)  dragHint.hidden = false;
  if (editBtn)   { editBtn.textContent = 'Edit Text'; editBtn.classList.remove('is-saving'); }
}

function commitEdit(textarea) {
  const newBody = htmlToBody(textarea.innerHTML);
  mutateCurrentSlide('Edit text', () => ({ body: newBody }));
  exitEditModeUI();
  renderCanvas();
}

function initCanvasEditor(el, opts) {
  canvasEl = el;
  _host    = opts.host;
  _slug    = opts.slug || '';
  _dir     = opts.dir  || '';
  _mdFile  = opts.mdFile || '';

  window.addEventListener('message', function(event) {
    if (!canvasIframeEl || event.source !== canvasIframeEl.contentWindow) return;
    const data = event.data || {};
    if (data.bridge !== CANVAS_BRIDGE || data.type !== 'preview-event') return;
    if (data.token !== generateCanvasBridgeToken()) return;
    if (data.event === 'ready' || data.event === 'slidechanged') navigateCanvas();
  });
}

function activateCanvas() {
  canvasActive = true;
  renderCanvas();
}

function deactivateCanvas() {
  canvasActive = false;
}

function isCanvasActive() { return canvasActive; }

export { initCanvasEditor, activateCanvas, deactivateCanvas, isCanvasActive, renderCanvas, getBlockStyle, getBodyInfo, setBlockStyleProp, applyLayout, removeBg };
