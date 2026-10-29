/** Document-local tooltips also work inside the isolated plugin iframe. */
export function installTooltips(): () => void {
  const tooltip = document.createElement('div');
  tooltip.id = 'rdp-tooltip';
  tooltip.className = 'tooltip';
  tooltip.setAttribute('role', 'tooltip');
  const events = new AbortController();
  const options = { signal: events.signal, capture: true };
  let target: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const find = (value: EventTarget | null) => value instanceof Element ? value.closest<HTMLElement>('[data-tooltip]') : null;
  const visible = (element: HTMLElement) => element.isConnected && !!element.dataset.tooltip?.trim()
    && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0;
  function hide() {
    clearTimeout(timer); timer = undefined;
    if (target?.getAttribute('aria-describedby')?.split(/\s+/).includes(tooltip.id)) {
      const descriptions = (target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tooltip.id);
      if (descriptions.length) target.setAttribute('aria-describedby', descriptions.join(' '));
      else target.removeAttribute('aria-describedby');
    }
    target = undefined;
    tooltip.remove();
  }
  function show() {
    if (!target || !visible(target)) { hide(); return; }
    const label = target.dataset.tooltip!.trim();
    if (tooltip.textContent !== label) tooltip.textContent = label;
    if (!tooltip.isConnected) document.body.append(tooltip);
    const descriptions = new Set((target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    if (!descriptions.has(tooltip.id)) {
      descriptions.add(tooltip.id);
      target.setAttribute('aria-describedby', [...descriptions].join(' '));
    }
    const rect = target.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
    const left = rect.left + (rect.width - tip.width) / 2;
    const top = rect.top - tip.height - 7;
    tooltip.style.left = `${Math.max(8, Math.min(left, window.innerWidth - tip.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top >= 8 ? top : rect.bottom + 7, window.innerHeight - tip.height - 8))}px`;
  }
  function activate(element: HTMLElement | null, immediate = false) {
    if (!element || !visible(element)) { hide(); return; }
    if (element !== target) { hide(); target = element; }
    else if (!immediate) return; // Moving between the icon and its button keeps the hover delay.
    clearTimeout(timer);
    if (immediate) show();
    else timer = setTimeout(show, 450);
  }
  document.addEventListener('pointerover', event => activate(find(event.target)), options);
  document.addEventListener('pointerout', event => {
    if (!(event.relatedTarget instanceof Node) || !target?.contains(event.relatedTarget)) hide();
  }, options);
  document.addEventListener('focusin', event => activate(find(event.target), true), options);
  document.addEventListener('focusout', hide, options);
  document.addEventListener('pointerdown', hide, options);
  document.addEventListener('click', hide, options);
  document.addEventListener('contextmenu', hide, options);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) hide();
  }, options);
  document.addEventListener('scroll', hide, options);
  document.addEventListener('visibilitychange', hide, options);
  window.addEventListener('blur', hide, options);
  window.addEventListener('resize', hide, options);
  const observer = new MutationObserver(records => {
    if (!target) return;
    const current = target;
    const relevant = records.some(record => record.type === 'attributes'
      ? record.target instanceof Element && record.target.contains(current)
      : Array.from(record.removedNodes).some(node => node.contains(current)));
    if (!relevant) return;
    if (!visible(target)) { hide(); return; }
    if (tooltip.isConnected) show();
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip', 'hidden', 'inert'] });
  return () => { events.abort(); observer.disconnect(); hide(); };
}
