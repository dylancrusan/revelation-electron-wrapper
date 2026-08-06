// plugins/addmedia/builder-backgrounds.js
//
// Builder toolbar action that opens a visual picker of every background
// image/video already used somewhere in the presentation currently being
// edited, so another slide can reuse one with a single click. Everything
// is read straight from the live (possibly unsaved) BuilderHost document —
// no file scanning, since a background used in this deck already lives
// wherever this deck can already reach it.

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv']);

function inferMediaType(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'unknown';
}

// Collapse a sorted list of consecutive integers into range strings, e.g.
// [1,2,3,5,7,8] -> ["1-3", "5", "7-8"].
function compressRanges(sortedNums) {
  const ranges = [];
  let start = sortedNums[0];
  let prev = sortedNums[0];
  for (let i = 1; i <= sortedNums.length; i += 1) {
    const n = sortedNums[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return ranges;
}

// Format the full set of slide positions a background was found on into a
// compact, range-collapsed label, e.g. "Slides 1-3, 5" or, for multi-column
// decks, "Slides 1.2-4, 2.1".
function formatLocations(positions, multiColumn) {
  if (!multiColumn) {
    const nums = [...new Set(positions.map((p) => p.v + 1))].sort((a, b) => a - b);
    if (nums.length === 1) return `${tr('Slide')} ${nums[0]}`;
    return `${tr('Slides')} ${compressRanges(nums).join(', ')}`;
  }

  const byH = new Map();
  positions.forEach((p) => {
    if (!byH.has(p.h)) byH.set(p.h, []);
    byH.get(p.h).push(p.v + 1);
  });
  const parts = [];
  byH.forEach((vNums, h) => {
    const sorted = [...new Set(vNums)].sort((a, b) => a - b);
    parts.push(`${h + 1}.${compressRanges(sorted).join(',')}`);
  });
  return `${tr('Slides')} ${parts.join(', ')}`;
}

// Read every `![background...]` reference out of the live document, resolve
// each to a displayable item, and collect every slide it appears on.
function extractBackgrounds(doc) {
  const media = doc.media && typeof doc.media === 'object' ? doc.media : {};
  const byRef = new Map();
  const bgRe = /!\[background(?::\w+)?\]\(([^)]+)\)/g;
  const multiColumn = doc.stacks.length > 1;

  doc.stacks.forEach((column, h) => {
    column.forEach((slide, v) => {
      [slide.top, slide.body].forEach((text) => {
        if (!text) return;
        bgRe.lastIndex = 0;
        let m;
        while ((m = bgRe.exec(text))) {
          const raw = m[1].trim();
          if (!raw) continue;
          if (!byRef.has(raw)) byRef.set(raw, { positions: [] });
          const entry = byRef.get(raw);
          if (!entry.positions.some((p) => p.h === h && p.v === v)) {
            entry.positions.push({ h, v });
          }
        }
      });
    });
  });

  const items = [];
  byRef.forEach(({ positions }, raw) => {
    const item = buildItem(raw, media);
    item.location = formatLocations(positions, multiColumn);
    items.push(item);
  });

  return items.filter((item) => item.mediatype === 'image' || item.mediatype === 'video');
}

function buildItem(raw, media) {
  const aliasMatch = raw.match(/^media:([a-zA-Z0-9_-]+)$/);
  if (aliasMatch) {
    const entry = media[aliasMatch[1]] || {};
    return {
      source: 'library',
      ref: raw,
      mediatype: entry.mediatype || inferMediaType(entry.filename),
      filename: entry.filename || '',
      title: entry.title || entry.filename || aliasMatch[1],
      attribution: entry.attribution || ''
    };
  }
  if (/^https?:\/\//i.test(raw)) {
    return {
      source: 'url',
      ref: raw,
      mediatype: inferMediaType(raw.split('?')[0]),
      title: decodeURIComponent(raw.split('/').pop() || raw)
    };
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep raw value if it isn't validly encoded.
  }
  decoded = decoded.split('?')[0].split('#')[0];
  return {
    source: 'local',
    ref: raw,
    mediatype: inferMediaType(decoded),
    filename: decoded,
    title: decoded
  };
}

function videoGlyph() {
  const span = document.createElement('span');
  span.textContent = '🎬';
  span.style.cssText = 'font-size:32px;opacity:.85;';
  return span;
}

function renderThumb(actionCtx, item) {
  const box = document.createElement('div');
  box.style.cssText = [
    'aspect-ratio:16/9',
    'border-radius:8px',
    'overflow:hidden',
    'background:linear-gradient(160deg,#172233,#0c1420)',
    'display:flex',
    'align-items:center',
    'justify-content:center'
  ].join(';');

  const showImg = (src, allowFallback) => {
    const img = document.createElement('img');
    img.src = src;
    img.loading = 'lazy';
    img.alt = item.title || item.filename || '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    if (allowFallback) {
      img.addEventListener('error', () => {
        img.remove();
        box.appendChild(videoGlyph());
      }, { once: true });
    }
    box.appendChild(img);
  };

  if (item.mediatype === 'video') {
    if (item.source === 'library' && item.filename) {
      // Videos added through the media library get a sibling thumbnail
      // generated at import time; fall back to a generic icon if missing.
      showImg(`/${actionCtx.dir}/_media/${encodeURIComponent(item.filename)}.thumbnail.jpg`, true);
    } else {
      box.appendChild(videoGlyph());
    }
    return box;
  }

  if (item.source === 'library') {
    showImg(`/${actionCtx.dir}/_media/${encodeURIComponent(item.filename)}`, false);
  } else if (item.source === 'local') {
    showImg(`/${actionCtx.dir}/${encodeURIComponent(actionCtx.slug)}/${encodeURIComponent(item.filename)}`, false);
  } else if (item.source === 'url') {
    showImg(item.ref, false);
  }

  return box;
}

