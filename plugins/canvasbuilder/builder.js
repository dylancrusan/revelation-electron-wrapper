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
  getBodyInfo,
  getSelectedBlockId,
  getSelectedBlockIds,
  getStyleForBlockId,
  setBlockPositionFields,
  getResolvedBlockPosition,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  groupBlocks,
  ungroupSelectedBlocks,
  distributeBlocks,
  setBlockSize,
  attachSmartDashes
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

  // Shared state for context-aware inspector color picker and list buttons
  let _notesSelRange          = null;
  let _canvasTextSelRange     = null;
  let _bulletSelRange         = null;
  let _numberSelRange         = null;
  let _syncNotes              = null;
  let _loadNotesFromMarkdown  = null;

  // ── Canvas panel ───────────────────────────────────────────────────────────
  const canvasPanel = document.getElementById('canvas-editor-panel');
  if (!canvasPanel) return [];

  initCanvasEditor(canvasPanel, { host, slug, dir, mdFile, onSelectionChange: () => syncInspector() });

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

    // Arrange tab — lock state gates Order/Position (Order/Position/Lock stay
    // primary-block-only during a multi-selection, matching Style/Text tab
    // controls — not part of the multi-select ask). hasSelection additionally
    // gates all of these off entirely once nothing is selected (see
    // deselectAll in canvas-editor.js) — style/pos/etc. still read as
    // whatever block 1 happens to be (findBlock's own fallback), but every
    // control that would act on "the selection" is disabled rather than
    // silently acting on that fallback block.
    const locked = !!style.locked;
    const ids = getSelectedBlockIds();
    const isMulti = ids.length > 1;
    const hasSelection = ids.length > 0;
    const lockBtn   = document.getElementById('insp-lock-btn');
    const unlockBtn = document.getElementById('insp-unlock-btn');
    if (lockBtn)   lockBtn.disabled   = locked || !hasSelection;
    if (unlockBtn) unlockBtn.disabled = !locked || !hasSelection;
    ['insp-order-front-btn', 'insp-order-back-btn', 'insp-order-forward-btn', 'insp-order-backward-btn']
      .forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = locked || !hasSelection;
      });

    // Position — shown as percent of stage width/height (the block's own
    // underlying storage unit; see getResolvedBlockPosition in canvas-editor.js)
    const posX = document.getElementById('insp-pos-x');
    const posY = document.getElementById('insp-pos-y');
    const pos = getResolvedBlockPosition();
    if (posX && document.activeElement !== posX) { posX.value = Math.round(pos.x * 10) / 10; posX.disabled = locked || !hasSelection; }
    if (posY && document.activeElement !== posY) { posY.value = Math.round(pos.y * 10) / 10; posY.disabled = locked || !hasSelection; }

    // Rotate / Flip — single-select + unlocked only (no batch-rotate across
    // a multi-selection in this phase).
    const rotateDisabled = isMulti || locked || !hasSelection;
    const rotateInput = document.getElementById('insp-rotate-angle');
    const flipHBtn = document.getElementById('insp-flip-h-btn');
    const flipVBtn = document.getElementById('insp-flip-v-btn');
    if (rotateInput && document.activeElement !== rotateInput) {
      rotateInput.value = style.rotate || 0;
      rotateInput.disabled = rotateDisabled;
    }
    if (flipHBtn) { flipHBtn.disabled = rotateDisabled; flipHBtn.classList.toggle('is-active', !!style.flipH); }
    if (flipVBtn) { flipVBtn.disabled = rotateDisabled; flipVBtn.classList.toggle('is-active', !!style.flipV); }

    // Size — single-select + unlocked only, same gating as Rotate (no
    // whole-selection bounding-box resize in this phase).
    const sizeDisabled = isMulti || locked || !hasSelection;
    const sizeWidthInput = document.getElementById('insp-size-width');
    const sizeHeightInput = document.getElementById('insp-size-height');
    const sizeConstrainCheckbox = document.getElementById('insp-size-constrain');
    if (sizeWidthInput && document.activeElement !== sizeWidthInput) {
      sizeWidthInput.value = style.width === '' ? '' : Math.round(parseFloat(style.width) * 10) / 10;
      sizeWidthInput.disabled = sizeDisabled;
    }
    if (sizeHeightInput && document.activeElement !== sizeHeightInput) {
      sizeHeightInput.value = style.height === '' ? '' : Math.round(parseFloat(style.height) * 10) / 10;
      sizeHeightInput.disabled = sizeDisabled;
    }
    if (sizeConstrainCheckbox) {
      sizeConstrainCheckbox.checked = !!style.constrain;
      sizeConstrainCheckbox.disabled = sizeDisabled;
    }

    // Group / Ungroup — Group needs 2+ selected; Ungroup needs the primary
    // block to currently be in a group.
    const groupBtn   = document.getElementById('insp-group-btn');
    const ungroupBtn = document.getElementById('insp-ungroup-btn');
    if (groupBtn)   groupBtn.disabled   = ids.length < 2;
    if (ungroupBtn) ungroupBtn.disabled = !style.groupId || !hasSelection;

    // Distribute — needs 3+ selected, none locked.
    const distributeEligible = ids.length >= 3 && !ids.some(id => getStyleForBlockId(id).locked);
    const distributeDropdownBtn = document.getElementById('insp-distribute-dropdown-btn');
    const distributeHBtn = document.getElementById('insp-distribute-h-btn');
    const distributeVBtn = document.getElementById('insp-distribute-v-btn');
    if (distributeDropdownBtn) distributeDropdownBtn.disabled = !distributeEligible;
    if (distributeHBtn) distributeHBtn.disabled = !distributeEligible;
    if (distributeVBtn) distributeVBtn.disabled = !distributeEligible;
  }

  // Tabs
  document.querySelectorAll('#insp-tabs .insp-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#insp-tabs .insp-tab-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.insp-tab-panel').forEach(panel => {
        panel.classList.toggle('is-active', panel.dataset.tabPanel === btn.dataset.tab);
      });
    });
  });

  // Align / Distribute dropdowns
  const closeAlignMenu = _wireDropdown(document.getElementById('insp-align-dropdown-btn'), document.getElementById('insp-align-menu'));
  const closeDistributeMenu = _wireDropdown(document.getElementById('insp-distribute-dropdown-btn'), document.getElementById('insp-distribute-menu'));

  // Distribute — reads the current selection at click time (the menu can
  // stay open across selection changes in principle, so don't capture ids
  // when the dropdown opens).
  const distributeHBtn = document.getElementById('insp-distribute-h-btn');
  const distributeVBtn = document.getElementById('insp-distribute-v-btn');
  if (distributeHBtn) distributeHBtn.addEventListener('click', () => { distributeBlocks(getSelectedBlockIds(), 'h'); closeDistributeMenu(); syncInspector(); });
  if (distributeVBtn) distributeVBtn.addEventListener('click', () => { distributeBlocks(getSelectedBlockIds(), 'v'); closeDistributeMenu(); syncInspector(); });

  // Group / Ungroup
  const groupBtn   = document.getElementById('insp-group-btn');
  const ungroupBtn = document.getElementById('insp-ungroup-btn');
  if (groupBtn)   groupBtn.addEventListener('click',   () => { groupBlocks(getSelectedBlockIds()); syncInspector(); });
  if (ungroupBtn) ungroupBtn.addEventListener('click', () => { ungroupSelectedBlocks(); syncInspector(); });

  // Order — Front / Back / Forward / Backward
  const orderFrontBtn    = document.getElementById('insp-order-front-btn');
  const orderBackBtn     = document.getElementById('insp-order-back-btn');
  const orderForwardBtn  = document.getElementById('insp-order-forward-btn');
  const orderBackwardBtn = document.getElementById('insp-order-backward-btn');
  if (orderFrontBtn)    orderFrontBtn.addEventListener('click', () => bringToFront(getSelectedBlockId()));
  if (orderBackBtn)     orderBackBtn.addEventListener('click', () => sendToBack(getSelectedBlockId()));
  if (orderForwardBtn)  orderForwardBtn.addEventListener('click', () => bringForward(getSelectedBlockId()));
  if (orderBackwardBtn) orderBackwardBtn.addEventListener('click', () => sendBackward(getSelectedBlockId()));

  // Position X/Y — commit on blur/Enter (change event), not on every keystroke
  const posXInput = document.getElementById('insp-pos-x');
  const posYInput = document.getElementById('insp-pos-y');
  function commitPositionFields() {
    if (!posXInput || !posYInput) return;
    const x = parseFloat(posXInput.value);
    const y = parseFloat(posYInput.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setBlockPositionFields(getSelectedBlockId(), x, y);
    syncInspector();
  }
  if (posXInput) posXInput.addEventListener('change', commitPositionFields);
  if (posYInput) posYInput.addEventListener('change', commitPositionFields);

  // Rotate / Flip — angle commits on blur/Enter like Position; flip buttons
  // toggle immediately like Bold/Italic/Underline.
  const rotateInput = document.getElementById('insp-rotate-angle');
  const flipHBtn = document.getElementById('insp-flip-h-btn');
  const flipVBtn = document.getElementById('insp-flip-v-btn');
  if (rotateInput) {
    rotateInput.addEventListener('change', () => {
      const deg = parseFloat(rotateInput.value);
      setBlockStyleProp('rotate', Number.isFinite(deg) ? String(deg) : '');
      syncInspector();
    });
  }
  if (flipHBtn) {
    flipHBtn.addEventListener('click', () => {
      const s = getBlockStyle();
      setBlockStyleProp('flipH', !s.flipH);
      syncInspector();
    });
  }
  if (flipVBtn) {
    flipVBtn.addEventListener('click', () => {
      const s = getBlockStyle();
      setBlockStyleProp('flipV', !s.flipV);
      syncInspector();
    });
  }

  // Size — Width/Height commit on blur/Enter like Position. Unlike a
  // corner-handle drag (which keeps the opposite corner fixed), a typed
  // edit keeps the block's center fixed and grows/shrinks symmetrically —
  // matches the translate(-50%,-50%) anchor every freeform block renders
  // with. When Constrain is checked, editing one field recomputes the
  // other from the block's current aspect ratio (only possible once the
  // block already has an explicit size to derive a ratio from).
  const sizeWidthInput = document.getElementById('insp-size-width');
  const sizeHeightInput = document.getElementById('insp-size-height');
  const sizeConstrainCheckbox = document.getElementById('insp-size-constrain');
  function commitSizeFields(changedField) {
    if (!sizeWidthInput || !sizeHeightInput) return;
    let w = parseFloat(sizeWidthInput.value);
    let h = parseFloat(sizeHeightInput.value);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    if (sizeConstrainCheckbox && sizeConstrainCheckbox.checked) {
      const style = getBlockStyle();
      const curW = parseFloat(style.width);
      const curH = parseFloat(style.height);
      if (Number.isFinite(curW) && curW > 0 && Number.isFinite(curH) && curH > 0) {
        if (changedField === 'width') h = curH * (w / curW);
        else w = curW * (h / curH);
      }
    }
    const pos = getResolvedBlockPosition();
    setBlockSize(getSelectedBlockId(), pos.x, pos.y, w, h);
    syncInspector();
  }
  if (sizeWidthInput) sizeWidthInput.addEventListener('change', () => commitSizeFields('width'));
  if (sizeHeightInput) sizeHeightInput.addEventListener('change', () => commitSizeFields('height'));
  if (sizeConstrainCheckbox) {
    sizeConstrainCheckbox.addEventListener('change', () => {
      setBlockStyleProp('constrain', sizeConstrainCheckbox.checked);
      syncInspector();
    });
  }

  // Lock / Unlock
  const lockBtn   = document.getElementById('insp-lock-btn');
  const unlockBtn = document.getElementById('insp-unlock-btn');
  if (lockBtn)   lockBtn.addEventListener('click',   () => { setBlockStyleProp('locked', true);  syncInspector(); });
  if (unlockBtn) unlockBtn.addEventListener('click', () => { setBlockStyleProp('locked', false); syncInspector(); });

  // Zone grid (housed inside the Arrange tab's Align dropdown)
  document.querySelectorAll('#insp-zone-grid .insp-zone-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyLayout(btn.dataset.zone);
      syncInspector();
      closeAlignMenu();
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

  // Color — xcp palette, always visible inline, context-aware (canvas text or notes text)
  const colorMenu = document.getElementById('insp-color-menu');
  if (colorMenu) {
    // Capture any active notes or canvas-text-box selection before a swatch
    // click steals focus. The two are mutually exclusive per mousedown (a
    // selection can only live in one contenteditable at a time), so only one
    // of _notesSelRange/_canvasTextSelRange is ever non-null after this runs.
    colorMenu.addEventListener('mousedown', () => {
      const notesEl = document.getElementById('notes-rendered');
      const canvasTextEl = document.querySelector('.canvas-text-editor');
      const sel = window.getSelection();
      if (notesEl && sel && sel.rangeCount > 0 && notesEl.contains(sel.anchorNode)) {
        _notesSelRange = sel.getRangeAt(0).cloneRange();
        _canvasTextSelRange = null;
      } else if (canvasTextEl && !canvasTextEl.hidden && sel && sel.rangeCount > 0 && canvasTextEl.contains(sel.anchorNode)) {
        _canvasTextSelRange = sel.getRangeAt(0).cloneRange();
        _notesSelRange = null;
      } else {
        _notesSelRange = null;
        _canvasTextSelRange = null;
      }
    });

    colorMenu.appendChild(_buildXcpMenu(hex => {
      const notesEl = document.getElementById('notes-rendered');
      const canvasTextEl = document.querySelector('.canvas-text-editor');
      if (_notesSelRange && notesEl && _syncNotes) {
        notesEl.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(_notesSelRange);
        if (!sel.isCollapsed) {
          if (hex === null) {
            _stripSelectionColor(notesEl);
            _syncNotes();
          } else {
            document.execCommand('foreColor', false, hex);
            _syncNotes();
          }
        }
      } else if (_canvasTextSelRange && canvasTextEl && !canvasTextEl.hidden) {
        // Same execCommand-on-a-restored-Range approach as notes above, just
        // targeting the active canvas text box instead. No explicit save-back
        // to the block's markdown is needed here: .canvas-text-editor IS the
        // live editable surface (not a separate preview like notes-rendered
        // is), so the color change is already live the moment execCommand
        // runs, and commitEdit (canvas-editor.js) reads this same innerHTML
        // fresh via htmlToBody whenever the edit is saved — same path a
        // manually-typed <span style="color:..."> already round-trips
        // through (nodeToMarkdown's span case).
        canvasTextEl.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(_canvasTextSelRange);
        if (!sel.isCollapsed) {
          if (hex === null) {
            _stripSelectionColor(canvasTextEl);
          } else {
            document.execCommand('foreColor', false, hex);
          }
        }
      } else {
        const resetColor = '#ffffff';
        const appliedColor = hex === null ? resetColor : hex;
        setBlockStyleProp('color', appliedColor);
        syncInspector();
      }
    }));
  }

  // Box fill / border — same xcp palette pattern as text color, applied to
  // the selected block's box-bg/box-border style (Phase 1 data model, Phase 2
  // real-render support). Fill picks a translucent tint of the chosen color,
  // matching the app's existing dark/light text-background pill aesthetic;
  // border applies a fixed 3px solid width, keeping the control to a single
  // color choice rather than exposing width/style as separate knobs.
  const boxBgMenu = document.getElementById('insp-boxbg-menu');
  if (boxBgMenu) {
    boxBgMenu.appendChild(_buildXcpMenu(hex => {
      setBlockStyleProp('boxBg', hex === null ? '' : _hexToRgba(hex, 0.65));
      syncInspector();
    }));
  }

  const boxBorderMenu = document.getElementById('insp-boxborder-menu');
  if (boxBorderMenu) {
    boxBorderMenu.appendChild(_buildXcpMenu(hex => {
      setBlockStyleProp('boxBorder', hex === null ? '' : ('3px solid ' + hex));
      syncInspector();
    }));
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

  // Bullet list / Numbered list — context-aware (canvas or notes)
  const bulletListBtn = document.getElementById('insp-bullet-btn');
  const numberListBtn = document.getElementById('insp-number-btn');

  function captureNotesRange() {
    const notesEl = document.getElementById('notes-rendered');
    const sel = window.getSelection();
    if (notesEl && sel && sel.rangeCount > 0 && notesEl.contains(sel.anchorNode)) {
      return sel.getRangeAt(0).cloneRange();
    }
    return null;
  }

  if (bulletListBtn) {
    bulletListBtn.addEventListener('mousedown', () => {
      _bulletSelRange = captureNotesRange();
    });
    bulletListBtn.addEventListener('click', () => {
      const notesEl = document.getElementById('notes-rendered');
      if (_bulletSelRange && notesEl && _syncNotes) {
        notesEl.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(_bulletSelRange);
        document.execCommand('insertUnorderedList');
        _syncNotes();
      } else {
        setBlockStyleProp('blockType', 'ul');
        syncInspector();
      }
    });
  }

  if (numberListBtn) {
    numberListBtn.addEventListener('mousedown', () => {
      _numberSelRange = captureNotesRange();
    });
    numberListBtn.addEventListener('click', () => {
      const notesEl = document.getElementById('notes-rendered');
      if (_numberSelRange && notesEl && _syncNotes) {
        notesEl.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(_numberSelRange);
        document.execCommand('insertOrderedList');
        _syncNotes();
      } else {
        setBlockStyleProp('blockType', 'ol');
        syncInspector();
      }
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
    _loadNotesFromMarkdown = loadFromMarkdown;

    loadFromMarkdown();

    notesRendered.addEventListener('input', syncToMarkdown);
    attachSmartDashes(notesRendered);

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

// Generic trigger/menu dropdown: toggles the menu's `hidden` attribute and
// closes on an outside click or Escape — mirrors the open/close pattern
// already used throughout http_admin/builder/menus.js for the toolbar's own
// dropdowns (e.g. openSlideToolsMenu/closeSlideToolsMenu), just generalized
// to take any trigger+menu pair instead of one hardcoded per menu.
function _wireDropdown(triggerBtn, menuEl) {
  if (!triggerBtn || !menuEl) return () => {};

  function close() {
    menuEl.hidden = true;
    triggerBtn.classList.remove('is-active');
    document.removeEventListener('mousedown', onOutsideClick);
    document.removeEventListener('keydown', onKeydown);
  }

  function onOutsideClick(e) {
    if (menuEl.contains(e.target) || triggerBtn.contains(e.target)) return;
    close();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  triggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menuEl.hidden) { close(); return; }
    menuEl.hidden = false;
    triggerBtn.classList.add('is-active');
    document.addEventListener('mousedown', onOutsideClick);
    document.addEventListener('keydown', onKeydown);
  });

  return close;
}

function _hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _stripSelectionColor(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  if (sel.isCollapsed) return;

  // Apply a sentinel color via execCommand — this makes the browser automatically
  // split any partially-overlapping color spans at the selection boundaries.
  // We then remove only the sentinel-colored elements, leaving adjacent colors intact.
  const SENTINEL = '#010203';
  document.execCommand('foreColor', false, SENTINEL);

  if (!container) return;
  container.querySelectorAll('font, span').forEach(el => {
    const raw = (el.tagName === 'FONT' ? el.getAttribute('color') : null)
      || (el.style && el.style.color) || '';
    const norm = raw.replace(/\s/g, '').toLowerCase();
    if (norm === SENTINEL || norm === 'rgb(1,2,3)') {
      if (el.tagName === 'FONT') el.removeAttribute('color');
      else el.style.removeProperty('color');
    }
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

  const defaultBtn = document.createElement('button');
  defaultBtn.type = 'button';
  defaultBtn.className = 'xcp-default-btn';
  defaultBtn.title = 'Remove color formatting (inherits default)';
  defaultBtn.innerHTML = '<span class="xcp-default-icon"></span>Default Color';
  defaultBtn.addEventListener('mousedown', e => e.preventDefault());
  defaultBtn.addEventListener('click', () => onPick(null));
  frag.appendChild(defaultBtn);

  const topDivider = document.createElement('div');
  topDivider.className = 'xcp-divider';
  frag.appendChild(topDivider);

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

// Font names only (no comma-separated fallback stacks): setBlockStyleProp
// round-trips this value through the block's `<!-- canvas_block_N: ... -->`
// marker, whose key=val pairs split on unparenthesized commas (see
// splitStyleArgs in canvas-editor.js and splitCanvasBlockArgs in
// markdown-compiler.js) — a stack like "Helvetica, Arial, sans-serif" would
// get sliced apart into bogus extra pairs. A bare name (quoted or not, CSS
// accepts multi-word font-family idents unquoted) is exactly what Keynote's
// own font picker stores too, so this matches that behavior: no fallback
// chain, just the one family, same as a user picking a font that turns out
// not to be installed.
// The first 5 are this app's own bundled webfonts (always available offline
// — see revelation_dark.scss/revelation_light.scss's font imports); the
// rest are common cross-platform system fonts.
const CANVAS_TEXT_FONTS = [
  'Inter', 'Source Sans Pro', 'Noto Serif', 'JetBrains Mono', 'League Gothic',
  'Georgia', 'Times New Roman', 'Helvetica', 'Arial', 'Verdana',
  'Trebuchet MS', 'Courier New', 'Palatino', 'Impact'
];

function _populateFontSelect(sel) {
  CANVAS_TEXT_FONTS.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}
