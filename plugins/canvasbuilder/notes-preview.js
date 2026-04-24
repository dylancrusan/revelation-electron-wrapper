/*
 * Notes markdown renderer.
 * Converts notes content (markdown + inline HTML) to rendered HTML.
 */

// Apply bold/italic markdown to a text segment that doesn't cross HTML tag boundaries.
function inlineMarkdown(text) {
  text = text.replace(/\*\*([^*<>]+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*(?!\*)([^*<>]+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  return text;
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
      html += `<li>${inlineMarkdown(bulletMatch[1])}</li>`;
      continue;
    }

    const numberedMatch = trimmed.match(/^\d+\. (.*)$/);
    if (numberedMatch) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inlineMarkdown(numberedMatch[1])}</li>`;
      continue;
    }

    closeList();

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
