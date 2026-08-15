import { _electron as electron } from 'playwright-core'

const app = await electron.launch({ args: ['.'] })
try {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const body = await window.textContent('body')
  console.log('BODY_HAS_CIMDEV', body.includes('CIMDEV Test Agent'))
  console.log('BODY_HAS_LOCAL_HOST', body.includes('本机 Host'))
} finally {
  await app.close()
}
