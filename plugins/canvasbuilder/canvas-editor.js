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

function buildPreviewUrl() {
  const params = new URLSearchParams();
  params.set('p', _mdFile);
  params.set('builderPreview', '1');
  params.set('builderPreviewToken', generateCanvasBridgeToken());
  params.set('forceControls', '0');
  // Cache-bust so the preview always re-fetches its module graph fresh
  // instead of reusing whatever was already loaded/evaluated in the iframe —
  // needed because reloading is otherwise the only way to pick up a code
  // change that happened after the iframe first loaded this session.
  params.set('_r', Date.now().toString(36));
  return window.location.origin + '/' + _dir + '/' + _slug + '/index.html?' + params.toString();
}

// Reloads just the preview iframe, not the builder itself — safe to call any
// time, including with unsaved edits, since none of that state lives in the
// iframe. Lets a stuck/stale live preview (e.g. after this plugin's code
// changed mid-session) be recovered without saving or restarting the app.
function refreshPreviewIframe() {
  if (!canvasIframeEl) return;
  canvasIframeEl.src = buildPreviewUrl();
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
let _onSelectionChange = null;

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
let selectedBlockId = 1;
let editingBlockId = null;

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

// How close (in % of stage size) a drag has to get to one of the 8
// non-center preset anchors (corners/thirds/shifts) before it snaps there.
const ZONE_SNAP_THRESHOLD = 4;
// Separate, tighter threshold for the horizontal/vertical center lines,
// checked per-axis independently of the 9-preset snap above — so a block
// can be horizontally centered while sitting anywhere vertically (and vice
// versa), the way alignment guides work in Keynote/PowerPoint, rather than
// only snapping when it's close to the single combined "center" point.
const CENTER_SNAP_THRESHOLD = 1;

// Shared snap logic for both the live drag preview and the final drop, so
// what the box appears to stick to while dragging is exactly where it lands.
function applyDragSnap(px, py) {
  let x = px, y = py;
  if (Math.abs(x - 50) < CENTER_SNAP_THRESHOLD) x = 50;
  if (Math.abs(y - 50) < CENTER_SNAP_THRESHOLD) y = 50;
  const zone = LAYOUT_ZONES.filter(z => z.id !== 'center')
    .find(z => Math.abs(z.ax - x) < ZONE_SNAP_THRESHOLD && Math.abs(z.ay - y) < ZONE_SNAP_THRESHOLD);
  if (zone) { x = zone.ax; y = zone.ay; }
  const zoneId = zone ? zone.id : (x === 50 && y === 50 ? 'center' : '');
  return { x, y, zoneId };
}

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
  // .canvas-stage used to be mis-sized (width:100% fighting max-height meant
  // it rendered wider than true 16:9, e.g. 788px instead of the correct
  // 624px at one measured window size) — that bug was fixed in the stage's
  // CSS, but it means `w` here is now smaller than before, so this formula's
  // base divisor needed recalibrating too.
  //
  // Calibrate against on-screen pixel width (getBoundingClientRect), not
  // getComputedStyle font-size: the local stage and the real iframe now
  // occupy the exact same physical box (post aspect-ratio fix), so their
  // rendered on-screen sizes are directly comparable. getComputedStyle is
  // NOT comparable this way — the real renderer's declared font-size is in
  // reveal.js's own design space, before reveal's internal `transform:
  // scale()` on `.slides`, and chasing that mismatch made things worse.
  // Measured directly: the plain w/1920*100 formula renders headings a
  // uniform ~1.128x wider on-screen than the real renderer, across h1/h3/h6
  // alike — this divisor corrects for that.
  if (w > 0) el.style.fontSize = (w / 1920 * 100 / 1.128) + 'px';
}

// Per-block style: styling metadata for one canvas text block, stored as an
// inline `<!-- canvas_block_N: key=val,... -->` marker line at the start of
// the block's own content within slide.body. HTML comments (not a {{macro}})
// are used deliberately: the real slide renderer doesn't understand this
// marker yet, and unlike {{...}} macros, an unrecognized HTML comment is
// always invisible in the compiled output rather than leaking as literal
// text. A slide with no marker at all is treated as a single implicit block
// (id 1, default style) — this is what keeps every existing single-block
// presentation byte-for-byte unchanged.
const BLOCK_STYLE_DEFAULTS = Object.freeze({
  zone: 'center', color: '#ffffff', font: '', size: '', align: 'center',
  bold: false, italic: false, underline: false, boxBg: '', boxBorder: '',
  // Freeform position (% of stage, anchored at the block's own center).
  // Empty until the block is dragged or moved via the Layout Zone grid;
  // resolveBlockPosition() falls back to the zone's preset ax/ay until then.
  x: '', y: ''
});

