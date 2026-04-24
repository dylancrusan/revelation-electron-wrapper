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

  // Color — simple color input picker for now
  const colorBtn  = document.getElementById('insp-color-btn');
  const colorMenu = document.getElementById('insp-color-menu');
  if (colorBtn && colorMenu) {
    colorBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Build a simple hex input if menu is empty
      if (!colorMenu.querySelector('.cbp-color-input')) {
        colorMenu.innerHTML = '';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 2px;';
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'cbp-color-input';
        input.style.cssText = 'width:40px;height:28px;border:1px solid #303545;background:#10131a;padding:0;border-radius:4px;cursor:pointer;flex-shrink:0;';
        input.value = getBlockStyle().color || '#ffffff';
        input.addEventListener('input', () => {
          setBlockStyleProp('color', input.value);
          const swatch = colorBtn.querySelector('.insp-color-swatch');
          if (swatch) swatch.style.background = input.value;
        });
        row.appendChild(input);
        colorMenu.appendChild(row);
      } else {
        colorMenu.querySelector('.cbp-color-input').value = getBlockStyle().color || '#ffffff';
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

  return [];
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
