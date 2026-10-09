export type Target = { host: string; port: number; username: string; domain: string };
export type Trust = { host: string; port: number; sha256: string };
export type Profile = Target & { id: string; revision: number; name: string; openMode: 'sidebar' | 'window'; runInBackground: boolean; hasPassword: boolean };

/** Non-secret metadata for running resources, independent of their pages. */
export type SessionSummary = { id: string; state: string; profile: Omit<Profile, 'revision' | 'hasPassword'> };

export type RuntimeState = { sessions: SessionSummary[]; openProfiles: string[]; editingProfiles: string[]; selection?: { id: string; token: string } };
export type CallContext = { caller: { panelId: string; instanceId: string } | null; views: { panelId: string; instanceId: string; location: 'sidebar' | 'window' }[] };