// Split on commas that separate key=value pairs, but not commas nested
// inside parentheses — needed because values like box-bg's rgba(r,g,b,a)
// contain commas of their own.
function splitStyleArgs(str) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(str || '')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseBlockStyleArgs(argsStr) {
  const out = Object.assign({}, BLOCK_STYLE_DEFAULTS);
  splitStyleArgs(argsStr).forEach(function(pair) {
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k === 'bold' || k === 'italic' || k === 'underline') out[k] = v === '1';
    else if (k === 'box-bg') out.boxBg = v;
    else if (k === 'box-border') out.boxBorder = v;
    else if (k in out) out[k] = v;
  });
  return out;
}

function serializeBlockStyleArgs(style) {
  let s = 'zone=' + (style.zone || '') +
    ',color=' + (style.color || '#ffffff') +
    ',font=' + (style.font || '') +
    ',size=' + (style.size || '') +
    ',align=' + (style.align || 'center') +
    ',bold=' + (style.bold ? '1' : '0') +
    ',italic=' + (style.italic ? '1' : '0') +
    ',underline=' + (style.underline ? '1' : '0');
  if (style.boxBg) s += ',box-bg=' + style.boxBg;
  if (style.boxBorder) s += ',box-border=' + style.boxBorder;
  if (style.x !== '' && style.x != null && style.y !== '' && style.y != null) {
    s += ',x=' + style.x + ',y=' + style.y;
  }
  return s;
}

function trimBlankEdges(lines) {
  const out = lines.slice();
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// Split slide body into an ordered list of blocks at inline
// <!-- canvas_block_N: ... --> marker lines. No markers → one implicit block.
function parseBodyBlocks(body) {
  const markerRe = /^<!--\s*canvas_block_(\d+):\s*(.*?)\s*-->$/;
  const lines = (body || '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  const startBlock = (id, style, explicit) => {
    current = { id, style, explicit, lines: [] };
    blocks.push(current);
  };

  for (const line of lines) {
    const m = line.trim().match(markerRe);
    if (m) {
      startBlock(Number(m[1]), parseBlockStyleArgs(m[2]), true);
      continue;
    }
    if (!current) startBlock(1, Object.assign({}, BLOCK_STYLE_DEFAULTS), false);
    current.lines.push(line);
  }
  if (!blocks.length) startBlock(1, Object.assign({}, BLOCK_STYLE_DEFAULTS), false);

  return blocks.map((b) => ({
    id: b.id,
    style: b.style,
    explicit: b.explicit,
    content: trimBlankEdges(b.lines).join('\n')
  }));
}

// Reassemble parsed blocks back into a slide body string. Blocks without an
// explicit style (never touched by the inspector) serialize as plain
// content with no marker, so untouched slides round-trip byte-for-byte.
function serializeBodyBlocks(blocks) {
  return blocks.map((b) => {
    if (!b.explicit) return b.content;
    const marker = '<!-- canvas_block_' + b.id + ': ' + serializeBlockStyleArgs(b.style) + ' -->';
    return b.content ? marker + '\n' + b.content : marker;
  }).join('\n\n').trim();
}

// Resolve which zone a block should render at. Block 1 without its own
// explicit style falls back to the legacy slide-wide top-matter zone macro
// (single-block back-compat); every other block always has explicit style
// once created, since there's no other way for it to exist.
function resolveBlockZone(block, slideTop) {
  if (block.explicit && block.style.zone) return block.style.zone;
  if (block.id === 1) return parseLayoutId(slideTop);
  return 'center';
}

function findBlock(blocks, id) {
  return blocks.find(b => b.id === id) || blocks[0];
}

// True once a block has been dragged or moved via the Layout Zone grid —
// from then on its position is freeform (x/y percentages), not one of the
// 9 preset zones.
function hasExplicitPosition(block) {
  return block.style.x !== '' && block.style.x != null &&
         block.style.y !== '' && block.style.y != null;
}

// Resolve a block's on-stage anchor point as {x, y} percentages. Freeform
// blocks use their own stored x/y; anything else falls back to its resolved
// zone's preset anchor (LAYOUT_ZONES' ax/ay), so legacy zone-only blocks and
// brand-new blocks both get a sensible starting point.
function resolveBlockPosition(block, slideTop) {
  if (hasExplicitPosition(block)) {
    return { x: parseFloat(block.style.x), y: parseFloat(block.style.y) };
  }
  const zoneId = resolveBlockZone(block, slideTop);
  const zone = LAYOUT_ZONES.find(z => z.id === zoneId) || LAYOUT_ZONES[0];
  return { x: zone.ax, y: zone.ay };
}

// Nudge (startX, startY) downward in fixed steps, wrapping back to near the
// top, until it's clear of every other block's resolved position — used
// when a new block is created (add / split) so it doesn't land exactly on
// top of an existing one and become unselectable underneath it.
function findFreePosition(blocks, slideTop, startX, startY, excludeId) {
  const taken = blocks.filter(b => b.id !== excludeId).map(b => resolveBlockPosition(b, slideTop));
  const clash = (x, y) => taken.some(p => Math.abs(p.x - x) < 8 && Math.abs(p.y - y) < 8);
  let x = startX, y = startY;
  let guard = 0;
  while (clash(x, y) && guard < 20) {
    y += 15;
    if (y > 94) y = 8 + (guard % 3) * 4;
    guard++;
  }
  return { x, y };
}

function getSelectedBlockId() {
  return selectedBlockId;
}

function getBlockStyle() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  return findBlock(blocks, selectedBlockId).style;
}

