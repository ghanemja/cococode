/**
 * Selection dialogs drawn in the live region: approvals, pickers, questions.
 * A dialog is a small state machine fed key events; it resolves a promise
 * when the user confirms or cancels.
 */
import { c, stringWidth, truncate, wrapLine } from './ansi.ts';
import type { Key } from './keys.ts';
import type { Cursor } from './screen.ts';

export interface DialogOption<T> {
  label: string;
  value: T;
  /** Dimmed text after the label. */
  hint?: string;
  /** A free-text entry: the user types into it and the text is returned. */
  input?: boolean;
  placeholder?: string;
}

export interface SelectSpec<T> {
  /** Pre-rendered lines shown above the options (may contain ANSI). */
  header?: string[];
  question?: string;
  options: DialogOption<T>[];
  /** Space toggles, enter confirms the set. */
  multi?: boolean;
  /** Typing narrows the list. */
  filterable?: boolean;
  maxVisible?: number;
  footer?: string;
  initial?: number;
}

export interface SelectResult<T> {
  value: T;
  /** Checked values for multi-select dialogs. */
  values: T[];
  /** Text typed into an input option. */
  text?: string;
}

export interface Dialog {
  render(width: number): { lines: string[]; cursor: Cursor | null };
  /** Returns true when the dialog is finished and should be removed. */
  handleKey(key: Key): boolean;
  cancel(): void;
}

export class SelectDialog<T> implements Dialog {
  private index: number;
  private filter = '';
  private inputText = '';
  private checked = new Set<number>();
  private readonly spec: SelectSpec<T>;
  private readonly resolve: (result: SelectResult<T> | null) => void;
  private done = false;

  constructor(spec: SelectSpec<T>, resolve: (result: SelectResult<T> | null) => void) {
    this.spec = spec;
    this.resolve = resolve;
    this.index = Math.min(Math.max(0, spec.initial ?? 0), Math.max(0, spec.options.length - 1));
  }

  private visibleOptions(): { option: DialogOption<T>; original: number }[] {
    const all = this.spec.options.map((option, original) => ({ option, original }));
    if (!this.spec.filterable || !this.filter) return all;
    const q = this.filter.toLowerCase();
    return all.filter(({ option }) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(q));
  }

  private finish(result: SelectResult<T> | null): boolean {
    if (!this.done) {
      this.done = true;
      this.resolve(result);
    }
    return true;
  }

  cancel(): void {
    this.finish(null);
  }

  handleKey(key: Key): boolean {
    const options = this.visibleOptions();
    const current = options[this.index];
    const typing = Boolean(current?.option.input);

    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return this.finish(null);
    if (key.name === 'up' || (key.ctrl && key.name === 'p') || (key.name === 'tab' && key.shift)) {
      this.index = options.length ? (this.index - 1 + options.length) % options.length : 0;
      return false;
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n') || key.name === 'tab') {
      this.index = options.length ? (this.index + 1) % options.length : 0;
      return false;
    }
    if (key.name === 'return') {
      if (!current) return false;
      if (this.spec.multi) {
        const values = this.spec.options.filter((_, i) => this.checked.has(i)).map((o) => o.value);
        if (current.option.input && this.inputText.trim()) {
          return this.finish({ value: current.option.value, values, text: this.inputText.trim() });
        }
        if (values.length === 0) this.checked.add(current.original);
        const picked = this.spec.options.filter((_, i) => this.checked.has(i)).map((o) => o.value);
        return this.finish({ value: picked[0]!, values: picked });
      }
      return this.finish({ value: current.option.value, values: [current.option.value], text: typing ? this.inputText.trim() : undefined });
    }

    if (typing) {
      if (key.name === 'backspace') this.inputText = this.inputText.slice(0, -1);
      else if (key.name === 'char' && key.text) this.inputText += key.text;
      else if (key.name === 'paste' && key.text) this.inputText += key.text.replace(/\s+/g, ' ');
      else if (key.ctrl && key.name === 'u') this.inputText = '';
      return false;
    }
    if (this.spec.multi && key.name === 'char' && key.text === ' ' && current) {
      if (this.checked.has(current.original)) this.checked.delete(current.original);
      else this.checked.add(current.original);
      return false;
    }
    if (this.spec.filterable) {
      if (key.name === 'backspace') {
        this.filter = this.filter.slice(0, -1);
        this.index = 0;
      } else if (key.name === 'char' && key.text) {
        this.filter += key.text;
        this.index = 0;
      }
      return false;
    }
    // Number keys pick an option directly.
    if (key.name === 'char' && key.text && /^[1-9]$/.test(key.text)) {
      const n = Number(key.text) - 1;
      if (n < options.length) {
        this.index = n;
        const target = options[n]!;
        if (!target.option.input && !this.spec.multi) {
          return this.finish({ value: target.option.value, values: [target.option.value] });
        }
      }
    }
    return false;
  }

  render(width: number): { lines: string[]; cursor: Cursor | null } {
    const lines: string[] = [];
    let cursor: Cursor | null = null;
    for (const h of this.spec.header ?? []) lines.push(h);
    if (this.spec.question) {
      for (const l of wrapLine(c.bold(this.spec.question), width - 1, { indent: ' ' })) lines.push(l);
    }
    if (this.spec.filterable) {
      lines.push(` ${c.dim('Filter:')} ${this.filter}${c.dim(this.filter ? '' : 'type to search')}`);
    }

    const options = this.visibleOptions();
    if (this.index >= options.length) this.index = Math.max(0, options.length - 1);
    const maxVisible = this.spec.maxVisible ?? 10;
    let start = 0;
    if (options.length > maxVisible) {
      start = Math.min(Math.max(0, this.index - Math.floor(maxVisible / 2)), options.length - maxVisible);
    }
    const shown = options.slice(start, start + maxVisible);
    if (start > 0) lines.push(c.dim(`   ↑ ${start} more`));

    shown.forEach(({ option, original }, i) => {
      const position = start + i;
      const selected = position === this.index;
      const pointer = selected ? c.cyan('❯') : ' ';
      const number = this.spec.filterable ? '' : `${position + 1}. `;
      const box = this.spec.multi && !option.input ? (this.checked.has(original) ? '[x] ' : '[ ] ') : '';
      let label = option.label;
      if (option.input) {
        if (selected) {
          const shownText = this.inputText || c.dim(option.placeholder ?? 'type here');
          label = `${option.label}: ${shownText}`;
          const prefixWidth = stringWidth(` ❯ ${number}${box}${option.label}: `);
          cursor = { row: lines.length, col: Math.min(width - 1, prefixWidth + stringWidth(this.inputText)) };
        } else if (this.inputText) {
          label = `${option.label}: ${this.inputText}`;
        }
      }
      const hint = option.hint ? c.dim(`  ${option.hint}`) : '';
      const text = ` ${pointer} ${number}${box}${selected ? c.cyan(label) : label}${hint}`;
      lines.push(truncate(text, width));
    });
    if (start + maxVisible < options.length) lines.push(c.dim(`   ↓ ${options.length - start - maxVisible} more`));
    if (options.length === 0) lines.push(c.dim('   No matches'));

    const footer =
      this.spec.footer ??
      (this.spec.multi ? 'space to toggle · enter to confirm · esc to cancel' : 'enter to select · esc to cancel');
    lines.push(c.dim(` ${footer}`));
    return { lines, cursor };
  }
}
