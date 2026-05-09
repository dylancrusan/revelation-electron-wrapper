/*
 * Notes markdown renderer.
 * Converts notes content (markdown + inline HTML) to rendered HTML.
 */

function inlineMarkdown(text) {
  // Color spans {#rrggbb:text} or {#rgb:text}
  text = text.replace(/\{(#[0-9a-fA-F]{3,6}):([^}]+)\}/g, '<span style="color:$1">$2</span>');
  // Bold (** or __)
  text = text.replace(/\*\*([^*<>]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_<>]+?)__/g, '<strong>$1</strong>');
  // Italic (* or _)
  text = text.replace(/(?<!\*)\*(?!\*)([^*<>]+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<!_)_(?!_)([^_<>]+?)(?<!_)_(?!_)/g, '<em>$1</em>');
  // Strikethrough (~~)
  text = text.replace(/~~([^~<>]+?)~~/g, '<del>$1</del>');
  // Inline code
  text = text.replace(/`([^`<>]+?)`/g, '<code>$1</code>');
  // Links [text](url)
  text = text.replace(/\[([^\]<>]+?)\]\(([^)<>]+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return text;
}

// Returns the hex color if the entire content is a single {#color:...} span, else null.
// Uses [^}]+ so it does NOT match items with multiple color spans like {#aaa:X}{#bbb:Y}.
function getWrappedColor(content) {
  const m = content.match(/^\{(#[0-9a-fA-F]{3,6}):([^}]+)\}$/);
  return m ? m[1] : null;
}

function renderNotes(raw) {
  if (!raw || !raw.trim()) {
    return '<span class="notes-preview-empty">No notes for this slide</span>';
  }

  const lines = raw.split('\n');
  let html = '';
  let listType = null;

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const bulletMatch = trimmed.match(/^- (.*)$/);
    if (bulletMatch) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      const itemContent = bulletMatch[1];
      const markerColor = getWrappedColor(itemContent);
      const liAttr = markerColor ? ` style="color:${markerColor}"` : '';
      html += `<li${liAttr}>${inlineMarkdown(itemContent)}</li>`;
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+\. (.*)$/);
    if (numberedMatch) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      const itemContent = numberedMatch[1];
      const markerColor = getWrappedColor(itemContent);
      const liAttr = markerColor ? ` style="color:${markerColor}"` : '';
      html += `<li${liAttr}>${inlineMarkdown(itemContent)}</li>`;
      continue;
    }

    closeList();

    const headingMatch = trimmed.match(/^(#{1,3}) (.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html += `<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`;
      continue;
    }

    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      html += '<hr>';
      continue;
    }

    if (!trimmed) {
      html += '<div class="notes-preview-gap"></div>';
      continue;
    }

    html += `<p>${inlineMarkdown(trimmed)}</p>`;
  }

  closeList();
  return html;
}

export { renderNotes };