function setBlockStyleProp(key, value) {
  const slide = getCurrentSlide();
  if (!slide) return;

  // blockType and textBg affect the slide body/top differently
  if (key === 'blockType') {
    const blocks = parseBodyBlocks(slide.body);
    const block = findBlock(blocks, selectedBlockId);
    block.content = applyBodyBlockType(block.content, value);
    const newBody = serializeBodyBlocks(blocks);
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

  const blocks = parseBodyBlocks(slide.body);
  const block = findBlock(blocks, selectedBlockId);
  block.style = Object.assign({}, block.style, { [key]: value });
  block.explicit = true;
  if (block.id === 1 && (!block.style.zone || block.style.zone === 'center')) {
    const zoneFromLayout = parseLayoutId(slide.top);
    if (zoneFromLayout) block.style.zone = zoneFromLayout;
  }
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Update block style', () => ({ body: newBody }));
  renderCanvas();
  // Same live-preview sync applyLayout's moveBlock command gets — the canvas
  // overlay's own text is fully transparent by design, so without this an
  // unsaved color/font/size/align/weight/style/decoration/box-fill/box-border
  // pick has nothing to show in the real rendered text until the next save.
  sendCanvasCommand('blockStyle', { id: block.id, style: block.style });
}

function getBodyInfo() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, selectedBlockId);
  return {
    blockType: block ? detectBodyBlockType(block.content) : 'p',
    textBg:    slide ? detectTextBg(slide.top) : '',
    hasBg:     slide ? !!parseBg(slide.top) : false
  };
}

// zoneId applies to the given block (defaults to the currently selected one).
// The legacy slide-wide top-matter zone macro is only written for block 1,
// so multi-block slides don't fight over one shared top-matter zone slot.
function applyLayout(zoneId, blockId) {
  const slide = getCurrentSlide();
  if (!slide) return;
  const zone = LAYOUT_ZONES.find(z => z.id === zoneId);
  if (!zone) return;
  const targetId = blockId != null ? blockId : selectedBlockId;

  const blocks = parseBodyBlocks(slide.body);
  const block = findBlock(blocks, targetId);
  // Write x/y alongside the named zone so this block matches the same
  // freeform-position scheme a drag would produce — keeps the two ways of
  // moving a block (grid click vs. drag) consistent instead of leaving some
  // blocks on the old zone-only scheme and others on x/y.
  block.style = Object.assign({}, block.style, { zone: zoneId, x: String(zone.ax), y: String(zone.ay) });
  block.explicit = true;
  const newBody = serializeBodyBlocks(blocks);

  const mutation = { body: newBody };
  if (block.id === 1) {
    let top = stripLayoutMacros(slide.top || '');
    if (zone.macro) top = top ? top + '\n' + zone.macro : zone.macro;
    mutation.top = top;
  }
  selectedBlockId = block.id;
  mutateCurrentSlide('Apply layout', () => mutation);
  renderCanvas();
  // Same live-preview sync a drag gesture gets — without this, the Layout
  // Zone grid was the one way left to move a block where the outline
  // updated instantly but the real rendered text didn't until the next
  // save, since this function (unlike wireBlockEvents' drag handlers)
  // never told the preview iframe anything moved.
  sendCanvasCommand('moveBlock', { id: block.id, x: zone.ax, y: zone.ay });
}

// Freeform drop position from a drag gesture (percent of stage, anchored at
// the block's own center). zoneId is only set when the drop snapped to a
// preset — kept just so the Layout Zone grid can show that button active;
// position itself is always driven by x/y once a block has been dragged.
function setBlockPosition(id, px, py, zoneId) {
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const block = findBlock(blocks, id);
  block.style = Object.assign({}, block.style, {
    x: px.toFixed(2),
    y: py.toFixed(2),
    zone: zoneId || ''
  });
  block.explicit = true;
  const newBody = serializeBodyBlocks(blocks);
  selectedBlockId = block.id;
  mutateCurrentSlide('Move text block', () => ({ body: newBody }));
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

function selectBlock(id) {
  selectedBlockId = id;
  // Toggle the outline class on the existing elements rather than calling
  // renderCanvas() (which rebuilds the whole block layer). A real
  // double-click is two separate clicks in quick succession; if the first
  // click's selection handling replaced the DOM element out from under the
  // pointer, the browser stops recognizing the second click as part of the
  // same double-click, and dblclick never fires. Selecting must stay a
  // pure, no-rebuild DOM update so the element stays put across both clicks.
  if (canvasEl) {
    canvasEl.querySelectorAll('.canvas-text-block').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.blockId === String(id));
    });
  }
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

