declare module '*iron-remote-desktop-rdp.js' {
  export function init(level: string): Promise<void>;
  export const Backend: unknown;
}
