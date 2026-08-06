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
// Can be empty — deselectAll() clears it (e.g. clicking empty canvas
// background) and it stays empty until something is selected again. Every
// single-block reader (getBlockStyle/getResolvedBlockPosition/etc.) still
// operates on the last element as the "primary" block, falling back to
// block 1 via findBlock's own fallback when nothing is selected; every
// *mutator* that depends on a selection guards against the empty case
// instead, so an empty selection is inert rather than silently acting on
// that same block-1 fallback.
let selectedBlockIds = [1];
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

// ── Equal-distance ("Keynote smart guide") snapping ──────────────────────
// Separate from the stage-center/zone snap above: this measures the dragged
// block against the *other* blocks on the slide, and when it settles into
// the spot that makes its gap to the nearest block above equal its gap to
// the nearest block below (or left/right), it snaps into that exact spot
// and lights up a little gauge in each of the two now-equal gaps — the same
// visual Keynote/PowerPoint use to say "this is centered between those two."
const EQUAL_DIST_SNAP_THRESHOLD = 4; // px of slack before the equal-gap snap engages

// Every block on the slide except the one(s) being dragged, as stage-relative
// pixel rects — the same coordinate space `nl`/`nt` are computed in during a
// drag, so the result can be compared/snapped against directly.
function collectOtherBlockRects(excludeEls, stageRect) {
  const exclude = Array.isArray(excludeEls) ? excludeEls : [excludeEls];
  return [...canvasEl.querySelectorAll('.canvas-blocks-layer .canvas-text-block')]
    .filter(el => !exclude.includes(el))
    .map(el => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - stageRect.left, top: r.top - stageRect.top,
        right: r.right - stageRect.left, bottom: r.bottom - stageRect.top
      };
    });
}

// Finds the nearest other block strictly above/below/left/right of `rect`,
// requiring overlap on the perpendicular axis so the relationship reads as
// "stacked" (above/below) or "in-line" (left/right) rather than a random
// diagonal neighbor that just happens to be the closest point.
function findAdjacentBlocks(rect, others) {
  let above = null, below = null, left = null, right = null;
  others.forEach(o => {
    const overlapsX = o.left < rect.right && o.right > rect.left;
    const overlapsY = o.top < rect.bottom && o.bottom > rect.top;
    if (overlapsX) {
      if (o.bottom <= rect.top && (!above || o.bottom > above.bottom)) above = o;
      if (o.top >= rect.bottom && (!below || o.top < below.top)) below = o;
    }
    if (overlapsY) {
      if (o.right <= rect.left && (!left || o.right > left.right)) left = o;
      if (o.left >= rect.right && (!right || o.left < right.left)) right = o;
    }
  });
  return { above, below, left, right };
}

// Given the dragged block's current stage-relative rect and the other
// blocks' rects, checks whether it's within a few px of sitting exactly
// centered between its nearest above/below neighbor (vertically) and/or its
// nearest left/right neighbor (horizontally) — independently per axis, same
// as the stage-center guide. Only fires when *both* opposite neighbors
// exist; a single neighbor has nothing to be "equal" to.
function findEqualDistanceSnap(rect, others) {
  const { above, below, left, right } = findAdjacentBlocks(rect, others);
  const result = { top: rect.top, left: rect.left, showV: false, showH: false, vGap: null, hGap: null };

  if (above && below) {
    const targetTop = above.bottom + (below.top - above.bottom - rect.height) / 2;
    if (Math.abs(rect.top - targetTop) < EQUAL_DIST_SNAP_THRESHOLD) {
      result.top = targetTop;
      result.showV = true;
      const ol = Math.max(rect.left, above.left, below.left);
      const or_ = Math.min(rect.right, above.right, below.right);
      const x = or_ > ol ? (ol + or_) / 2 : (rect.left + rect.right) / 2;
      result.vGap = { aboveBottom: above.bottom, boxTop: targetTop, boxBottom: targetTop + rect.height, belowTop: below.top, x };
    }
  }
  if (left && right) {
    const targetLeft = left.right + (right.left - left.right - rect.width) / 2;
    if (Math.abs(rect.left - targetLeft) < EQUAL_DIST_SNAP_THRESHOLD) {
      result.left = targetLeft;
      result.showH = true;
      const ot = Math.max(rect.top, left.top, right.top);
      const ob = Math.min(rect.bottom, left.bottom, right.bottom);
      const y = ob > ot ? (ot + ob) / 2 : (rect.top + rect.bottom) / 2;
      result.hGap = { leftRight: left.right, boxLeft: targetLeft, boxRight: targetLeft + rect.width, rightLeft: right.left, y };
    }
  }
  return result;
}

// Shows/positions (or hides) the four gauge elements per the result of
// findEqualDistanceSnap — one pair spans the top+bottom gaps (vertical
// centering), the other spans the left+right gaps (horizontal centering).
function updateEqualDistanceGauges(eq) {
  const top    = canvasEl.querySelector('.canvas-eq-gauge-top');
  const bottom = canvasEl.querySelector('.canvas-eq-gauge-bottom');
  const left   = canvasEl.querySelector('.canvas-eq-gauge-left');
  const right  = canvasEl.querySelector('.canvas-eq-gauge-right');

  if (top && bottom) {
    top.hidden = bottom.hidden = !eq.showV;
    if (eq.showV) {
      top.style.left      = eq.vGap.x + 'px';
      top.style.top       = eq.vGap.aboveBottom + 'px';
      top.style.height    = Math.max(0, eq.vGap.boxTop - eq.vGap.aboveBottom) + 'px';
      bottom.style.left   = eq.vGap.x + 'px';
      bottom.style.top    = eq.vGap.boxBottom + 'px';
      bottom.style.height = Math.max(0, eq.vGap.belowTop - eq.vGap.boxBottom) + 'px';
    }
  }
  if (left && right) {
    left.hidden = right.hidden = !eq.showH;
    if (eq.showH) {
      left.style.top     = eq.hGap.y + 'px';
      left.style.left    = eq.hGap.leftRight + 'px';
      left.style.width   = Math.max(0, eq.hGap.boxLeft - eq.hGap.leftRight) + 'px';
      right.style.top    = eq.hGap.y + 'px';
      right.style.left   = eq.hGap.boxRight + 'px';
      right.style.width  = Math.max(0, eq.hGap.rightLeft - eq.hGap.boxRight) + 'px';
    }
  }
}