function addTextBlock() {
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const newId = blocks.reduce((max, b) => Math.max(max, b.id), 0) + 1;
  const pos = findFreePosition(blocks, slide.top, 50, 50, newId);
  blocks.push({
    id: newId,
    style: Object.assign({}, BLOCK_STYLE_DEFAULTS, { zone: '', x: String(pos.x), y: String(pos.y) }),
    explicit: true,
    content: 'New text'
  });
  const newBody = serializeBodyBlocks(blocks);
  selectedBlockId = newId;
  mutateCurrentSlide('Add text block', () => ({ body: newBody }));
  renderCanvas();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

function canDeleteSelectedBlock() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  return blocks.length > 1;
}

function deleteSelectedBlock() {
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  if (blocks.length <= 1) return;
  const remaining = blocks.filter(b => b.id !== selectedBlockId);
  const newBody = serializeBodyBlocks(remaining);
  selectedBlockId = remaining[0].id;
  mutateCurrentSlide('Delete text block', () => ({ body: newBody }));
  renderCanvas();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

function detectBodyBlockType(body) {
  const lines = (body || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^(!|\{\{|<!--|:audio:|:ATTRIB:|:AI:|\+\+|\|\||:[a-zA-Z])/.test(t)) continue;
    if (t.startsWith('###### ')) return 'h6';
    if (t.startsWith('##### ')) return 'h5';
    if (t.startsWith('#### '))  return 'h4';
    if (t.startsWith('### '))   return 'h3';
    if (t.startsWith('## '))    return 'h2';
    if (t.startsWith('# '))     return 'h1';
    if (t.startsWith('- '))     return 'ul';
    if (/^\d+\. /.test(t))     return 'ol';
    if (t.startsWith('> '))    return 'quote';
    if (/^_(?!_)(.+?)(?<!_)_$/.test(t)) return 'ref';
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
    if (!t || /^(!|\{\{|<!--|:audio:|:ATTRIB:|:AI:|\+\+|\|\||:[a-zA-Z])/.test(t)) return line;
    applied = true;
    const content = t
      .replace(/^#{1,6} /, '')
      .replace(/^- /, '')
      .replace(/^\d+\. /, '')
      .replace(/^> /, '')
      .replace(/^_(?!_)(.+?)(?<!_)_$/, '$1');
    if (newType === 'h1') return '# '     + content;
    if (newType === 'h2') return '## '    + content;
    if (newType === 'h3') return '### '   + content;
    if (newType === 'h4') return '#### '  + content;
    if (newType === 'h5') return '##### ' + content;
    if (newType === 'h6') return '###### ' + content;
    if (newType === 'ul') return '- '     + content;
    if (newType === 'ol') return '1. '    + content;
    if (newType === 'quote') return '> '  + content;
    if (newType === 'ref') return '_' + content + '_';
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
    return line.startsWith('- ') || /^#{1,6} /.test(line) || line.startsWith('> ') || /^\d+\. /.test(line);
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
    } else if (line.startsWith('#### ')) {
      content = renderInline(line.slice(5));
      if (content) out += '<div class="canvas-h4">' + content + '</div>';
      i++;
    } else if (line.startsWith('##### ')) {
      content = renderInline(line.slice(6));
      if (content) out += '<div class="canvas-h5">' + content + '</div>';
      i++;
    } else if (line.startsWith('###### ')) {
      content = renderInline(line.slice(7));
      if (content) out += '<div class="canvas-h6">' + content + '</div>';
      i++;
    } else if (line.startsWith('- ')) {
      var items = '';
      while (i < lines.length && lines[i].startsWith('- ')) {
        content = renderInline(lines[i].slice(2));
        if (content) items += '<div class="canvas-li">• ' + content + '</div>';
        i++;
      }
      if (items) out += '<div class="canvas-ul">' + items + '</div>';
    } else if (/^\d+\. /.test(line)) {
      var olItems = '';
      var olNum = 1;
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        content = renderInline(lines[i].replace(/^\d+\. /, ''));
        if (content) olItems += '<div class="canvas-li">' + olNum + '. ' + content + '</div>';
        olNum++;
        i++;
      }
      if (olItems) out += '<div class="canvas-ul">' + olItems + '</div>';
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
    editingBlockId = null;
    exitEditModeUI();
    selectedBlockId = 1;
  }
  lastRenderedSlideKey = slideKey;

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
        '<button class="canvas-act-btn" type="button" data-action="refresh-preview" title="Reload the live preview if it looks out of sync">Refresh Preview</button>' +
        '<button class="canvas-act-btn canvas-add-block-btn" type="button" title="Add a new independently-positioned text block">+ Text Block</button>' +
        '<button class="canvas-act-btn canvas-act-danger canvas-delete-block-btn" type="button" title="Delete the selected text block">Delete Block</button>' +
        '<button class="canvas-act-btn canvas-split-line-btn" type="button" hidden title="Move the line at your cursor into its own independently-positioned box">Split Line Into Box</button>' +
      '</div>' +
      '<div class="canvas-stage-wrap">' +
        '<div class="canvas-stage">' +
          '<div class="canvas-zone-hints" hidden>' + zoneHints + '</div>' +
          '<div class="canvas-center-guide canvas-center-guide-v" hidden></div>' +
          '<div class="canvas-center-guide canvas-center-guide-h" hidden></div>' +
          '<div class="canvas-blocks-layer"></div>' +
          '<div class="canvas-text-editor slide-wysiwyg-editor" contenteditable="true" spellcheck="true" hidden placeholder="Type slide text here…"></div>' +
          '<div class="canvas-drag-hint">Double-click to edit · Drag to reposition</div>' +
        '</div>' +
      '</div>';

    wireStaticEvents(canvasEl);

    // Iframe shows the saved presentation for background reference
    canvasIframeEl = document.createElement('iframe');
    canvasIframeEl.className = 'canvas-iframe';
    canvasIframeEl.sandbox = 'allow-scripts';
    canvasIframeEl.setAttribute('referrerpolicy', 'no-referrer');
    canvasIframeEl.title = 'Slide preview';
    canvasIframeEl.src = buildPreviewUrl();

    const stage = canvasEl.querySelector('.canvas-stage');
    stage.insertBefore(canvasIframeEl, stage.firstChild);

    // Keep the invisible per-block hit-box/selection-outline text sized to
    // match the stage's actual rendered pixel size. (This was previously
    // defined but never called, so the em-based .canvas-h1/h6/etc sizing
    // fell back to the browser default font-size — harmless while the text
    // stayed fully transparent with no visible outline, but it makes the
    // block's real bounding box, and so the drag hit-target and the
    // .is-selected outline, badly mismatch the actual rendered text.)
    updateCanvasScale(stage);
    if (typeof ResizeObserver !== 'undefined') {
      const scaleObserver = new ResizeObserver(() => updateCanvasScale(stage));
      scaleObserver.observe(stage);
    }
  }

  const removeBtn = canvasEl.querySelector('.canvas-act-remove');
  if (removeBtn) removeBtn.hidden = !bg;

  // Skip rebuilding block DOM while a block is actively being edited, so we
  // don't yank the shared editor's anchor out from under an open edit session.
  if (editingBlockId === null) {
    const blocks = parseBodyBlocks(slide.body);
    if (!blocks.some(b => b.id === selectedBlockId)) {
      selectedBlockId = blocks[0].id;
    }
    renderBlocksLayer(blocks, slide.top);

    const deleteBlockBtn = canvasEl.querySelector('.canvas-delete-block-btn');
    if (deleteBlockBtn) deleteBlockBtn.hidden = blocks.length <= 1;
  }

  navigateCanvas();
}

function renderBlocksLayer(blocks, slideTop) {
  const layer = canvasEl.querySelector('.canvas-blocks-layer');
  if (!layer) return;
  layer.innerHTML = '';
  blocks.forEach(block => {
    // Freeform-positioned blocks always borrow the "center" zone's CSS
    // shape (width/text-align) and get their real position from an inline
    // top/left/transform override below — inline styles win over the
    // class's own top:50%/left:50%, so this needs no separate CSS rule.
    const freeform = hasExplicitPosition(block);
    const zoneId = freeform ? 'center' : resolveBlockZone(block, slideTop);
    const el = document.createElement('div');
    el.className = 'canvas-text-block canvas-zone-' + zoneId;
    if (freeform) {
      const pos = resolveBlockPosition(block, slideTop);
      el.style.top = pos.y + '%';
      el.style.left = pos.x + '%';
      el.style.transform = 'translate(-50%, -50%)';
    }
    if (block.id === selectedBlockId) el.classList.add('is-selected');
    el.dataset.blockId = String(block.id);

    const inner = document.createElement('div');
    inner.className = 'canvas-text-inner';
    inner.innerHTML = renderBodyPreview(block.content);
    el.appendChild(inner);

    layer.appendChild(el);
    wireBlockEvents(el, block.id);
  });
}

// Wiring that only ever applies once to the shared, non-repeating parts of
// the canvas: the edit/save button, background/tint/remove-bg buttons, the
// add/delete block buttons, and the shared contenteditable editor's keyboard
// shortcuts. Per-block drag/select/dblclick wiring is in wireBlockEvents,
// which runs once per block every time the block layer is (re)rendered.
function wireStaticEvents(container) {
  const editBtn  = container.querySelector('.canvas-edit-btn');
  const textarea = container.querySelector('.canvas-text-editor');

  container.querySelectorAll('.canvas-act-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'change-bg') {
        document.getElementById('add-top-media-btn')?.click();
      } else if (action === 'change-tint') {
        document.getElementById('add-top-tint-btn')?.click();
      } else if (action === 'remove-bg') {
        removeBg();
      } else if (action === 'refresh-preview') {
        refreshPreviewIframe();
      }
    });
  });

  const addBlockBtn = container.querySelector('.canvas-add-block-btn');
  if (addBlockBtn) {
    addBlockBtn.addEventListener('click', e => {
      e.stopPropagation();
      addTextBlock();
    });
  }

  const deleteBlockBtn = container.querySelector('.canvas-delete-block-btn');
  if (deleteBlockBtn) {
    deleteBlockBtn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSelectedBlock();
    });
  }

  const splitLineBtn = container.querySelector('.canvas-split-line-btn');
  if (splitLineBtn) {
    splitLineBtn.addEventListener('mousedown', e => e.preventDefault());
    splitLineBtn.addEventListener('click', e => {
      e.stopPropagation();
      splitLineIntoNewBlock();
    });
  }

  if (editBtn && textarea) {
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!textarea.hidden) {
        commitEdit(textarea);
      } else {
        enterEditMode(selectedBlockId);
      }
    });

    textarea.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        commitEdit(textarea);
      }
      if (e.key === 'Escape') {
        editingBlockId = null;
        exitEditModeUI();
        renderCanvas();
      }
    });

    // Keynote-style click-away: while a block is being edited, any mousedown
    // outside the editor itself (and outside the two buttons that already
    // handle their own exit) commits the edit, same as clicking Save Text.
    // Without this, clicking anywhere else was simply inert, since every
    // other block's own mousedown handler bails out while textarea is open.
    document.addEventListener('mousedown', e => {
      if (editingBlockId === null) return;
      if (textarea.hidden) return;
      if (textarea.contains(e.target)) return;
      if (editBtn.contains(e.target)) return;
      const splitBtn = canvasEl.querySelector('.canvas-split-line-btn');
      if (splitBtn && splitBtn.contains(e.target)) return;
      commitEdit(textarea);
    });
  }
}

