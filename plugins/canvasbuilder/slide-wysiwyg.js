/*
 * Slide WYSIWYG editor: markdown ↔ HTML conversion.
 *
 * Sections:
 * - Macro detection and labeling
 * - Inline formatting helpers
 * - bodyToHtml (markdown → contenteditable HTML)
 * - htmlToBody (contenteditable HTML → markdown)
 */

// Detect body lines that should appear as non-editable chips.
function isSlideBodyMacro(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^!\[/.test(trimmed)) return true;
  if (/^:audio:/.test(trimmed)) return true;
  if (/^\+\+/.test(trimmed)) return true;
  if (trimmed === '||') return true;
  if (/^:ATTRIB:/i.test(trimmed)) return true;
  if (trimmed === ':AI:') return true;
  if (/^\{\{/.test(trimmed)) return true;
  if (/^<!--/.test(trimmed)) return true;
  if (/^:[a-zA-Z][a-zA-Z0-9_]*:/.test(trimmed)) return true;
  return false;
}

// Short human-readable label for a macro line.
function macroLabel(line) {
  const trimmed = line.trim();
  if (/^!\[background:sticky/.test(trimmed)) return '\uD83C\uDF9E background (sticky)';
  if (/^!\[background:noloop/.test(trimmed)) return '\uD83C\uDF9E background (no loop)';
  if (/^!\[background/.test(trimmed)) return '\uD83C\uDF9E background';
  if (/^!\[fit/.test(trimmed)) return '\uD83D\uDDBC fit image';
  if (/^!\[/.test(trimmed)) return '\uD83D\uDDBC image';
  if (/^:audio:playloop/.test(trimmed)) return '\uD83D\uDD0A audio (loop)';
  if (/^:audio:play/.test(trimmed)) return '\uD83D\uDD0A audio';
  if (/^\+\+/.test(trimmed)) return '\u22EF fragment';
  if (trimmed === '||') return '\u25A6 column';
  if (/^:ATTRIB:/i.test(trimmed)) return '\u270D attribution';
  if (trimmed === ':AI:') return '\uD83E\uDD16 AI';
  if (/^\{\{bgtint/.test(trimmed)) return '\uD83C\uDFA8 tint';
  if (/^\{\{darkbg/.test(trimmed)) return '\uD83C\uDF11 dark bg';
  if (/^\{\{lightbg/.test(trimmed)) return '\u2600\uFE0F light bg';
  if (/^\{\{darktext/.test(trimmed)) return '\uD83C\uDF11 dark text';
  if (/^\{\{lighttext/.test(trimmed)) return '\u2600\uFE0F light text';
  if (/^\{\{shiftright/.test(trimmed)) return '\u27A1 shift right';
  if (/^\{\{shiftleft/.test(trimmed)) return '\u2B05 shift left';
  if (/^\{\{lowerthird/.test(trimmed)) return '\u2B07 lower third';
  if (/^\{\{upperthird/.test(trimmed)) return '\u2B06 upper third';
  if (/^\{\{info/.test(trimmed)) return '\u2139 info';
  if (/^\{\{animate/.test(trimmed)) return '\u2728 animate';
  if (/^\{\{transition/.test(trimmed)) return '\u2194 transition';
  if (/^\{\{audio/.test(trimmed)) return '\uD83D\uDD0A audio';
  if (/^\{\{autoslide/.test(trimmed)) return '\u23F1 auto-slide';
  if (/^\{\{attrib/.test(trimmed)) return '\u270D attribution';
  if (/^\{\{ai/.test(trimmed)) return '\uD83E\uDD16 AI';
  if (/^\{\{\}\}/.test(trimmed)) return '\u2716 clear';
  if (/^<!--\s*canvas_block_/.test(trimmed)) return '\u25a6 block style';
  if (/^<!--/.test(trimmed)) return '\u2699 comment';
  if (/^:lightbg:/.test(trimmed)) return '\u2600\uFE0F light bg';
  if (/^:darkbg:/.test(trimmed)) return '\uD83C\uDF11 dark bg';
  if (/^:lighttext:/.test(trimmed)) return '\u2600\uFE0F light text';
  if (/^:darktext:/.test(trimmed)) return '\uD83C\uDF11 dark text';
  if (/^:shiftright:/.test(trimmed)) return '\u27A1 shift right';
  if (/^:shiftleft:/.test(trimmed)) return '\u2B05 shift left';
  if (/^:lowerthird:/.test(trimmed)) return '\u2B07 lower third';
  if (/^:upperthird:/.test(trimmed)) return '\u2B06 upper third';
  if (/^:infofull:/.test(trimmed)) return '\u2139 info full';
  if (/^:info:/.test(trimmed)) return '\u2139 info';
  if (/^:animate:/.test(trimmed)) return '\u2728 animate';
  if (/^:autoslide:/.test(trimmed)) return '\u23F1 auto-slide';
  if (/^:countdown:/.test(trimmed)) return '\u23F1 countdown';
  if (/^:transition:/.test(trimmed)) return '\u2194 transition';
  if (/^:credits:/.test(trimmed)) return '\u270D credits';
  if (/^:caption:/.test(trimmed)) return '\u270D caption';
  return '\u2699 macro';
}

// Apply just the markdown-syntax replacements (bold/italic/underline/
// strikethrough/links) to a plain-text segment — escapes it first (so **, *,
// etc. can't be spoofed via embedded HTML) then layers on the HTML those
// symbols represent. Only ever called on a real DOM TEXT_NODE's content
// (see inlineMarkdownToHtml below), never on a segment that might itself
// contain real embedded HTML tags — those are already-parsed elements by
// that point, not text this function will ever see.
function markdownSyntaxToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*([^*<>]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)([^*<>]+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    .replace(/__([^_<>]+?)__/g, '<u>$1</u>')
    .replace(/~~([^~<>]+?)~~/g, '<s>$1</s>')
    .replace(/\[([^\]<>]+?)\]\(([^)\s<>]+?)\)/g, '<a href="$2">$1</a>');
}

// Recursively applies markdown-syntax formatting to the TEXT content of a
// parsed fragment, leaving any real HTML elements already present (e.g. a
// <span style="..."> an author embedded directly in the slide's markdown
// source) untouched structurally — only recursing into their children so
// markdown syntax still works inside them too.
function applyMarkdownSyntaxToNode(root) {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const span = document.createElement('span');
      span.innerHTML = markdownSyntaxToHtml(child.textContent);
      child.replaceWith(...span.childNodes);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      applyMarkdownSyntaxToNode(child);
    }
  }
}

// Convert a raw slide-body line — markdown syntax plus any raw HTML an author
// embedded directly in the source (e.g. the <span style="font-size:0.85em">
// trick used to shrink a closing quote mark) — into HTML for the
// contenteditable editor. Parsed via a <template> (inert: nothing in it ever
// executes, matching how html-sanitization.js's own sanitizeHTMLFragment
// parses untrusted markup) rather than blanket-escaping every `<`/`>` first,
// so real embedded tags survive as real markup instead of showing up as
// visible, editable tag text — see nodeToMarkdown below for the matching
// save-side fix that keeps such tags from being silently dropped again.
function inlineMarkdownToHtml(text) {
  const template = document.createElement('template');
  template.innerHTML = text;
  applyMarkdownSyntaxToNode(template.content);
  return template.innerHTML;
}

// Matches the real compiler's end-of-line fragment marker exactly (see
// markdown-compiler.js's fallback path, "++" or "++:preset:options...", used
// for both list items and paragraph-final lines). Capturing this precisely —
// not just a loose "ends with ++" check — keeps the editor's idea of "this is
// a fragment" identical to what the live compile will actually do with it.
const TRAILING_FRAGMENT_RE = /\s*(\+\+(?::[a-zA-Z0-9:]+)?)$/;

// Strip a trailing fragment marker from a line's raw markdown text, if
// present. The compiled slide hides fragment content entirely until
// advanced (markdown-compiler.js:779-781); showing literal "++" characters
// in the editor is neither that hidden state nor the real revealed text, so
// bodyToHtml instead renders a small non-editable badge in its place (see
// withFragmentBadge) — closer to the truth without hiding text the author
// still needs to be able to read and edit.
function stripTrailingFragment(text) {
  const match = text.match(TRAILING_FRAGMENT_RE);
  if (!match) return { text, marker: null };
  return { text: text.slice(0, match.index), marker: match[1] };
}

// Non-editable "this text is a fragment" indicator, styled to match the
// existing whole-line macro chip (.slide-wysiwyg-macro) so the two read as
// the same design language. The exact marker (including any :preset:options)
// is preserved on the element so htmlToBody can restore it byte-for-byte.
function fragmentBadgeHtml(marker) {
  const escaped = marker.replace(/"/g, '&quot;');
  return ` <span class="slide-wysiwyg-fragment-badge" data-fragment-marker="${escaped}" contenteditable="false" title="Appears on click">⋯</span>`;
}

// Convert one line's markdown to HTML, converting a trailing fragment marker
// (if present) into the badge above instead of leaving "++" as raw editable
// text. Use in place of inlineMarkdownToHtml anywhere a fragment marker is
// meaningful (headings, list items, the last line of a paragraph).
function withFragmentBadge(rawText) {
  const { text, marker } = stripTrailingFragment(rawText);
  const html = inlineMarkdownToHtml(text);
  return marker ? html + fragmentBadgeHtml(marker) : html;
}

// Walk a DOM node tree and convert to markdown, preserving styled <span> as HTML.
function nodeToMarkdown(node) {
  let result = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    const inner = nodeToMarkdown(child);
    if (tag === 'span' && child.classList.contains('slide-wysiwyg-fragment-badge')) {
      // Restore the exact marker this badge stands in for (see
      // withFragmentBadge) — must be checked before the generic <span>
      // branch below, or this would save as literal "⋯" text instead.
      result += ` ${child.dataset.fragmentMarker || '++'}`;
    } else if (tag === 'strong' || tag === 'b') {
      result += `**${inner}**`;
    } else if (tag === 'em' || tag === 'i') {
      result += `*${inner}*`;
    } else if (tag === 'u') {
      result += `__${inner}__`;
    } else if (tag === 's' || tag === 'strike' || tag === 'del') {
      result += `~~${inner}~~`;
    } else if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      result += `[${inner}](${href})`;
    } else if (tag === 'span') {
      const style = child.getAttribute('style');
      result += style ? `<span style="${style}">${inner}</span>` : inner;
    } else if (tag === 'br') {
      result += '\n';
    } else {
      // Any other real element only ever gets here via inlineMarkdownToHtml's
      // own HTML parsing (see its comment) — i.e. it's a tag the slide's
      // markdown source embedded directly and wasn't already covered above.
      // Reconstructing it with its attributes (rather than discarding the
      // wrapper and keeping only inner) is what makes that round-trip
      // lossless; the real compiler's own sanitizer (html-sanitization.js)
      // is permissive by default (block-list, not allow-list), so this can't
      // introduce a tag the compiled slide wouldn't already have accepted.
      const attrs = Array.from(child.attributes || [])
        .map((attr) => ` ${attr.name}="${attr.value.replace(/"/g, '&quot;')}"`)
        .join('');
      result += `<${tag}${attrs}>${inner}</${tag}>`;
    }
  }
  return result;
}

// Convert inline HTML (from contenteditable) back to markdown syntax.
// Preserves <u> and <span style> as literal HTML (valid in Reveal.js markdown).
function inlineHtmlToMarkdown(html) {
  const temp = document.createElement('span');
  temp.innerHTML = html;
  return nodeToMarkdown(temp).trim();
}

// Convert slide body markdown to HTML for the contenteditable editor.
function bodyToHtml(markdown) {
  if (!markdown || !markdown.trim()) return '';
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let listType = null;
  let listItems = [];
  let quoteLines = null;
  // Consecutive plain-text lines with no blank line between them are one
  // markdown paragraph, not one <p> per source line — the real compiler
  // (reveal.js's bundled marked, default breaks:false) joins them and lets
  // the result reflow to the container width, same as any other soft line
  // break. Emitting a separate <p> per line here used to force a paragraph
  // break exactly where the author happened to wrap their source text,
  // which both wraps differently than the live slide AND, for a
  // dark/light-bg block, paints one pill box per source line instead of
  // one pill around the whole reflowed paragraph (see styles.css's
  // .canvas-text-editor.has-darkbg/.has-lightbg p rules).
  let paragraphLines = null;

  const flushList = () => {
    if (!listType || !listItems.length) return;
    const tag = listType;
    // Each list item is its own line in the source (bodyToHtml's per-line
    // loop below), so a trailing "++" on any one of them is that item's own
    // fragment marker — matches the real compiler treating each list line
    // independently (markdown-compiler.js:770's isListItem check).
    const items = listItems.map((item) => `<li>${withFragmentBadge(item)}</li>`).join('');
    blocks.push(`<${tag}>${items}</${tag}>`);
    listType = null;
    listItems = [];
  };

  const flushQuote = () => {
    if (!quoteLines) return;
    const inner = quoteLines.map((l) => inlineMarkdownToHtml(l)).join('<br>');
    blocks.push(`<blockquote>${inner}</blockquote>`);
    quoteLines = null;
  };

  const flushParagraph = () => {
    if (!paragraphLines) return;
    // Joined with a space, matching how the real renderer displays a
    // CommonMark soft line break (rendered whitespace, not a forced <br>).
    // Only the last source line can carry a fragment marker — the real
    // compiler only treats "++" as a fragment when it's the last line before
    // a blank line/EOF (markdown-compiler.js:772's isEndOfParagraph check),
    // so an earlier soft-wrapped line ending in "++" is just literal text.
    const lastIndex = paragraphLines.length - 1;
    const inner = paragraphLines
      .map((l, i) => (i === lastIndex ? withFragmentBadge(l) : inlineMarkdownToHtml(l)))
      .join(' ');
    blocks.push(`<p>${inner}</p>`);
    paragraphLines = null;
  };

  const flushAll = () => { flushList(); flushQuote(); flushParagraph(); };

  for (const line of lines) {
    if (isSlideBodyMacro(line)) {
      flushAll();
      const escaped = line.replace(/"/g, '&quot;');
      const label = macroLabel(line);
      blocks.push(
        `<div data-macro="${escaped}" class="slide-wysiwyg-macro-line" contenteditable="false">` +
        `<span class="slide-wysiwyg-macro">${label}</span></div>`
      );
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      flushAll();
      // Only exists so htmlToBody can reconstruct the blank line that
      // separates markdown paragraphs (e.g. the one between a quote and its
      // _citation_ — without it they'd collapse into a single paragraph on
      // save, changing how the real compiler renders the citation). It has
      // no visible counterpart in the compiled slide, so it's tagged with
      // its own class purely so styles.css can zero it out visually —
      // otherwise it inherits the same p { ...has-darkbg pill... } styling
      // as real content and shows up as an empty dark box around the caret.
      blocks.push('<p class="slide-wysiwyg-blank-line"><br></p>');
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      if (!quoteLines) { flushList(); flushParagraph(); quoteLines = []; }
      quoteLines.push(quote[1]);
      continue;
    }
    flushQuote();

    const h6 = trimmed.match(/^###### (.+)$/);
    if (h6) { flushList(); flushParagraph(); blocks.push(`<h6>${withFragmentBadge(h6[1])}</h6>`); continue; }

    const h5 = trimmed.match(/^##### (.+)$/);
    if (h5) { flushList(); flushParagraph(); blocks.push(`<h5>${withFragmentBadge(h5[1])}</h5>`); continue; }

    const h4 = trimmed.match(/^#### (.+)$/);
    if (h4) { flushList(); flushParagraph(); blocks.push(`<h4>${withFragmentBadge(h4[1])}</h4>`); continue; }

    const h3 = trimmed.match(/^### (.+)$/);
    if (h3) { flushList(); flushParagraph(); blocks.push(`<h3>${withFragmentBadge(h3[1])}</h3>`); continue; }

    const h2 = trimmed.match(/^## (.+)$/);
    if (h2) { flushList(); flushParagraph(); blocks.push(`<h2>${withFragmentBadge(h2[1])}</h2>`); continue; }

    const h1 = trimmed.match(/^# (.+)$/);
    if (h1) { flushList(); flushParagraph(); blocks.push(`<h1>${withFragmentBadge(h1[1])}</h1>`); continue; }

    const bullet = trimmed.match(/^- (.*)$/);
    if (bullet) {
      if (listType !== 'ul') { flushList(); flushParagraph(); listType = 'ul'; }
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = trimmed.match(/^\d+\. (.*)$/);
    if (numbered) {
      if (listType !== 'ol') { flushList(); flushParagraph(); listType = 'ol'; }
      listItems.push(numbered[1]);
      continue;
    }

    // Verse/reference syntax: a whole line wrapped in single underscores
    // (double-underscore __underline__ is excluded via the lookaround guards).
    const verseRef = trimmed.match(/^_(?!_)(.+?)(?<!_)_$/);
    if (verseRef) {
      flushList();
      flushParagraph();
      blocks.push(`<p class="slide-wysiwyg-verse-ref">${inlineMarkdownToHtml(verseRef[1])}</p>`);
      continue;
    }

    flushList();
    if (!paragraphLines) paragraphLines = [];
    paragraphLines.push(trimmed);
  }

  flushAll();
  return blocks.join('');
}

// Convert contenteditable HTML back to slide body markdown.
function htmlToBody(html) {
  if (!html || !html.trim()) return '';
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const lines = [];
  // True only right after pushing a non-empty generic (unclassed) <p>'s text.
  // bodyToHtml now emits exactly one <p> per real paragraph (see its own
  // comment), so two of these in a row can only mean the user pressed Enter
  // inside the editor to start a genuinely new paragraph — without a blank
  // line between them here, the real compiler (marked, breaks:false) would
  // silently rejoin them into one paragraph next time this text is compiled.
  let prevWasParagraph = false;

  const extractInline = (el) => inlineHtmlToMarkdown(el.innerHTML || '');

  for (const node of temp.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) lines.push(text);
      prevWasParagraph = false;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node;
    const tag = el.tagName.toLowerCase();
    const wasPrevParagraph = prevWasParagraph;
    prevWasParagraph = false;

    // Macro div — restore original markdown line verbatim
    if (typeof el.dataset.macro === 'string') {
      lines.push(el.dataset.macro);
      continue;
    }

    if (tag === 'h1') { lines.push(`# ${extractInline(el)}`); continue; }
    if (tag === 'h2') { lines.push(`## ${extractInline(el)}`); continue; }
    if (tag === 'h3') { lines.push(`### ${extractInline(el)}`); continue; }
    if (tag === 'h4') { lines.push(`#### ${extractInline(el)}`); continue; }
    if (tag === 'h5') { lines.push(`##### ${extractInline(el)}`); continue; }
    if (tag === 'h6') { lines.push(`###### ${extractInline(el)}`); continue; }

    if (tag === 'blockquote') {
      const inner = extractInline(el);
      for (const quoteLine of inner.split('\n')) lines.push(`> ${quoteLine}`);
      continue;
    }

    if (tag === 'p' && el.classList.contains('slide-wysiwyg-verse-ref')) {
      lines.push(`_${extractInline(el)}_`);
      continue;
    }

    if (tag === 'ul') {
      for (const li of el.querySelectorAll(':scope > li')) {
        lines.push(`- ${inlineHtmlToMarkdown(li.innerHTML)}`);
      }
      continue;
    }

    if (tag === 'ol') {
      let n = 1;
      for (const li of el.querySelectorAll(':scope > li')) {
        lines.push(`${n}. ${inlineHtmlToMarkdown(li.innerHTML)}`);
        n += 1;
      }
      continue;
    }

    if (tag === 'br') {
      lines.push('');
      continue;
    }

    // p, div, and other browser-generated wrappers
    const inner = el.innerHTML || '';
    if (inner === '<br>' || inner === '') {
      lines.push('');
    } else {
      const text = extractInline(el);
      if (text !== '') {
        if (wasPrevParagraph) lines.push('');
        prevWasParagraph = true;
      }
      lines.push(text);
    }
  }

  // Trim leading and trailing blank lines
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

// bodyToHtml, stripped of editor-only artifacts, for injecting into the live
// preview iframe (see resyncPreviewBlockContent in canvas-editor.js). The
// macro-chip divs (image/audio/attribution/etc. placeholders) only make
// sense inside the contenteditable — the real iframe has no way to render
// what they stand for without the full compiler, so rather than leak the
// literal chip label ("🖼 background") into the live slide, they're dropped;
// that macro's real effect still shows up correctly once the edit is saved.
// The blank-line spacer <p class="slide-wysiwyg-blank-line"> is dropped too —
// it has no visible counterpart in the compiled slide (bodyToHtml's own
// comment on it says as much), but only because the *editor's* stylesheet
// specifically zeroes that class out. The real theme doesn't know it and
// gives every <p> a solid background pill for readability against a photo
// background (section[data-darkbg]/[data-lightbg] p in layouts.scss) — left
// in, an empty one of these paragraphs still rendered as a blank colored bar.
//
// A verse-ref line (bodyToHtml's <p class="slide-wysiwyg-verse-ref">, from a
// whole line wrapped in single underscores) gets its grey/italic look purely
// from that editor-only class too — the real compiler instead wraps the
// *inner* text in <cite> before markdown rendering (see
// convertUnderscoreCites in markdown-compiler.js), and it's that <cite>,
// not any class on the <p>, that layouts.scss's cite:not(.attrib) rule
// styles. Reproduced here the same way, so the preview matches Save exactly
// instead of falling back to an unstyled paragraph.
//
// Returns null — not '' — for a block that's *entirely* macro lines (e.g. a
// block that's just a bare image reference): '' would tell the caller to
// blank the live block out, wiping real, already-rendered content (that
// image) the moment this resyncs, for a case this function has no way to
// represent live at all. null instead means "can't preview this — leave
// whatever's already there." A block that's genuinely empty text still
// correctly returns '' via bodyToHtml's own empty-input check below.
function bodyToPreviewHtml(markdown) {
  const html = bodyToHtml(markdown);
  if (!html) return html;
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const hadContent = temp.childNodes.length > 0;
  temp.querySelectorAll('.slide-wysiwyg-macro-line, .slide-wysiwyg-blank-line').forEach((el) => el.remove());
  temp.querySelectorAll('.slide-wysiwyg-verse-ref').forEach((el) => {
    el.classList.remove('slide-wysiwyg-verse-ref');
    const cite = document.createElement('cite');
    cite.innerHTML = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(cite);
  });
  if (hadContent && !temp.childNodes.length) return null;
  return temp.innerHTML;
}

export { bodyToHtml, htmlToBody, bodyToPreviewHtml };
