/// <reference types="vite/client" />

import type { DesktopApi, LocalHostApi } from '../../../../contracts/src/contracts'

declare global {
  interface Window {
    testAgent: DesktopApi
    testAgentLocal: LocalHostApi
  }
}

export {}
