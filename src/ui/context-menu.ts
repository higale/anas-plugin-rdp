export type MenuItem = { label: string; disabled?: boolean; danger?: boolean; action(): void } | 'separator';
let active: { menu: HTMLDivElement; trigger: HTMLElement; events: AbortController } | undefined;

export function closeContextMenu(restoreFocus = false) {
  if (!active) return;
  const { menu, trigger, events } = active;
  active = undefined;
  events.abort(); menu.remove();
  if (restoreFocus && trigger.isConnected) trigger.focus();
}

/** A document-local menu; each opening owns its listeners and focus return target. */
export function openContextMenu(trigger: HTMLElement, point: { x: number; y: number }, label: string, items: MenuItem[]) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label);
  for (const item of items) {
    if (item === 'separator') {
      const separator = document.createElement('div'); separator.setAttribute('role', 'separator'); menu.append(separator);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button'; button.tabIndex = -1; button.setAttribute('role', 'menuitem');
    button.textContent = item.label; button.disabled = item.disabled ?? false;
    if (item.danger) button.className = 'danger';
    button.addEventListener('click', () => { closeContextMenu(true); item.action(); });
    menu.append(button);
  }
  menu.style.left = '0px'; menu.style.top = '0px';
  document.body.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(point.x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(point.y, window.innerHeight - bounds.height - 8))}px`;
  const events = new AbortController();
  active = { menu, trigger, events };
  const options = { signal: events.signal };
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  menu.addEventListener('contextmenu', event => event.preventDefault(), options);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeContextMenu(true); }
    else if (event.key === 'Tab') closeContextMenu(true);
    else if (buttons.length && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }, options);
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) closeContextMenu(); }, { ...options, capture: true });
  document.addEventListener('focusin', event => { if (!menu.contains(event.target as Node)) closeContextMenu(); }, options);
  document.addEventListener('scroll', event => { if (!menu.contains(event.target as Node)) closeContextMenu(); }, { ...options, capture: true });
  window.addEventListener('resize', () => closeContextMenu(), options);
  window.addEventListener('blur', () => closeContextMenu(), options);
  buttons[0]?.focus();
}