function hideEqualDistanceGauges() {
  ['.canvas-eq-gauge-top', '.canvas-eq-gauge-bottom', '.canvas-eq-gauge-left', '.canvas-eq-gauge-right']
    .forEach(sel => { const el = canvasEl.querySelector(sel); if (el) el.hidden = true; });
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
  x: '', y: '',
  // Prevents drag/edit/delete in the canvas builder. Editor-only concept —
  // never rendered on the real compiled slide, so no compiler changes needed.
  locked: false,
  // Blocks sharing a non-empty groupId select/drag as one unit. Editor-only,
  // like locked — grouping has no visual effect on the compiled slide.
  groupId: '',
  // Degrees ('' = 0/no rotation) and horizontal/vertical flip. Rendered as
  // part of the same transform that positions a freeform block — see
  // setBlockStyleProp's rotate/flipH/flipV branch, which always promotes a
  // block to freeform (explicit x/y) before writing any of these, so no
  // renderer ever has to compose this on top of an unknown zone transform.
  rotate: '', flipH: false, flipV: false,
  // Explicit size, % of stage (empty = auto/content-sized, both-or-nothing
  // like x/y). Mirrors x/y's unit so one drag/typed-field/compiler pipeline
  // handles both. constrain is editor-only checkbox state (not rendered).
  width: '', height: '', constrain: false
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
    else if (k === 'locked') out.locked = v === '1';
    else if (k === 'group') out.groupId = v;
    else if (k === 'flip-h') out.flipH = v === '1';
    else if (k === 'flip-v') out.flipV = v === '1';
    else if (k === 'constrain') out.constrain = v === '1';
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
  if (style.locked) s += ',locked=1';
  if (style.groupId) s += ',group=' + style.groupId;
  if (style.rotate !== '' && style.rotate != null && parseFloat(style.rotate) !== 0) {
    s += ',rotate=' + style.rotate;
  }
  if (style.flipH) s += ',flip-h=1';
  if (style.flipV) s += ',flip-v=1';
  if (style.width !== '' && style.width != null && style.height !== '' && style.height != null) {
    s += ',width=' + style.width + ',height=' + style.height;
  }
  if (style.constrain) s += ',constrain=1';
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

// All block ids sharing a group (including the one that named it), for
// making a click on any member select/drag the whole group together.
function getGroupMemberIds(blocks, groupId) {
  return blocks.filter(b => b.style.groupId === groupId).map(b => b.id);
}

// Block 1 without its own explicit zone falls back to the legacy slide-wide
// top-matter zone macro (see resolveBlockZone) — but serializeBlockStyleArgs
// always writes an explicit zone= once a block has *any* explicit style.
// Any mutation that gives block 1 its first explicit style (without itself
// setting x/y, which would supersede zone entirely) must carry the
// top-matter zone forward first, or it silently jumps to center the moment
// it becomes explicit.
function preserveBlock1Zone(block, slideTop) {
  if (block.id === 1 && (!block.style.zone || block.style.zone === 'center')) {
    const zoneFromLayout = parseLayoutId(slideTop);
    if (zoneFromLayout) block.style.zone = zoneFromLayout;
  }
}

// True once a block has been dragged or moved via the Layout Zone grid —
// from then on its position is freeform (x/y percentages), not one of the
// 9 preset zones.
function hasExplicitPosition(block) {
  return block.style.x !== '' && block.style.x != null &&
         block.style.y !== '' && block.style.y != null;
}

// True once a block has an explicit stored width/height (via a resize
// handle drag or the Size fields) — until then it's auto-sized to content.
function hasExplicitSize(block) {
  return block.style.width !== '' && block.style.width != null &&
         block.style.height !== '' && block.style.height != null;
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
  return selectedBlockIds[selectedBlockIds.length - 1];
}

function getSelectedBlockIds() {
  return selectedBlockIds.slice();
}

function getBlockStyle() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  return findBlock(blocks, getSelectedBlockId()).style;
}

function setBlockStyleProp(key, value) {
  const slide = getCurrentSlide();
  if (!slide) return;
  // Every branch below acts on the selection except textBg (a slide-wide
  // property, not per-block) — with nothing selected there is no block to
  // apply key/value to, so bail rather than silently falling back to
  // whatever findBlock's own block-1 fallback would resolve to.
  if (key !== 'textBg' && !selectedBlockIds.length) return;

  // blockType and textBg affect the slide body/top differently
  if (key === 'blockType') {
    const blocks = parseBodyBlocks(slide.body);
    const block = findBlock(blocks, getSelectedBlockId());
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

  // Rotate/flip must always promote the block to freeform (explicit x/y)
  // first, so every renderer only ever composes
  // translate(-50%,-50%) rotate(...) scale(...) on top of a *known* base
  // transform — never an unresolved zone-class transform underneath.
  if (key === 'rotate' || key === 'flipH' || key === 'flipV') {
    const blocks = parseBodyBlocks(slide.body);
    const block = findBlock(blocks, getSelectedBlockId());
    const patch = { [key]: value };
    if (!hasExplicitPosition(block)) {
      const pos = resolveBlockPosition(block, slide.top);
      patch.x = pos.x.toFixed(2);
      patch.y = pos.y.toFixed(2);
    }
    block.style = Object.assign({}, block.style, patch);
    block.explicit = true;
    const newBody = serializeBodyBlocks(blocks);
    mutateCurrentSlide('Update block style', () => ({ body: newBody }));
    renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
    return;
  }

  // Every generic Style/Text control funnels through this one path, so a
  // multi-selection applies the change to every selected block at once —
  // blockType/textBg and rotate/flip/size (handled in their own branches
  // above) stay single-target; batch-changing heading levels across
  // dissimilar blocks or rotating/resizing a whole selection as one unit
  // isn't what this path is for.
  const blocks = parseBodyBlocks(slide.body);
  const ids = getSelectedBlockIds();
  ids.forEach(targetId => {
    const block = findBlock(blocks, targetId);
    block.style = Object.assign({}, block.style, { [key]: value });
    block.explicit = true;
    preserveBlock1Zone(block, slide.top);
  });
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Update block style', () => ({ body: newBody }));
  renderCanvas();
  // Same live-preview sync applyLayout's moveBlock command gets — the canvas
  // overlay's own text is fully transparent by design, so without this an
  // unsaved color/font/size/align/weight/style/decoration/box-fill/box-border
  // pick has nothing to show in the real rendered text until the next save.
  ids.forEach(targetId => {
    sendCanvasCommand('blockStyle', { id: targetId, style: findBlock(blocks, targetId).style });
  });
}

function getBodyInfo() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, getSelectedBlockId());
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
  const targetId = blockId != null ? blockId : getSelectedBlockId();
  if (targetId == null) return; // nothing selected and no explicit target

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
  selectedBlockIds = [block.id];
  mutateCurrentSlide('Apply layout', () => mutation);
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
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
  selectedBlockIds = [block.id];
  mutateCurrentSlide('Move text block', () => ({ body: newBody }));
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
}

// Batched position commit for a group-drag or Distribute: several blocks'
// x/y in one parse → mutate-N → serialize → one mutateCurrentSlide call,
// instead of one call per block (which would still collapse into a single
// undo step via the debounce, but this keeps it to one document mutation).
function setBlockPositions(moves) { // moves: [{id, x, y}]
  const slide = getCurrentSlide();
  if (!slide || !moves.length) return;
  const blocks = parseBodyBlocks(slide.body);
  moves.forEach(({ id, x, y }) => {
    const block = findBlock(blocks, id);
    block.style = Object.assign({}, block.style, { x: x.toFixed(2), y: y.toFixed(2), zone: '' });
    block.explicit = true;
  });
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Move blocks', () => ({ body: newBody }));
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
}

// Typed X/Y from the Arrange tab's Position fields. Unlike a drag (which
// snaps to zones/center guides), a hand-typed position is always exact and
// no longer any particular preset, so — like setBlockPosition — it clears
// zone. Both axes commit as one mutation/undo-step.
function setBlockPositionFields(id, x, y) {
  if (id == null) return;
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const block = findBlock(blocks, id);
  block.style = Object.assign({}, block.style, {
    x: String(x),
    y: String(y),
    zone: ''
  });
  block.explicit = true;
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Set block position', () => ({ body: newBody }));
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
}

