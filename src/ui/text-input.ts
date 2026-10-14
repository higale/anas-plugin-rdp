import { t } from './i18n';

export interface TextDraft { text: string; offset: number; state: 'idle' | 'cancelled' | 'failed'; open: boolean }

/** Short receipts make cancellation responsive; never split a Unicode scalar or JSON escape. */
export function textChunk(text: string, offset: number): string {
  let chunk = '', characters = 0;
  for (const character of text.slice(offset)) {
    const next = chunk + character;
    if (++characters > 128 || new TextEncoder().encode(JSON.stringify([{ type: 'text', text: next }])).length > 12000) break;
    chunk = next;
  }
  return chunk;
}

export class TextInput {
  private dialog = document.createElement('dialog');
  private editor = document.createElement('textarea');
  private remaining = document.createElement('textarea');
  private progress = document.createElement('p');
  private warning = document.createElement('p');
  private heading = document.createElement('h2');
  private sendButton = document.createElement('button');
  private cancelButton = document.createElement('button');
  private editButton = document.createElement('button');
  private closeButton = document.createElement('button');
  private offset = 0;
  private state: TextDraft['state'] = 'idle';
  private cancelled = false;
  private pending?: Promise<void>;
  constructor(private begin: () => (text: string) => Promise<void>, private busy: (value: boolean) => void) {
    this.dialog.id = 'text-input-dialog'; this.heading.id = 'text-input-heading';
    this.dialog.setAttribute('aria-labelledby', this.heading.id);
    this.editor.id = 'text-input-content'; this.editor.spellcheck = false;
    this.remaining.id = 'text-input-remaining'; this.remaining.readOnly = true;
    this.progress.setAttribute('role', 'status'); this.warning.setAttribute('role', 'alert');
    const buttons = document.createElement('div'); buttons.className = 'actions';
    for (const button of [this.editButton, this.sendButton, this.cancelButton, this.closeButton]) { button.type = 'button'; buttons.append(button); }
    this.dialog.append(this.heading, this.editor, this.progress, this.warning, this.remaining, buttons);
    document.body.append(this.dialog);
    this.editor.addEventListener('input', () => { this.offset = 0; this.state = 'idle'; this.render(); });
    this.dialog.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void this.submit(); }
    });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.sendButton.addEventListener('click', () => { void this.submit(); });
    this.cancelButton.addEventListener('click', () => { this.cancelled = true; this.render(); });
    this.closeButton.addEventListener('click', () => this.close());
    this.editButton.addEventListener('click', () => {
      this.editor.value = this.editor.value.slice(this.offset); this.offset = 0; this.state = 'idle'; this.render(); this.editor.focus();
    });
    this.render();
  }
  open() { if (!this.dialog.open) this.dialog.showModal(); this.editor.focus(); }
  private close() { this.cancelled = true; this.dialog.close(); }
  async pause() { this.cancelled = true; await this.pending; }
  snapshot(): TextDraft { return { text: this.editor.value, offset: this.offset, state: this.state, open: this.dialog.open }; }
  restore(value?: TextDraft) {
    if (!value) return;
    this.editor.value = value.text; this.offset = value.offset; this.state = value.state;
    this.render(); if (value.open) this.open();
  }
  render() {
    const running = !!this.pending, partial = this.offset > 0 || this.state !== 'idle';
    this.heading.textContent = t('actions.input_text'); this.editor.setAttribute('aria-label', t('text_input.original'));
    this.editor.readOnly = running || partial;
    this.remaining.hidden = !partial; this.remaining.value = this.editor.value.slice(this.offset);
    this.remaining.setAttribute('aria-label', t('text_input.remaining'));
    this.progress.textContent = t(running && this.cancelled ? 'text_input.cancelling' : 'text_input.progress', {
      sent: Array.from(this.editor.value.slice(0, this.offset)).length, total: Array.from(this.editor.value).length });
    this.warning.hidden = this.state === 'idle';
    this.warning.textContent = t(this.state === 'failed' ? 'text_input.failed' : 'text_input.cancelled');
    this.sendButton.textContent = t(this.offset ? 'text_input.send_remaining' : 'text_input.send');
    this.sendButton.disabled = running || !this.editor.value || this.offset === this.editor.value.length || this.state === 'failed';
    this.cancelButton.textContent = t('actions.cancel'); this.cancelButton.hidden = !running; this.cancelButton.disabled = this.cancelled;
    this.editButton.textContent = t('text_input.edit_remaining'); this.editButton.hidden = !partial || running;
    this.closeButton.textContent = t('actions.close');
  }
  private submit(): Promise<void> | undefined {
    if (this.pending || this.sendButton.disabled) return this.pending;
    this.cancelled = false; this.state = 'idle';
    this.pending = Promise.resolve().then(async () => {
      try {
        this.busy(true);
        const send = this.begin();
        while (this.offset < this.editor.value.length && !this.cancelled) {
          const chunk = textChunk(this.editor.value, this.offset);
          if (!chunk || /[\uD800-\uDFFF]/u.test(chunk)) throw new Error('RDP_INVALID_INPUT');
          await send(chunk);
          this.offset += chunk.length; this.render();
        }
        if (this.offset === this.editor.value.length) {
          this.editor.value = ''; this.offset = 0; this.dialog.close();
        } else this.state = 'cancelled';
      } catch { this.state = 'failed'; }
      finally { this.pending = undefined; this.busy(false); this.render(); }
    });
    this.render(); return this.pending;
  }
}
