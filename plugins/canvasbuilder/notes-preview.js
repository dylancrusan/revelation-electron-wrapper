/*
 * Notes markdown renderer.
 * Converts notes content (markdown + inline HTML) to rendered HTML.
 */

function inlineMarkdown(text) {
  // Bold+italic combined (***text***) has to be handled as its own case,
  // and before every pass below — each of those excludes "<"/">" from what
  // it'll match as content, specifically so it doesn't corrupt a tag an
  // earlier pass already inserted. That's exactly why color used to run
  // first: the moment {#hex:text} became a real <span>, the "***" wrapping
  // it (e.g. from text that's bold+italic+colored all at once) could no
  // longer match across the tag it had just inserted, leaving orphaned
  // literal asterisks that then paired up unpredictably with other
  // asterisks later in the line. Matching *** up front, before anything has
  // inserted a single tag, sidesteps that failure mode entirely for the
  // common case of a colored word that's also bold+italic.
  text = text.replace(/\*\*\*([^*<>]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
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
  // Color spans {#rrggbb:text} or {#rgb:text} — now last, so it can still
  // find and wrap a macro nested inside a bold/italic run from any pass
  // above (none of those exclude "{"/"}"), without being the thing that
  // blocks those passes from matching in the first place.
  text = text.replace(/\{(#[0-9a-fA-F]{3,6}):([^}]+)\}/g, '<span style="color:$1">$2</span>');
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