// Per-block drag/select/dblclick wiring. Called once for each block element
// every time renderBlocksLayer (re)builds the block DOM.
function wireBlockEvents(blockEl, blockId) {
  const stage       = canvasEl.querySelector('.canvas-stage');
  const zoneHints   = canvasEl.querySelector('.canvas-zone-hints');
  const guideV      = canvasEl.querySelector('.canvas-center-guide-v');
  const guideH      = canvasEl.querySelector('.canvas-center-guide-h');
  const textarea    = canvasEl.querySelector('.canvas-text-editor');
  const dragHint    = canvasEl.querySelector('.canvas-drag-hint');
  if (!stage || !zoneHints) return;

  let dragging = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let offsetX = 0;
  let offsetY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;

  blockEl.addEventListener('dblclick', e => {
    if (textarea && !textarea.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    selectBlock(blockId);
    enterEditMode(blockId);
  });

  blockEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (textarea && !textarea.hidden) return;

    const stageRect = stage.getBoundingClientRect();
    const blockRect = blockEl.getBoundingClientRect();
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
        blockEl.classList.add('is-dragging');
        LAYOUT_ZONES.forEach(z => blockEl.classList.remove('canvas-zone-' + z.id));
        blockEl.style.position  = 'absolute';
        blockEl.style.left      = (blockRect.left - stageRect.left) + 'px';
        blockEl.style.top       = (blockRect.top  - stageRect.top)  + 'px';
        blockEl.style.transform = 'none';
        blockEl.style.width     = blockRect.width + 'px';
        if (dragHint) dragHint.hidden = true;
      }

      if (!dragging) return;
      const sr = stage.getBoundingClientRect();
      let nl = e.clientX - sr.left - offsetX;
      let nt = e.clientY - sr.top  - offsetY;
      nl = Math.max(0, Math.min(nl, sr.width  - blockEl.offsetWidth));
      nt = Math.max(0, Math.min(nt, sr.height - blockEl.offsetHeight));

      // Snap by the box's center point (matching how the final drop and the
      // compiled output both anchor position), then convert back to the
      // top-left coordinates this drag loop positions the box with — so the
      // outline visibly sticks in place once it crosses a snap threshold,
      // instead of only snapping invisibly at drop time.
      const centerXPct = ((nl + blockEl.offsetWidth  / 2) / sr.width)  * 100;
      const centerYPct = ((nt + blockEl.offsetHeight / 2) / sr.height) * 100;
      const snapped = applyDragSnap(centerXPct, centerYPct);
      nl = (snapped.x / 100) * sr.width  - blockEl.offsetWidth  / 2;
      nt = (snapped.y / 100) * sr.height - blockEl.offsetHeight / 2;

      blockEl.style.left = nl + 'px';
      blockEl.style.top  = nt + 'px';
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      // Freeform placement: no zone-grid overlay during the drag itself —
      // it's not confined to the 9 presets, so showing that grid the whole
      // time reads as "still zone-based." The fine center-line snap gives
      // tactile feedback on its own, and these guide lines make it visible
      // too — each one only appears while that axis is actually snapped.
      if (guideV) guideV.hidden = snapped.x !== 50;
      if (guideH) guideH.hidden = snapped.y !== 50;

      // Mirror the live position into the actual rendered preview so the
      // real text visibly follows the outline during the drag, instead of
      // only catching up once the change is saved to disk — otherwise the
      // two can noticeably disagree (outline shows the new spot, the real
      // text is still wherever it last was saved) until the next save.
      sendCanvasCommand('moveBlock', { id: blockId, x: snapped.x, y: snapped.y });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!dragging) {
        // Plain click, no drag: just select this block.
        selectBlock(blockId);
        return;
      }

      dragging = false;
      blockEl.classList.remove('is-dragging');
      zoneHints.hidden = true;
      if (guideV) guideV.hidden = true;
      if (guideH) guideH.hidden = true;
      if (dragHint) dragHint.hidden = false;

      // Read the box's actual final on-screen center while it's still under
      // the drag's own top/left positioning, before clearing those inline
      // styles snaps it back to whatever its CSS class implies — freeform
      // placement needs where the box visually ended up, not just the
      // cursor's raw coordinate (the two differ by wherever within the box
      // it was originally grabbed).
      const sr = stage.getBoundingClientRect();
      const br = blockEl.getBoundingClientRect();
      let px = ((br.left + br.width  / 2 - sr.left) / sr.width)  * 100;
      let py = ((br.top  + br.height / 2 - sr.top)  / sr.height) * 100;
      px = Math.max(2, Math.min(98, px));
      py = Math.max(2, Math.min(98, py));

      blockEl.style.position  = '';
      blockEl.style.left      = '';
      blockEl.style.top       = '';
      blockEl.style.transform = '';
      blockEl.style.width     = '';

      const snapped = applyDragSnap(px, py);
      setBlockPosition(blockId, snapped.x, snapped.y, snapped.zoneId);
      // Confirm the final (possibly clamped/snapped) position with the
      // preview once more — the live moveBlock stream during the drag
      // should already match, but this guarantees it regardless.
      sendCanvasCommand('moveBlock', { id: blockId, x: snapped.x, y: snapped.y });
      if (typeof _onSelectionChange === 'function') _onSelectionChange();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function enterEditMode(blockId) {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, blockId);
  editingBlockId = block.id;

  const textarea = canvasEl.querySelector('.canvas-text-editor');
  const blockEl  = canvasEl.querySelector('.canvas-text-block[data-block-id="' + block.id + '"]');
  const changeBgBtn   = canvasEl.querySelector('[data-action="change-bg"]');
  const changeTintBtn = canvasEl.querySelector('[data-action="change-tint"]');
  const removeBgBtn   = canvasEl.querySelector('[data-action="remove-bg"]');
  const dragHint       = canvasEl.querySelector('.canvas-drag-hint');
  const editBtn         = canvasEl.querySelector('.canvas-edit-btn');
  const splitLineBtn    = canvasEl.querySelector('.canvas-split-line-btn');

  textarea.innerHTML = bodyToHtml(block.content);
  const freeform = hasExplicitPosition(block);
  const zoneId = freeform ? 'center' : resolveBlockZone(block, slide ? slide.top : '');
  LAYOUT_ZONES.forEach(z => textarea.classList.remove('canvas-zone-' + z.id));
  textarea.classList.add('canvas-zone-' + zoneId);
  if (freeform) {
    const pos = resolveBlockPosition(block, slide ? slide.top : '');
    textarea.style.top = pos.y + '%';
    textarea.style.left = pos.x + '%';
    textarea.style.transform = 'translate(-50%, -50%)';
  } else {
    textarea.style.top = '';
    textarea.style.left = '';
    textarea.style.transform = '';
  }
  textarea.hidden = false;

  // Hide the whole block wrapper, not just its inner text — the textarea
  // overlay stands in for it during editing. Hiding only the inner content
  // left the wrapper's own box in the DOM at zero height (its one child was
  // display:none), which still painted its .is-selected outline: a stray
  // horizontal sliver floating at the block's vertical center with nothing
  // visibly inside it.
  if (blockEl) blockEl.style.display = 'none';
  if (changeBgBtn)   changeBgBtn.hidden   = true;
  if (changeTintBtn) changeTintBtn.hidden = true;
  if (removeBgBtn)   removeBgBtn.hidden   = true;
  if (dragHint) dragHint.hidden = true;
  if (splitLineBtn) splitLineBtn.hidden = false;
  if (editBtn) {
    editBtn.textContent = 'Save Text';
    editBtn.classList.add('is-saving');
  }
  textarea.focus();
  // Tell the live iframe to hide this slide's own text so it doesn't show
  // through/behind the transparent edit overlay while typing.
  sendCanvasCommand('setEditing', { editing: true });
}

