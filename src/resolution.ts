export type Resolution = { desktopWidth: number; desktopHeight: number };
export const DEFAULT_DESKTOP_WIDTH = 1280;
export const DEFAULT_DESKTOP_HEIGHT = 800;

/** Shared by profile storage, connection creation and the editor. */
export function resolution(width: unknown, height: unknown): Resolution {
  const desktopWidth = width === undefined ? DEFAULT_DESKTOP_WIDTH : width;
  const desktopHeight = height === undefined ? DEFAULT_DESKTOP_HEIGHT : height;
  if (typeof desktopWidth !== 'number' || typeof desktopHeight !== 'number'
    || !Number.isInteger(desktopWidth) || !Number.isInteger(desktopHeight)
    || desktopWidth < 200 || desktopWidth > 8192 || desktopWidth % 2 !== 0
    || desktopHeight < 200 || desktopHeight > 8192
    || desktopWidth * desktopHeight > 16 * 1024 * 1024) throw new Error('RDP_INVALID_RESOLUTION');
  return { desktopWidth, desktopHeight };
}