// Remove any existing `![background...]` line from slide text, keeping the
// rest, then place the new snippet at the top of what remains.
function mergeBackgroundIntoText(existingText, snippet) {
  const cleaned = String(existingText || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('![background'))
    .join('\n')
    .trim();
  return cleaned ? `${snippet}\n\n${cleaned}` : snippet;
}

function buildBackgroundSnippet(ref, sticky, attribution) {
  const bgLine = sticky ? `![background:sticky](${ref})` : `![background](${ref})`;
  const attribText = String(attribution || '').trim();
  if (!attribText) return bgLine;
  const label = tr('Background');
  return sticky
    ? `${bgLine}\n{{attrib:${label} ${attribText}}}`
    : `${bgLine}\n:ATTRIB:${label} ${attribText}`;
}

function applyBackground(actionCtx, ui, item) {
  const { host } = actionCtx;
  const sticky = ui.stickyCheckbox.checked;
  const ref = item.source === 'local' ? encodeURIComponent(item.filename) : item.ref;
  const snippet = buildBackgroundSnippet(ref, sticky, item.attribution);

  const selection = host.getSelection();
  const doc = host.getDocument();
  const column = doc.stacks[selection.h] || [];
  const slideEntry = column[selection.v];
  if (!slideEntry) return;

  const field = sticky ? 'top' : 'body';
  slideEntry[field] = mergeBackgroundIntoText(slideEntry[field], snippet);

  host.transact('Insert background', (tx) => {
    tx.replaceColumn(selection.h, column);
  });
  host.notify(tr('Background applied to the slide.'), 'info');
}

function buildCard(actionCtx, ui, item) {
  const card = document.createElement('button');
  card.type = 'button';
  card.style.cssText = [
    'display:flex',
    'flex-direction:column',
    'gap:6px',
    'padding:6px',
    'border:1px solid #2a2f39',
    'border-radius:10px',
    'background:#161a24',
    'color:#e6e6e6',
    'cursor:pointer',
    'text-align:left',
    'font:inherit'
  ].join(';');

  card.appendChild(renderThumb(actionCtx, item));

  const title = document.createElement('div');
  title.textContent = item.title || item.filename;
  title.style.cssText = 'font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  card.appendChild(title);

  const sub = document.createElement('div');
  sub.style.cssText = 'font:11px/1.3 system-ui,sans-serif;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  sub.textContent = item.location;
  sub.title = item.location;
  card.appendChild(sub);

  card.addEventListener('mouseenter', () => { card.style.borderColor = '#3b82f6'; });
  card.addEventListener('mouseleave', () => { card.style.borderColor = '#2a2f39'; });

  card.addEventListener('click', () => {
    try {
      applyBackground(actionCtx, ui, item);
      ui.close();
    } catch (err) {
      actionCtx.host.notify(`${tr('Failed to apply background')}: ${err.message}`, 'error');
    }
  });

  return card;
}

function renderDialog({ root, close }, actionCtx, items) {
  root.innerHTML = '';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;';
  const heading = document.createElement('h3');
  heading.textContent = `🖼️ ${tr('Backgrounds In Use')}`;
  heading.style.cssText = 'margin:0;font:600 16px/1.3 system-ui,sans-serif;';
  header.appendChild(heading);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'panel-button';
  closeBtn.textContent = tr('Close');
  closeBtn.addEventListener('click', () => close());
  header.appendChild(closeBtn);
  root.appendChild(header);

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = tr('Search…');
  search.style.cssText = 'flex:1;min-width:160px;padding:6px 8px;border-radius:6px;border:1px solid #303545;background:#0f1115;color:#e6e6e6;';
  controls.appendChild(search);

  const stickyLabel = document.createElement('label');
  stickyLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui,sans-serif;white-space:nowrap;';
  const stickyCheckbox = document.createElement('input');
  stickyCheckbox.type = 'checkbox';
  stickyCheckbox.checked = true;
  stickyLabel.appendChild(stickyCheckbox);
  stickyLabel.appendChild(document.createTextNode(tr('Sticky (carries to following slides)')));
  controls.appendChild(stickyLabel);

  root.appendChild(controls);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;';
  root.appendChild(grid);

  const ui = { close, stickyCheckbox };

  const renderGrid = () => {
    const q = search.value.trim().toLowerCase();
    grid.innerHTML = '';
    const filtered = q
      ? items.filter((item) => `${item.title || ''} ${item.filename || ''}`.toLowerCase().includes(q))
      : items;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:.7;font:13px system-ui,sans-serif;padding:20px 0;';
      empty.textContent = items.length
        ? tr('No backgrounds match your search.')
        : tr('This presentation doesn\'t use any backgrounds yet. Add one to a slide to see it here for reuse.');
      grid.appendChild(empty);
      return;
    }

    filtered.forEach((item) => grid.appendChild(buildCard(actionCtx, ui, item)));
  };

  search.addEventListener('input', renderGrid);
  renderGrid();
}

export function getBuilderExtensions(ctx = {}) {
  const host = ctx.host;
  if (!host) return [];

  return [
    {
      kind: 'toolbar-action',
      id: 'addmedia-used-backgrounds',
      label: 'Backgrounds In Use',
      icon: '🖼️',
      onClick(actionCtx) {
        const doc = actionCtx.host.getDocument();
        const items = extractBackgrounds(doc);
        actionCtx.host.openDialog({
          render: (dialogCtx) => renderDialog(dialogCtx, actionCtx, items)
        });
      }
    }
  ];
}
