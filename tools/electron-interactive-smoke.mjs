import { _electron as electron } from 'playwright-core'

const projectPath = process.argv[2] ?? 'C:\\works\\cimdev-test-agent\\services\\control-server'

const app = await electron.launch({ args: ['.'] })
try {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  await window.fill('input[aria-label="项目目录"]', projectPath)
  await window.fill('input[aria-label="系统名称"]', 'control-server')
  await window.fill('input[aria-label="版本"]', '0.1.0')

  const uiToggle = window.locator('.checks button').filter({ hasText: 'UI 测试' }).first()
  await uiToggle.click()

  const start = window.locator('button.dark-button').first()
  await window.waitForFunction(() => {
    const button = document.querySelector('button.dark-button')
    return button !== null && !button.disabled
  }, { timeout: 30_000 })

  await start.click()

  await window.waitForFunction(() => {
    const numbers = document.querySelectorAll('.report-number strong')
    return numbers.length > 0 && numbers[0]?.textContent?.trim() === '21'
  }, { timeout: 240_000 })

  const passed = await window.locator('.report-number strong').first().textContent()
  console.log('INTERACTIVE_SMOKE_PASSED', passed?.trim())
} finally {
  await app.close()
}