function exitEditModeUI() {
  sendCanvasCommand('setEditing', { editing: false });
  if (!canvasEl) return;
  const textarea       = canvasEl.querySelector('.canvas-text-editor');
  const dragHint        = canvasEl.querySelector('.canvas-drag-hint');
  const editBtn          = canvasEl.querySelector('.canvas-edit-btn');
  const changeBgBtn    = canvasEl.querySelector('[data-action="change-bg"]');
  const changeTintBtn  = canvasEl.querySelector('[data-action="change-tint"]');
  const removeBgBtn    = canvasEl.querySelector('[data-action="remove-bg"]');
  const splitLineBtn   = canvasEl.querySelector('.canvas-split-line-btn');
  if (textarea) {
    LAYOUT_ZONES.forEach(z => textarea.classList.remove('canvas-zone-' + z.id));
    textarea.hidden = true;
  }
  if (changeBgBtn)   changeBgBtn.hidden   = false;
  if (changeTintBtn) changeTintBtn.hidden = false;
  const slide = getCurrentSlide();
  if (removeBgBtn) removeBgBtn.hidden = !parseBg(slide ? slide.top : null);
  if (dragHint) dragHint.hidden = false;
  if (splitLineBtn) splitLineBtn.hidden = true;
  if (editBtn)  { editBtn.textContent = 'Edit Text'; editBtn.classList.remove('is-saving'); }
}

