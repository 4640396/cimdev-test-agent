// Lightweight type surface for the vendored DSH packages. Runtime resolution is
// handled by Vite/Vitest aliases; these declarations keep our strict TS build
// from typechecking the entire upstream Cordis source tree.

declare module '@cimdev/harness/cordis' {
  export class Context {
    plugin(...args: unknown[]): Promise<any>
    fiber: { dispose(): void | Promise<void> }
    sessions: any
    sessionPersistence: any
    storage: any
    storageDomain: any
    workspaceRegistry: any
    sandbox: any
    provide(...args: unknown[]): void
  }
}

declare module '@cimdev/harness/dsh-sandbox-local' {
  export default class LocalSandboxProvider {}
}


declare module '@cimdev/harness/dsh-session' {
  export function SessionId(id: string): any
  export type Session = any
  export type SessionEvent = any
  export default class SessionStore {}
}

declare module '@cimdev/harness/dsh-session-persistence-jsonl' {
  export default class JsonlSessionPersistence {}
}

declare module '@cimdev/harness/dsh-storage' {
  export class Storage {}
  export default Storage
}

declare module '@cimdev/harness/dsh-storage-domain' {
  export default class StorageDomain {}
  export class DomainFacility {
    constructor(ctx: any, config: any)
  }
}

declare module '@cimdev/harness/dsh-storage-json' {
  export const name: string
  export const inject: string[]
  export function apply(ctx: any, config: { root: string }): void
  export class JsonStorageBackend {
    constructor(root: string)
  }
}

declare module '@cimdev/harness/dsh-workspace' {
  export function WorkspaceId(id: string): any
  export default class WorkspaceRegistry {}
}