// Commits a resize (from a corner-handle drag or the typed Width/Height
// fields). x/y are the block's own anchor center, same convention as
// setBlockPosition — a resize always re-derives and writes them too since,
// like rotate/flip, an explicit size only ever makes sense on a freeform
// (explicit x/y) block.
function setBlockSize(id, x, y, width, height) {
  if (id == null) return;
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const block = findBlock(blocks, id);
  block.style = Object.assign({}, block.style, {
    x: x.toFixed(2), y: y.toFixed(2),
    width: width.toFixed(2), height: height.toFixed(2),
    zone: ''
  });
  block.explicit = true;
  const newBody = serializeBodyBlocks(blocks);
  selectedBlockIds = [id];
  mutateCurrentSlide('Resize block', () => ({ body: newBody }));
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
}

// Effective on-stage position for a block, for display in the Arrange tab's
// Position fields — unlike getBlockStyle().x/y (raw, possibly empty), this
// resolves the zone-preset fallback too, so a legacy zone-only block (never
// dragged) still shows a sensible X/Y instead of blank fields.
function getResolvedBlockPosition() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, getSelectedBlockId());
  return resolveBlockPosition(block, slide ? slide.top : '');
}

function getStyleForBlockId(id) {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  return findBlock(blocks, id).style;
}

// Front/Back/Forward/Backward. .revelation-block divs are all position:absolute
// with no explicit z-index, so later-in-DOM wins stacking ties — reordering
// the in-memory blocks array (which serializeBodyBlocks writes out in order)
// is the entire mechanism; no z-index style property is needed.
function reorderBlocks(mutate) {
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  if (!mutate(blocks)) return;
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Reorder blocks', () => ({ body: newBody }));
  renderCanvas();
  // The live-preview iframe only reflects the last-saved file's DOM order
  // and never reorders its own nodes on its own — tell it to restack now so
  // Front/Back is visible immediately, not just after the next Save.
  sendCanvasCommand('reorderBlocks', { ids: blocks.map(b => b.id) });
}

function bringToFront(id) {
  reorderBlocks(blocks => {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx < 0 || idx === blocks.length - 1) return false;
    const [block] = blocks.splice(idx, 1);
    blocks.push(block);
    return true;
  });
}

function sendToBack(id) {
  reorderBlocks(blocks => {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx <= 0) return false;
    const [block] = blocks.splice(idx, 1);
    blocks.unshift(block);
    return true;
  });
}

function bringForward(id) {
  reorderBlocks(blocks => {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx < 0 || idx === blocks.length - 1) return false;
    [blocks[idx], blocks[idx + 1]] = [blocks[idx + 1], blocks[idx]];
    return true;
  });
}

