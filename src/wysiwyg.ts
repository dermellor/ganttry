// Markdown WYSIWYG editor for the item Body field.
//
// The editor edits *rendered* Markdown inside a contenteditable surface —
// headings show large, bold shows bold, lists indent — while the stored value
// stays plain Markdown so it round-trips through the model, the DB, and
// the HTML export unchanged. Markdown in (via `marked`) → HTML editing → Markdown
// out (via `turndown`).
//
// Integration is intentionally dumb: the caller keeps a hidden <textarea> whose
// value we overwrite on every change and from which the rest of the form
// pipeline (FormData → applyItemForm) reads as before.

import { marked } from 'marked';
import TurndownService from 'turndown';
import { el, Prose } from './design-system';
import './styles/wysiwyg.css';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});

export interface MarkdownEditor {
  /** Current content as Markdown. */
  getMarkdown(): string;
  /** Replace the content from a Markdown string. */
  setMarkdown(md: string): void;
  /** Root element to insert into the DOM. */
  el: HTMLElement;
}

type BlockKind = 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'quote' | 'code';

// Markers that, typed at the start of a block and followed by space, convert the
// block — the "type Markdown, see formatting" behaviour.
const LINE_MARKERS: Record<string, { kind: BlockKind; len: number }> = {
  '#': { kind: 'h1', len: 1 },
  '##': { kind: 'h2', len: 2 },
  '###': { kind: 'h3', len: 3 },
  '-': { kind: 'ul', len: 1 },
  '*': { kind: 'ul', len: 1 },
  '1.': { kind: 'ol', len: 2 },
  '>': { kind: 'quote', len: 1 },
};

export function createMarkdownEditor(initialMarkdown: string, onChange: () => void): MarkdownEditor {
  // The frame carries the border and the focus tint, exactly as a ChipBox does
  // for the bare input inside it; the surface is the `Prose` component in its
  // editable mode, so a note reads the same while it is being typed as it does
  // once the form is closed.
  const surface = Prose({ editable: true, className: 'wysiwyg-surface' });
  surface.contentEditable = 'true';
  surface.spellcheck = false;
  surface.innerHTML = renderMd(initialMarkdown);

  const root = el('div', { class: 'wysiwyg' }, surface);

  function renderMd(md: string): string {
    const html = marked.parse(md ?? '', { async: false }) as string;
    return html.trim() || '<p><br></p>';
  }

  function sync(): void {
    onChange();
  }

  // The nearest block-level element the caret sits in, bounded by the surface.
  function currentBlock(node: Node | null): HTMLElement | null {
    let el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    const blocks = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE']);
    while (el && el !== surface) {
      if (blocks.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function applyFormat(kind: BlockKind | 'bold' | 'italic' | 'link'): void {
    switch (kind) {
      case 'bold':
        document.execCommand('bold');
        break;
      case 'italic':
        document.execCommand('italic');
        break;
      case 'h1':
      case 'h2':
      case 'h3': {
        const tag = kind.toUpperCase();
        const block = currentBlock(window.getSelection()?.anchorNode ?? null);
        // Toggle: applying the same heading again reverts to a paragraph.
        document.execCommand('formatBlock', false, block?.tagName === tag ? 'P' : tag);
        break;
      }
      case 'quote':
        document.execCommand('formatBlock', false, 'BLOCKQUOTE');
        break;
      case 'ul':
        document.execCommand('insertUnorderedList');
        break;
      case 'ol':
        document.execCommand('insertOrderedList');
        break;
      case 'code':
        document.execCommand('formatBlock', false, 'PRE');
        break;
      case 'link': {
        const url = window.prompt('Link-URL:');
        if (url) document.execCommand('createLink', false, url);
        break;
      }
    }
  }

  // Markdown shortcut: marker + space at the start of a block converts it.
  surface.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); applyFormat('bold'); sync(); return; }
      if (k === 'i') { e.preventDefault(); applyFormat('italic'); sync(); return; }
      if (k === 'k') { e.preventDefault(); applyFormat('link'); sync(); return; }
    }

    if (e.key !== ' ') return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const block = currentBlock(range.startContainer);
    if (!block) return;
    // Already inside a list/quote? Don't re-trigger.
    if (block.closest('li, blockquote')) return;

    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    const marker = LINE_MARKERS[pre.toString()];
    if (!marker) return;

    e.preventDefault();
    // Remove the marker characters the user just typed, then convert.
    for (let i = 0; i < marker.len; i++) document.execCommand('delete');
    applyFormat(marker.kind);
    sync();
  });

  surface.addEventListener('input', sync);
  // Paste as plain text so external rich formatting doesn't leak in.
  surface.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  });

  return {
    el: root,
    getMarkdown: () => turndown.turndown(surface.innerHTML).trim(),
    setMarkdown: (md: string) => {
      surface.innerHTML = renderMd(md);
    },
  };
}