function commitEdit(textarea) {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, editingBlockId);
  block.content = htmlToBody(textarea.innerHTML);
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Edit text', () => ({ body: newBody }));
  editingBlockId = null;
  exitEditModeUI();
  renderCanvas();
}

// Move the line/paragraph the cursor is currently in out of the block being
// edited and into its own new, independently-positioned block — the
// explicit, deliberate alternative to auto-splitting every multi-line block
// on load (which would silently restructure every existing multi-heading
// slide the moment it's opened).
function splitLineIntoNewBlock() {
  const textarea = canvasEl.querySelector('.canvas-text-editor');
  if (!textarea || textarea.hidden || editingBlockId === null) return;

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  let node = sel.anchorNode;
  if (!node || !textarea.contains(node)) return;
  // Walk up to the direct child of the editor — the top-level
  // paragraph/heading/list/blockquote/etc. the cursor is inside.
  while (node && node.parentNode !== textarea) node = node.parentNode;
  if (!node || node === textarea) return;

  const temp = document.createElement('div');
  temp.appendChild(node.cloneNode(true));
  const extractedMarkdown = htmlToBody(temp.innerHTML);
  if (!extractedMarkdown.trim()) return;

  node.remove();

  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, editingBlockId);
  block.content = htmlToBody(textarea.innerHTML);

  // Give the split-off block a position no other block on the slide is
  // already using — landing two boxes on the same spot stacks them exactly
  // on top of each other (visually indistinguishable) and, since the
  // topmost one in the DOM swallows every click in the overlap, the box
  // underneath becomes unselectable until the user happens to drag the top
  // one out of the way first. Starts just below the source block and nudges
  // further if that's also taken.
  const sourcePos = resolveBlockPosition(block, slide ? slide.top : '');
  const newPos = findFreePosition(blocks, slide ? slide.top : '', sourcePos.x, Math.min(94, sourcePos.y + 15));
  const newId = blocks.reduce((max, b) => Math.max(max, b.id), 0) + 1;
  blocks.push({
    id: newId,
    style: Object.assign({}, block.style, { zone: '', x: String(newPos.x), y: String(newPos.y) }),
    explicit: true,
    content: extractedMarkdown
  });

  const newBody = serializeBodyBlocks(blocks);
  editingBlockId = null;
  exitEditModeUI();
  selectedBlockId = newId;
  mutateCurrentSlide('Split line into new text block', () => ({ body: newBody }));
  renderCanvas();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

function initCanvasEditor(el, opts) {
  canvasEl = el;
  _host    = opts.host;
  _slug    = opts.slug || '';
  _dir     = opts.dir  || '';
  _mdFile  = opts.mdFile || '';
  _onSelectionChange = opts.onSelectionChange || null;

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

export {
  initCanvasEditor, activateCanvas, deactivateCanvas, isCanvasActive, renderCanvas,
  getBlockStyle, getBodyInfo, setBlockStyleProp, applyLayout, removeBg,
  getSelectedBlockId, addTextBlock, deleteSelectedBlock, canDeleteSelectedBlock
};