function sendBackward(id) {
  reorderBlocks(blocks => {
    const idx = blocks.findIndex(b => b.id === id);
    if (idx <= 0) return false;
    [blocks[idx], blocks[idx - 1]] = [blocks[idx - 1], blocks[idx]];
    return true;
  });
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

// opts.additive: shift/ctrl/cmd-click — extends or toggles the selection
// instead of replacing it. Clicking any member of a group selects/toggles
// every block sharing its groupId together, so a group always acts as one
// selection unit no matter which member was actually clicked.
function selectBlock(id, opts) {
  const additive = !!(opts && opts.additive);
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const block = findBlock(blocks, id);
  const targetIds = block.style.groupId ? getGroupMemberIds(blocks, block.style.groupId) : [id];

  if (additive) {
    if (targetIds.every(t => selectedBlockIds.includes(t))) {
      // Shift-clicking the only selected block (or group) toggles it off
      // entirely — matches Figma/Illustrator; deselecting is now valid.
      selectedBlockIds = selectedBlockIds.filter(s => !targetIds.includes(s));
    } else {
      selectedBlockIds = Array.from(new Set([...selectedBlockIds, ...targetIds]));
    }
  } else {
    selectedBlockIds = targetIds.slice();
  }

  // Toggle the outline class on the existing elements rather than calling
  // renderCanvas() (which rebuilds the whole block layer). A real
  // double-click is two separate clicks in quick succession; if the first
  // click's selection handling replaced the DOM element out from under the
  // pointer, the browser stops recognizing the second click as part of the
  // same double-click, and dblclick never fires. Selecting must stay a
  // pure, no-rebuild DOM update so the element stays put across both clicks.
  if (canvasEl) {
    canvasEl.querySelectorAll('.canvas-text-block').forEach(el => {
      el.classList.toggle('is-selected', selectedBlockIds.includes(Number(el.dataset.blockId)));
    });
  }
  refreshSelectionOverlay();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

// Reconciles the per-block resize/rotate handles, the group bounding-box
// overlay, and the Delete Block button's visibility to match the current
// selection, without rebuilding any block element itself (see the comment
// above on why: mid-gesture rebuilds break dblclick detection). Handle/bbox
// elements are never a dblclick or drag target for the block itself, so
// removing and re-adding just these is safe — needed because selectBlock's
// own no-rebuild update would otherwise leave stale corner/rotate handles on
// a block that just left a single-selection, leave a new multi-selection's
// group bbox never rendered at all, or leave Delete Block visible/hidden
// based on a stale selection (selection alone never otherwise triggers a
// renderCanvas() call).
function refreshSelectionOverlay() {
  if (!canvasEl) return;
  canvasEl.querySelectorAll('.canvas-resize-handle, .canvas-rotate-handle, .canvas-group-bbox').forEach(el => el.remove());
  const deleteBlockBtn = canvasEl.querySelector('.canvas-delete-block-btn');
  if (deleteBlockBtn) deleteBlockBtn.hidden = !canDeleteSelectedBlock();
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  if (selectedBlockIds.length === 1) {
    const block = findBlock(blocks, selectedBlockIds[0]);
    const el = canvasEl.querySelector('.canvas-text-block[data-block-id="' + selectedBlockIds[0] + '"]');
    if (el && block && !block.style.locked) {
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(corner => renderResizeHandle(el, block.id, corner));
      renderRotateHandle(el, block.id);
    }
  } else if (selectedBlockIds.length > 1 && !selectedBlockIds.some(id => findBlock(blocks, id).style.locked)) {
    renderGroupBBox(selectedBlockIds);
  }
}

// groupId is deterministic (lowest member id) rather than a separate
// counter, so it's unique per group without needing any new persisted
// state. If that specific block is later deleted, the string persists as
// an opaque (still-unique) label on the rest of the group.
function groupBlocks(ids) {
  if (ids.length < 2) return;
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const groupId = String(Math.min(...ids));
  ids.forEach(id => {
    const block = findBlock(blocks, id);
    preserveBlock1Zone(block, slide.top);
    block.style = Object.assign({}, block.style, { groupId });
    block.explicit = true;
  });
  const newBody = serializeBodyBlocks(blocks);
  selectedBlockIds = ids.slice();
  mutateCurrentSlide('Group blocks', () => ({ body: newBody }));
  renderCanvas(); // no sendCanvasCommand — grouping has no rendered effect at all
}

function ungroupSelectedBlocks() {
  if (!selectedBlockIds.length) return;
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const groupId = findBlock(blocks, getSelectedBlockId()).style.groupId;
  if (!groupId) return;
  blocks.forEach(b => { if (b.style.groupId === groupId) b.style.groupId = ''; });
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Ungroup blocks', () => ({ body: newBody }));
  renderCanvas();
}

// Equal-gap distribution along one axis, measured from actual rendered
// boxes (consistent with how drag/snap already treats DOM measurement as
// authoritative for position). The first and last blocks along the axis
// anchor the span and never move; only the middle ones are repositioned.
function distributeBlocks(ids, axis) { // axis: 'h' | 'v'
  const eligible = ids.filter(id => !getStyleForBlockId(id).locked);
  if (eligible.length < 3) return;
  const stage = canvasEl && canvasEl.querySelector('.canvas-stage');
  if (!stage) return;
  const stageRect = stage.getBoundingClientRect();

  const rects = eligible.map(id => {
    const el = canvasEl.querySelector('.canvas-text-block[data-block-id="' + id + '"]');
    const r = el.getBoundingClientRect();
    return { id, left: r.left - stageRect.left, top: r.top - stageRect.top, width: r.width, height: r.height };
  });

  const sorted = rects.slice().sort((a, b) => axis === 'h' ? a.left - b.left : a.top - b.top);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const totalSpan = axis === 'h'
    ? last.left - (first.left + first.width)
    : last.top  - (first.top  + first.height);
  const middleSize = sorted.slice(1, -1).reduce((sum, r) => sum + (axis === 'h' ? r.width : r.height), 0);
  const gap = (totalSpan - middleSize) / (sorted.length - 1);

  const moves = [];
  let cursor = axis === 'h' ? first.left + first.width : first.top + first.height;
  sorted.slice(1, -1).forEach(r => {
    const size = axis === 'h' ? r.width : r.height;
    const centerPx = cursor + gap + size / 2;
    const pct = (centerPx / (axis === 'h' ? stageRect.width : stageRect.height)) * 100;
    const otherPct = axis === 'h'
      ? ((r.top + r.height / 2) / stageRect.height) * 100
      : ((r.left + r.width / 2) / stageRect.width) * 100;
    moves.push(axis === 'h' ? { id: r.id, x: pct, y: otherPct } : { id: r.id, x: otherPct, y: pct });
    cursor = cursor + gap + size;
  });
  setBlockPositions(moves);
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
  selectedBlockIds = [newId];
  mutateCurrentSlide('Add text block', () => ({ body: newBody }));
  renderCanvas();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

function canDeleteSelectedBlock() {
  const slide = getCurrentSlide();
  const blocks = parseBodyBlocks(slide ? slide.body : '');
  const ids = getSelectedBlockIds();
  if (!ids.length) return false; // nothing selected, nothing to delete
  if (blocks.length - ids.length < 1) return false; // must keep >= 1 block
  return !ids.some(id => findBlock(blocks, id).style.locked);
}

function deleteSelectedBlock() {
  const slide = getCurrentSlide();
  if (!slide) return;
  const blocks = parseBodyBlocks(slide.body);
  const ids = getSelectedBlockIds();
  if (!ids.length) return;
  if (blocks.length - ids.length < 1) return;
  if (ids.some(id => findBlock(blocks, id).style.locked)) return; // any-locked blocks the whole batch, matching group-drag's rule
  const remaining = blocks.filter(b => !ids.includes(b.id));
  const newBody = serializeBodyBlocks(remaining);
  selectedBlockIds = [remaining[0].id];
  mutateCurrentSlide('Delete text block' + (ids.length > 1 ? 's' : ''), () => ({ body: newBody }));
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
    selectedBlockIds = [1];
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
          '<div class="canvas-eq-gauge canvas-eq-gauge-v canvas-eq-gauge-top" hidden></div>' +
          '<div class="canvas-eq-gauge canvas-eq-gauge-v canvas-eq-gauge-bottom" hidden></div>' +
          '<div class="canvas-eq-gauge canvas-eq-gauge-h canvas-eq-gauge-left" hidden></div>' +
          '<div class="canvas-eq-gauge canvas-eq-gauge-h canvas-eq-gauge-right" hidden></div>' +
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
    // Drop any selected id(s) that no longer exist (e.g. after undo/redo or
    // a delete elsewhere) rather than resetting the whole selection —
    // preserves the rest of a multi-selection when only one member vanished,
    // and simply leaves an empty selection empty (see deselectAll) rather
    // than forcing a fallback selection the user never chose.
    selectedBlockIds = selectedBlockIds.filter(id => blocks.some(b => b.id === id));
    renderBlocksLayer(blocks, slide.top);
    resyncPreviewBlocks(blocks);

    const deleteBlockBtn = canvasEl.querySelector('.canvas-delete-block-btn');
    if (deleteBlockBtn) deleteBlockBtn.hidden = !canDeleteSelectedBlock();
  }

  navigateCanvas();
}

// Full live-preview resync: sends every explicit block's current style and
// the whole slide's DOM order to the iframe. Called from renderCanvas()
// itself (which fires on *any* document change) rather than only from the
// mutation functions below, because undo/redo goes through the host's own
// undo-manager and never calls setBlockPosition/setBlockStyleProp/etc. at
// all — those functions' own targeted sendCanvasCommand calls give snappier
// per-edit feedback, but only this catch-all guarantees the iframe can't be
// left showing a stale (un-reverted) position/size/rotation after an undo.
// Skips non-explicit blocks (matches serializeBodyBlocks' own convention):
// an untouched block's "style" is just BLOCK_STYLE_DEFAULTS, and forcing
// that onto the iframe would stomp the real theme's own color/font with
// this plugin's placeholder defaults on every single slide.
function resyncPreviewBlocks(blocks) {
  const explicitBlocks = blocks.filter(b => b.explicit);
  if (!explicitBlocks.length) return;
  explicitBlocks.forEach(block => {
    sendCanvasCommand('blockStyle', { id: block.id, style: block.style });
  });
  sendCanvasCommand('reorderBlocks', { ids: blocks.map(b => b.id) });
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
      let transform = 'translate(-50%, -50%)';
      const deg = parseFloat(block.style.rotate);
      if (Number.isFinite(deg) && deg !== 0) transform += ' rotate(' + deg + 'deg)';
      if (block.style.flipH || block.style.flipV) {
        transform += ' scale(' + (block.style.flipH ? -1 : 1) + ', ' + (block.style.flipV ? -1 : 1) + ')';
      }
      el.style.transform = transform;
      if (hasExplicitSize(block)) {
        // max-width:none is required alongside width — the zone class's own
        // max-width cap still applies to an inline width otherwise, so a
        // wider explicit width would silently do nothing without this.
        el.style.width = block.style.width + '%';
        el.style.height = block.style.height + '%';
        el.style.maxWidth = 'none';
      }
    }
    if (selectedBlockIds.includes(block.id)) el.classList.add('is-selected');
    if (block.style.locked) el.classList.add('is-locked');
    el.dataset.blockId = String(block.id);

    const inner = document.createElement('div');
    inner.className = 'canvas-text-inner';
    inner.innerHTML = renderBodyPreview(block.content);
    el.appendChild(inner);

    // Resize + rotate handles only for a single, unlocked selection — a
    // multi-selection gets its own whole-selection bounding-box handles
    // instead (see renderGroupBBox, called once below after this loop).
    if (selectedBlockIds.length === 1 && selectedBlockIds[0] === block.id && !block.style.locked) {
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(corner => renderResizeHandle(el, block.id, corner));
      renderRotateHandle(el, block.id);
    }

    layer.appendChild(el);
    wireBlockEvents(el, block.id);
  });

  if (selectedBlockIds.length > 1 && !selectedBlockIds.some(id => findBlock(blocks, id).style.locked)) {
    renderGroupBBox(selectedBlockIds);
  }
}

