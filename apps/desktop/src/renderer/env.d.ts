/// <reference types="vite/client" />

import type { DesktopApi } from '../../../../contracts/src/contracts'

declare global {
  interface Window {
    testAgent: DesktopApi
  }
}

export {}
