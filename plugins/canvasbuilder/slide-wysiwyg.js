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

// Apply bold/italic inline markdown to a text segment.
function inlineMarkdownToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\*\*([^*<>]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)([^*<>]+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
}

// Walk a DOM node tree and convert to markdown, preserving <u> and styled <span> as HTML.
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
    if (tag === 'strong' || tag === 'b') {
      result += `**${inner}**`;
    } else if (tag === 'em' || tag === 'i') {
      result += `*${inner}*`;
    } else if (tag === 'u') {
      result += `<u>${inner}</u>`;
    } else if (tag === 'span') {
      const style = child.getAttribute('style');
      result += style ? `<span style="${style}">${inner}</span>` : inner;
    } else if (tag === 'br') {
      result += '\n';
    } else {
      result += inner;
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

  const flushList = () => {
    if (!listType || !listItems.length) return;
    const tag = listType;
    const items = listItems.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('');
    blocks.push(`<${tag}>${items}</${tag}>`);
    listType = null;
    listItems = [];
  };

  for (const line of lines) {
    if (isSlideBodyMacro(line)) {
      flushList();
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
      flushList();
      blocks.push('<p><br></p>');
      continue;
    }

    const h3 = trimmed.match(/^### (.+)$/);
    if (h3) { flushList(); blocks.push(`<h3>${inlineMarkdownToHtml(h3[1])}</h3>`); continue; }

    const h2 = trimmed.match(/^## (.+)$/);
    if (h2) { flushList(); blocks.push(`<h2>${inlineMarkdownToHtml(h2[1])}</h2>`); continue; }

    const h1 = trimmed.match(/^# (.+)$/);
    if (h1) { flushList(); blocks.push(`<h1>${inlineMarkdownToHtml(h1[1])}</h1>`); continue; }

    const bullet = trimmed.match(/^- (.*)$/);
    if (bullet) {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = trimmed.match(/^\d+\. (.*)$/);
    if (numbered) {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(numbered[1]);
      continue;
    }

    flushList();
    blocks.push(`<p>${inlineMarkdownToHtml(trimmed)}</p>`);
  }

  flushList();
  return blocks.join('');
}

// Convert contenteditable HTML back to slide body markdown.
function htmlToBody(html) {
  if (!html || !html.trim()) return '';
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const lines = [];

  const extractInline = (el) => inlineHtmlToMarkdown(el.innerHTML || '');

  for (const node of temp.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) lines.push(text);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const el = node;
    const tag = el.tagName.toLowerCase();

    // Macro div — restore original markdown line verbatim
    if (typeof el.dataset.macro === 'string') {
      lines.push(el.dataset.macro);
      continue;
    }

    if (tag === 'h1') { lines.push(`# ${extractInline(el)}`); continue; }
    if (tag === 'h2') { lines.push(`## ${extractInline(el)}`); continue; }
    if (tag === 'h3') { lines.push(`### ${extractInline(el)}`); continue; }

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
      lines.push(text === '' ? '' : text);
    }
  }

  // Trim leading and trailing blank lines
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

export { bodyToHtml, htmlToBody };
