export type Target = { host: string; port: number; username: string; domain: string };
export type Trust = { host: string; port: number; sha256: string };
export type Profile = Target & { id: string; revision: number; name: string; openMode: 'sidebar' | 'window'; hasPassword: boolean };
