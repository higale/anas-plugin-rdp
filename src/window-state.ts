/** Host screen coordinates are DIP offsets, independent of the CSS viewport size. */
export interface WindowPlacement { displayId: number; x: number; y: number }
/** The host-assigned plugin viewport in CSS pixels, independent of remote frames. */
export interface WindowState { width: number; height: number; placement?: WindowPlacement }

export function requireWindowState(value: unknown): WindowState {
  const state = value as Partial<WindowState> | null;
  if (!state || ![state.width, state.height].every(size => typeof size === 'number' && Number.isFinite(size) && size > 0 && size <= 32768)) throw new Error('RDP_INVALID_WINDOW_STATE');
  const placement = state.placement;
  if (placement !== undefined && (!placement || !Number.isSafeInteger(placement.displayId)
    || ![placement.x, placement.y].every(offset => typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 1_000_000))) throw new Error('RDP_INVALID_WINDOW_STATE');
  return { width: state.width!, height: state.height!, ...(placement ? { placement: { displayId: placement.displayId, x: placement.x, y: placement.y } } : {}) };
}