const RESIZE_MIN_SIZE = 24; // px — floor for both dimensions during a handle drag

function renderResizeHandle(blockEl, blockId, corner) {
  const handle = document.createElement('div');
  handle.className = 'canvas-resize-handle canvas-resize-' + corner;
  blockEl.appendChild(handle);
  wireResizeHandle(handle, blockId, corner);
}

// Corner-drag resize. Structurally parallel to wireBlockEvents' move-drag:
// mousedown captures a start snapshot, mousemove live-patches inline
// left/top/width/height on the block element, mouseup reads the final
// on-screen rect and commits via setBlockSize. Unlike a typed Width/Height
// edit (which keeps the block's center fixed, see commitSizeFields in
// builder.js), a handle drag keeps the *opposite corner* fixed — standard
// opposite-anchor resize math, one branch per corner.
function wireResizeHandle(handleEl, blockId, corner) {
  handleEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // Critical: without this, the mousedown also bubbles to the parent
    // block's own mousedown handler (wireBlockEvents), which would start a
    // move-drag on the same gesture.
    e.preventDefault();
    e.stopPropagation();

    const stage = canvasEl.querySelector('.canvas-stage');
    const blockEl = handleEl.parentElement;
    if (!stage || !blockEl) return;

    const stageRect = stage.getBoundingClientRect();
    const startRect = blockEl.getBoundingClientRect();
    const startLeft = startRect.left - stageRect.left;
    const startTop = startRect.top - stageRect.top;
    const startWidth = startRect.width;
    const startHeight = startRect.height;
    const startAspect = startWidth / startHeight;
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const constrain = !!getStyleForBlockId(blockId).constrain;
    const baseStyle = getStyleForBlockId(blockId);
    let resizing = false;

    function onMouseMove(e) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      if (!resizing && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) resizing = true;
      if (!resizing) return;

      let newLeft = startLeft, newTop = startTop, newWidth = startWidth, newHeight = startHeight;
      if (corner === 'se') {
        newWidth  = startWidth  + dx;
        newHeight = startHeight + dy;
      } else if (corner === 'sw') {
        newWidth  = startWidth  - dx;
        newHeight = startHeight + dy;
        newLeft   = startLeft   + dx;
      } else if (corner === 'ne') {
        newWidth  = startWidth  + dx;
        newHeight = startHeight - dy;
        newTop    = startTop    + dy;
      } else if (corner === 'nw') {
        newWidth  = startWidth  - dx;
        newHeight = startHeight - dy;
        newLeft   = startLeft   + dx;
        newTop    = startTop    + dy;
      } else if (corner === 'n') {
        newHeight = startHeight - dy;
        newTop    = startTop    + dy;
      } else if (corner === 's') {
        newHeight = startHeight + dy;
      } else if (corner === 'e') {
        newWidth  = startWidth  + dx;
      } else { // w
        newWidth  = startWidth  - dx;
        newLeft   = startLeft   + dx;
      }

      newWidth  = Math.max(RESIZE_MIN_SIZE, newWidth);
      newHeight = Math.max(RESIZE_MIN_SIZE, newHeight);

      // Edge handles (n/s/e/w) are inherently single-axis drags — Constrain
      // only applies to the 4 corners, matching PowerPoint/Keynote/Figma
      // (forcing a proportional change on an orthogonal drag is confusing).
      if (constrain && corner.length === 2) {
        // Whichever axis moved proportionally more drives the other, then
        // left/top are re-derived from the corner's fixed-anchor rule using
        // the now-locked dimensions.
        if (Math.abs(newWidth / startWidth - 1) > Math.abs(newHeight / startHeight - 1)) {
          newHeight = Math.max(RESIZE_MIN_SIZE, newWidth / startAspect);
        } else {
          newWidth = Math.max(RESIZE_MIN_SIZE, newHeight * startAspect);
        }
        if (corner === 'sw' || corner === 'nw') newLeft = startLeft + startWidth  - newWidth;
        if (corner === 'ne' || corner === 'nw') newTop  = startTop  + startHeight - newHeight;
      }

      // Clamp to stage bounds — re-read the stage rect each move for
      // robustness, matching wireBlockEvents' own move-drag.
      const sr = stage.getBoundingClientRect();
      newLeft = Math.max(0, newLeft);
      newTop  = Math.max(0, newTop);
      if (newLeft + newWidth  > sr.width)  newWidth  = sr.width  - newLeft;
      if (newTop  + newHeight > sr.height) newHeight = sr.height - newTop;

      blockEl.style.position  = 'absolute';
      blockEl.style.left      = newLeft + 'px';
      blockEl.style.top       = newTop + 'px';
      blockEl.style.width     = newWidth + 'px';
      blockEl.style.height    = newHeight + 'px';
      blockEl.style.maxWidth  = 'none';
      blockEl.style.transform = 'none';

      // Live-sync the real preview the same way a move-drag streams
      // moveBlock every frame — otherwise the resize is invisible in the
      // iframe until the handle is released.
      const centerXPct = ((newLeft + newWidth  / 2) / sr.width)  * 100;
      const centerYPct = ((newTop  + newHeight / 2) / sr.height) * 100;
      sendCanvasCommand('blockStyle', {
        id: blockId,
        style: Object.assign({}, baseStyle, {
          x: centerXPct.toFixed(2), y: centerYPct.toFixed(2),
          width: ((newWidth / sr.width) * 100).toFixed(2),
          height: ((newHeight / sr.height) * 100).toFixed(2)
        })
      });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!resizing) return; // plain click on the handle, no drag — no-op

      const sr = stage.getBoundingClientRect();
      const br = blockEl.getBoundingClientRect();
      const centerXPct = ((br.left + br.width  / 2 - sr.left) / sr.width)  * 100;
      const centerYPct = ((br.top  + br.height / 2 - sr.top)  / sr.height) * 100;
      const widthPct  = (br.width  / sr.width)  * 100;
      const heightPct = (br.height / sr.height) * 100;

      blockEl.style.position  = '';
      blockEl.style.left      = '';
      blockEl.style.top       = '';
      blockEl.style.width     = '';
      blockEl.style.height    = '';
      blockEl.style.maxWidth  = '';
      blockEl.style.transform = '';

      setBlockSize(blockId, centerXPct, centerYPct, widthPct, heightPct);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Degrees within this threshold of a cardinal angle soft-snap to it —
// mirrors applyDragSnap's no-modifier-needed snap philosophy.
const ROTATE_SNAP_THRESHOLD = 3;

function renderRotateHandle(blockEl, blockId) {
  const handle = document.createElement('div');
  handle.className = 'canvas-rotate-handle';
  blockEl.appendChild(handle);
  wireRotateHandle(handle, blockId);
}

// Drag-to-rotate. The block's rendered center (getBoundingClientRect) stays
// fixed as the pivot for the whole drag regardless of the current rotation —
// rotating a box around its own transform-origin (the CSS default, 50% 50%)
// never moves that center point. Ends by calling the exact same commit path
// Phase 2's numeric angle field already uses.
function wireRotateHandle(handleEl, blockId) {
  handleEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const blockEl = handleEl.parentElement;
    if (!blockEl) return;
    const rect = blockEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const baseStyle = getStyleForBlockId(blockId);
    let rotating = false;
    let finalDeg = parseFloat(baseStyle.rotate) || 0;

    function onMouseMove(e) {
      rotating = true;
      // +90 makes "handle pointing straight up" read as 0°, matching the
      // handle's rendered position at the block's top-center.
      let angle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180 / Math.PI + 90;
      angle = ((angle % 360) + 360) % 360;
      [0, 90, 180, 270, 360].forEach(snap => {
        if (Math.abs(angle - snap) < ROTATE_SNAP_THRESHOLD) angle = snap % 360;
      });
      finalDeg = Math.round(angle);

      let transform = 'translate(-50%, -50%) rotate(' + finalDeg + 'deg)';
      if (baseStyle.flipH || baseStyle.flipV) {
        transform += ' scale(' + (baseStyle.flipH ? -1 : 1) + ', ' + (baseStyle.flipV ? -1 : 1) + ')';
      }
      blockEl.style.transform = transform;
      // Live-sync the preview, same technique as wireResizeHandle. Skip
      // live-updating the Arrange tab's numeric field during the drag (the
      // resize handles don't bother either) — syncInspector() picks up the
      // final value once the drag commits below.
      sendCanvasCommand('blockStyle', {
        id: blockId,
        style: Object.assign({}, baseStyle, { rotate: String(finalDeg) })
      });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!rotating) return; // plain click on the handle, no drag — no-op
      setBlockStyleProp('rotate', String(finalDeg));
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Whole-selection bounding-box resize overlay — rendered once (not per
// block) after the main per-block loop, whenever 2+ unlocked blocks are
// selected (an ad hoc multi-selection or a real Group, treated identically).
// Reuses the existing corner-handle CSS class, just on a different parent.
function renderGroupBBox(selectedIds) {
  const layer = canvasEl.querySelector('.canvas-blocks-layer');
  const stage = canvasEl.querySelector('.canvas-stage');
  if (!layer || !stage) return;
  const stageRect = stage.getBoundingClientRect();
  const rects = selectedIds
    .map(id => layer.querySelector('.canvas-text-block[data-block-id="' + id + '"]'))
    .filter(Boolean)
    .map(el => el.getBoundingClientRect());
  if (rects.length < 2) return;

  const left = Math.min(...rects.map(r => r.left)) - stageRect.left;
  const top = Math.min(...rects.map(r => r.top)) - stageRect.top;
  const right = Math.max(...rects.map(r => r.right)) - stageRect.left;
  const bottom = Math.max(...rects.map(r => r.bottom)) - stageRect.top;

  const bbox = document.createElement('div');
  bbox.className = 'canvas-group-bbox';
  bbox.style.left = left + 'px';
  bbox.style.top = top + 'px';
  bbox.style.width = (right - left) + 'px';
  bbox.style.height = (bottom - top) + 'px';
  layer.appendChild(bbox);

  ['nw', 'ne', 'sw', 'se'].forEach(corner => {
    const handle = document.createElement('div');
    handle.className = 'canvas-resize-handle canvas-resize-' + corner;
    bbox.appendChild(handle);
    wireGroupResizeHandle(handle, selectedIds, corner);
  });
}

// Group bounding-box resize. Structurally parallel to wireResizeHandle's
// opposite-anchor corner math, but applied to the union bbox and then
// uniformly (never non-uniform — a per-drag free/proportional toggle wasn't
// asked for, and skewing a multi-block layout reads as broken far more
// often than intentional) to every member's own rect around that same
// anchor point.
function wireGroupResizeHandle(handleEl, ids, corner) {
  handleEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const stage = canvasEl.querySelector('.canvas-stage');
    const layer = canvasEl.querySelector('.canvas-blocks-layer');
    const bboxEl = handleEl.parentElement;
    if (!stage || !layer || !bboxEl) return;
    const stageRect = stage.getBoundingClientRect();

    const members = ids.map(id => {
      const el = layer.querySelector('.canvas-text-block[data-block-id="' + id + '"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id, el, left: r.left - stageRect.left, top: r.top - stageRect.top, width: r.width, height: r.height };
    }).filter(Boolean);
    if (members.length < 2) return;

    const groupLeft = Math.min(...members.map(m => m.left));
    const groupTop = Math.min(...members.map(m => m.top));
    const groupRight = Math.max(...members.map(m => m.left + m.width));
    const groupBottom = Math.max(...members.map(m => m.top + m.height));
    const groupWidth = groupRight - groupLeft;
    const groupHeight = groupBottom - groupTop;

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    let resizing = false;

    function onMouseMove(e) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      if (!resizing && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) resizing = true;
      if (!resizing) return;

      let newWidth = groupWidth, newHeight = groupHeight;
      if (corner === 'se') { newWidth = groupWidth + dx; newHeight = groupHeight + dy; }
      else if (corner === 'sw') { newWidth = groupWidth - dx; newHeight = groupHeight + dy; }
      else if (corner === 'ne') { newWidth = groupWidth + dx; newHeight = groupHeight - dy; }
      else { newWidth = groupWidth - dx; newHeight = groupHeight - dy; } // nw

      newWidth  = Math.max(RESIZE_MIN_SIZE, newWidth);
      newHeight = Math.max(RESIZE_MIN_SIZE, newHeight);
      // Always uniform: whichever axis moved proportionally more drives the
      // other, same rule single-block corner-resize uses when constrain is on.
      const scaleX = newWidth / groupWidth;
      const scaleY = newHeight / groupHeight;
      const scale = Math.abs(scaleX - 1) > Math.abs(scaleY - 1) ? scaleX : scaleY;

      const anchorX = (corner === 'sw' || corner === 'nw') ? groupRight : groupLeft;
      const anchorY = (corner === 'ne' || corner === 'nw') ? groupBottom : groupTop;

      bboxEl.style.left   = (anchorX + (groupLeft - anchorX) * scale) + 'px';
      bboxEl.style.top    = (anchorY + (groupTop  - anchorY) * scale) + 'px';
      bboxEl.style.width  = (groupWidth  * scale) + 'px';
      bboxEl.style.height = (groupHeight * scale) + 'px';

      const sr = stage.getBoundingClientRect();
      members.forEach(m => {
        const ml = anchorX + (m.left - anchorX) * scale;
        const mt = anchorY + (m.top  - anchorY) * scale;
        const mw = m.width  * scale;
        const mh = m.height * scale;
        m.el.style.position  = 'absolute';
        m.el.style.left      = ml + 'px';
        m.el.style.top       = mt + 'px';
        m.el.style.width     = mw + 'px';
        m.el.style.height    = mh + 'px';
        m.el.style.maxWidth  = 'none';
        m.el.style.transform = 'none';

        const baseStyle = getStyleForBlockId(m.id);
        sendCanvasCommand('blockStyle', {
          id: m.id,
          style: Object.assign({}, baseStyle, {
            x: (((ml + mw / 2) / sr.width)  * 100).toFixed(2),
            y: (((mt + mh / 2) / sr.height) * 100).toFixed(2),
            width:  ((mw / sr.width)  * 100).toFixed(2),
            height: ((mh / sr.height) * 100).toFixed(2)
          })
        });
      });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!resizing) return; // plain click on the handle, no drag — no-op

      const sr = stage.getBoundingClientRect();
      const entries = members.map(m => {
        const r = m.el.getBoundingClientRect();
        const entry = {
          id: m.id,
          x: ((r.left + r.width  / 2 - sr.left) / sr.width)  * 100,
          y: ((r.top  + r.height / 2 - sr.top)  / sr.height) * 100,
          width:  (r.width  / sr.width)  * 100,
          height: (r.height / sr.height) * 100
        };
        m.el.style.position  = '';
        m.el.style.left      = '';
        m.el.style.top       = '';
        m.el.style.width     = '';
        m.el.style.height    = '';
        m.el.style.maxWidth  = '';
        m.el.style.transform = '';
        return entry;
      });
      setBlockPositionsAndSizes(entries);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// Batched position+size commit for a group-resize — mirrors setBlockPositions'
// batching shape, extended to also carry size, since setBlockSize only ever
// handles one block at a time.
function setBlockPositionsAndSizes(entries) { // [{id, x, y, width, height}]
  const slide = getCurrentSlide();
  if (!slide || !entries.length) return;
  const blocks = parseBodyBlocks(slide.body);
  entries.forEach(({ id, x, y, width, height }) => {
    const block = findBlock(blocks, id);
    block.style = Object.assign({}, block.style, {
      x: x.toFixed(2), y: y.toFixed(2), width: width.toFixed(2), height: height.toFixed(2), zone: ''
    });
    block.explicit = true;
  });
  const newBody = serializeBodyBlocks(blocks);
  mutateCurrentSlide('Resize blocks', () => ({ body: newBody }));
  renderCanvas(); // resyncs the live preview itself — see resyncPreviewBlocks
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
        enterEditMode(getSelectedBlockId());
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

  wireMarqueeSelect(container);
}

// Clears the selection entirely — e.g. a plain click on empty canvas
// background. selectedBlockIds is allowed to be empty (see its
// declaration); every mutator that depends on a selection guards against
// this instead of assuming a fallback block.
function deselectAll() {
  if (!selectedBlockIds.length) return;
  selectedBlockIds = [];
  if (canvasEl) {
    canvasEl.querySelectorAll('.canvas-text-block.is-selected').forEach(el => el.classList.remove('is-selected'));
  }
  refreshSelectionOverlay();
  if (typeof _onSelectionChange === 'function') _onSelectionChange();
}

// Rubber-band selection: mousedown on the empty canvas background (not on
// any block) drags out a rectangle; every block it overlaps becomes the new
// selection on mouseup. A plain click-with-no-drag deselects everything
// instead (unless a modifier is held — shift/ctrl-clicking empty
// background has nothing to add/toggle, so it stays a no-op rather than
// wiping an existing selection the user may still want).
function wireMarqueeSelect(container) {
  const layer = container.querySelector('.canvas-blocks-layer');
  if (!layer) return;

  layer.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target !== layer) return; // bail if the mousedown landed on a block, not the empty background
    const stage = container.querySelector('.canvas-stage');
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    let marqueeEl = null;

    function onMouseMove(e) {
      const x1 = Math.min(startX, e.clientX), x2 = Math.max(startX, e.clientX);
      const y1 = Math.min(startY, e.clientY), y2 = Math.max(startY, e.clientY);
      if (!marqueeEl && (x2 - x1 > 4 || y2 - y1 > 4)) {
        marqueeEl = document.createElement('div');
        marqueeEl.className = 'canvas-marquee';
        layer.appendChild(marqueeEl);
      }
      if (!marqueeEl) return;
      marqueeEl.style.left = (x1 - stageRect.left) + 'px';
      marqueeEl.style.top = (y1 - stageRect.top) + 'px';
      marqueeEl.style.width = (x2 - x1) + 'px';
      marqueeEl.style.height = (y2 - y1) + 'px';
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!marqueeEl) { if (!additive) deselectAll(); return; } // plain click on background, no drag
      const mRect = marqueeEl.getBoundingClientRect();
      marqueeEl.remove();
      // Any-overlap hit test (not full containment) — more forgiving, matches
      // Illustrator's default marquee behavior. Locked blocks are included:
      // they're already selectable via a plain click, so marquee shouldn't
      // treat them differently.
      const hitIds = [...layer.querySelectorAll('.canvas-text-block')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.left < mRect.right && r.right > mRect.left && r.top < mRect.bottom && r.bottom > mRect.top;
        })
        .map(el => Number(el.dataset.blockId));
      if (!hitIds.length) return; // never replace selection with an empty result
      if (additive) {
        hitIds.forEach(id => selectBlock(id, { additive: true }));
      } else {
        selectedBlockIds = hitIds;
        if (canvasEl) {
          canvasEl.querySelectorAll('.canvas-text-block').forEach(el => {
            el.classList.toggle('is-selected', selectedBlockIds.includes(Number(el.dataset.blockId)));
          });
        }
        refreshSelectionOverlay();
        if (typeof _onSelectionChange === 'function') _onSelectionChange();
      }
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
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
    if (getStyleForBlockId(blockId).locked) return;
    enterEditMode(blockId);
  });

  blockEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (textarea && !textarea.hidden) return;

    // Selection is resolved here, before the drag threshold, so a group-drag
    // (see below) knows its full member set from the very first mousemove.
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      selectBlock(blockId, { additive: true });
    } else if (!selectedBlockIds.includes(blockId)) {
      selectBlock(blockId);
    }
    // else: blockId is already part of an active multi-selection and this is
    // a plain click on one of its members — leave the selection untouched so
    // dragging it moves the whole set instead of collapsing to just this one.
    const dragIds = selectedBlockIds.slice();

    const locked = dragIds.some(id => getStyleForBlockId(id).locked);
    const stageRect = stage.getBoundingClientRect();
    const blockRect = blockEl.getBoundingClientRect();
    offsetX = e.clientX - blockRect.left;
    offsetY = e.clientY - blockRect.top;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    dragging = false;

    // Group-drag snapshot: every dragged member's element + starting
    // stage-relative rect, plus the whole set's combined bounding box — used
    // only when dragIds.length > 1. Only meaningful once dragging actually
    // starts, but cheap enough to always capture up front.
    const memberStarts = dragIds
      .map(id => id === blockId ? blockEl : canvasEl.querySelector('.canvas-text-block[data-block-id="' + id + '"]'))
      .filter(Boolean)
      .map(el => {
        const r = el.getBoundingClientRect();
        return { el, id: Number(el.dataset.blockId), left: r.left - stageRect.left, top: r.top - stageRect.top, width: r.width, height: r.height };
      });
    const groupBounds = memberStarts.reduce((acc, m) => ({
      left: Math.min(acc.left, m.left), top: Math.min(acc.top, m.top),
      right: Math.max(acc.right, m.left + m.width), bottom: Math.max(acc.bottom, m.top + m.height)
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });

    function onMouseMove(e) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;

      if (!dragging && !locked && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        dragging = true;
        if (dragIds.length > 1) {
          memberStarts.forEach(m => {
            m.el.classList.add('is-dragging');
            LAYOUT_ZONES.forEach(z => m.el.classList.remove('canvas-zone-' + z.id));
            m.el.style.position  = 'absolute';
            m.el.style.left      = m.left + 'px';
            m.el.style.top       = m.top + 'px';
            m.el.style.transform = 'none';
            m.el.style.width     = m.width + 'px';
          });
        } else {
          blockEl.classList.add('is-dragging');
          LAYOUT_ZONES.forEach(z => blockEl.classList.remove('canvas-zone-' + z.id));
          blockEl.style.position  = 'absolute';
          blockEl.style.left      = (blockRect.left - stageRect.left) + 'px';
          blockEl.style.top       = (blockRect.top  - stageRect.top)  + 'px';
          blockEl.style.transform = 'none';
          blockEl.style.width     = blockRect.width + 'px';
        }
        if (dragHint) dragHint.hidden = true;
      }

      if (!dragging) return;
      const sr = stage.getBoundingClientRect();

      if (dragIds.length > 1) {
        // Snap keyed to the block the user is actually holding (not an
        // averaged group point, which would fight the cursor), then apply
        // that one shared delta to every member.
        const held = memberStarts.find(m => m.id === blockId);
        let nl = e.clientX - sr.left - offsetX;
        let nt = e.clientY - sr.top  - offsetY;
        const heldCenterXPct = ((nl + held.width  / 2) / sr.width)  * 100;
        const heldCenterYPct = ((nt + held.height / 2) / sr.height) * 100;
        const snapped = applyDragSnap(heldCenterXPct, heldCenterYPct);
        const snappedLeft = (snapped.x / 100) * sr.width  - held.width  / 2;
        const snappedTop  = (snapped.y / 100) * sr.height - held.height / 2;
        let deltaX = snappedLeft - held.left;
        let deltaY = snappedTop  - held.top;

        // Clamp the delta against the group's *combined* bounding box, not
        // each member independently — independent clamping would let
        // members drift apart from each other once any one hits an edge.
        deltaX = Math.max(-groupBounds.left, Math.min(deltaX, sr.width  - groupBounds.right));
        deltaY = Math.max(-groupBounds.top,  Math.min(deltaY, sr.height - groupBounds.bottom));

        // Equal-distance guide, keyed to the same held member as the snap
        // above: measured against every block *not* in this drag (all group
        // members excluded, not just the held one), after the group's shared
        // delta so the gauge tracks the held block's actual on-screen spot.
        const heldRect = {
          left: held.left + deltaX, top: held.top + deltaY,
          right: held.left + deltaX + held.width, bottom: held.top + deltaY + held.height,
          width: held.width, height: held.height
        };
        const otherRects = collectOtherBlockRects(memberStarts.map(m => m.el), sr);
        const eq = findEqualDistanceSnap(heldRect, otherRects);
        deltaX += eq.left - heldRect.left;
        deltaY += eq.top  - heldRect.top;

        memberStarts.forEach(m => {
          m.el.style.left = (m.left + deltaX) + 'px';
          m.el.style.top  = (m.top  + deltaY) + 'px';
          sendCanvasCommand('moveBlock', {
            id: m.id,
            x: ((m.left + deltaX + m.width  / 2) / sr.width)  * 100,
            y: ((m.top  + deltaY + m.height / 2) / sr.height) * 100
          });
        });
        if (guideV) guideV.hidden = snapped.x !== 50;
        if (guideH) guideH.hidden = snapped.y !== 50;
        updateEqualDistanceGauges(eq);
        return;
      }

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

      // Equal-distance guide: if this puts the box within a few px of
      // sitting exactly centered between its nearest neighbor above/below
      // (or left/right), snap the rest of the way there and light up the
      // gauge in each now-equal gap. Layered on top of the stage-center/zone
      // snap above rather than a replacement for it — the two rarely
      // disagree since equal-distance targets are almost never also a zone
      // anchor.
      const otherRects = collectOtherBlockRects(blockEl, sr);
      const eq = findEqualDistanceSnap(
        { left: nl, top: nt, right: nl + blockEl.offsetWidth, bottom: nt + blockEl.offsetHeight,
          width: blockEl.offsetWidth, height: blockEl.offsetHeight },
        otherRects
      );
      nl = eq.left;
      nt = eq.top;

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
      updateEqualDistanceGauges(eq);

      // Mirror the live position into the actual rendered preview so the
      // real text visibly follows the outline during the drag, instead of
      // only catching up once the change is saved to disk — otherwise the
      // two can noticeably disagree (outline shows the new spot, the real
      // text is still wherever it last was saved) until the next save.
      // Recomputed from nl/nt rather than reusing snapped.x/y since the
      // equal-distance snap above may have nudged the box further.
      const finalXPct = ((nl + blockEl.offsetWidth  / 2) / sr.width)  * 100;
      const finalYPct = ((nt + blockEl.offsetHeight / 2) / sr.height) * 100;
      sendCanvasCommand('moveBlock', { id: blockId, x: finalXPct, y: finalYPct });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!dragging) {
        // Plain click, no drag: selection was already resolved at mousedown.
        return;
      }

      dragging = false;
      zoneHints.hidden = true;
      if (guideV) guideV.hidden = true;
      if (guideH) guideH.hidden = true;
      hideEqualDistanceGauges();
      if (dragHint) dragHint.hidden = false;

      if (dragIds.length > 1) {
        const sr = stage.getBoundingClientRect();
        const moves = memberStarts.map(m => {
          const r = m.el.getBoundingClientRect();
          let px = ((r.left + r.width  / 2 - sr.left) / sr.width)  * 100;
          let py = ((r.top  + r.height / 2 - sr.top)  / sr.height) * 100;
          px = Math.max(2, Math.min(98, px));
          py = Math.max(2, Math.min(98, py));
          m.el.classList.remove('is-dragging');
          m.el.style.position  = '';
          m.el.style.left      = '';
          m.el.style.top       = '';
          m.el.style.transform = '';
          m.el.style.width     = '';
          return { id: m.id, x: px, y: py };
        });
        setBlockPositions(moves);
        if (typeof _onSelectionChange === 'function') _onSelectionChange();
        return;
      }

      blockEl.classList.remove('is-dragging');

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
      // setBlockPosition sends its own confirming blockStyle command to the
      // preview (a superset of moveBlock — see its comment) — no separate
      // moveBlock call needed here, and one would be actively harmful: sent
      // after blockStyle, its handler would wipe the transform/size that
      // blockStyle just restored.
      setBlockPosition(blockId, snapped.x, snapped.y, snapped.zoneId);
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
    // Everything else about the source block's style carries over (color,
    // font, box fill, etc. — matches the source line's own formatting), but
    // groupId/rotate/flip/size must not: the split-off box is new,
    // independent content that shouldn't silently inherit the source's
    // group membership, orientation, or explicit dimensions.
    style: Object.assign({}, block.style, {
      zone: '', x: String(newPos.x), y: String(newPos.y),
      groupId: '', rotate: '', flipH: false, flipV: false,
      width: '', height: ''
    }),
    explicit: true,
    content: extractedMarkdown
  });

  const newBody = serializeBodyBlocks(blocks);
  editingBlockId = null;
  exitEditModeUI();
  selectedBlockIds = [newId];
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
  getSelectedBlockId, getSelectedBlockIds, addTextBlock, deleteSelectedBlock, canDeleteSelectedBlock,
  setBlockPositionFields, getResolvedBlockPosition, getStyleForBlockId,
  bringToFront, sendToBack, bringForward, sendBackward,
  groupBlocks, ungroupSelectedBlocks, distributeBlocks, setBlockSize
};
