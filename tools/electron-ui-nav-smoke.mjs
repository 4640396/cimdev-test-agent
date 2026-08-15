import { _electron as electron } from 'playwright-core'

const projectPath = process.argv[2] ?? 'C:\\works\\cimdev-test-agent\\tools\\node-sample-project'

const app = await electron.launch({ args: ['.'] })
try {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  const pathInput = window.locator('input[aria-label="项目目录"]')
  await pathInput.fill(projectPath)

  const systemInput = window.locator('input[aria-label="系统名称"]')
  await window.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="系统名称"]')
    return input !== null && input.value.trim().length > 0
  }, undefined, { timeout: 15_000 })

  const detectedSystem = await systemInput.inputValue()
  console.log('AUTO_DETECT_SYSTEM', detectedSystem)

  async function assertDetail(title) {
    await window.locator(`.detail-title:has-text("${title}")`).waitFor({ state: 'visible', timeout: 10_000 })
    await window.locator('.back').waitFor({ state: 'visible', timeout: 10_000 })
  }

  await window.locator('.plan-card').click()
  await assertDetail('测试计划')
  await window.locator('.back').click()

  await window.locator('.dispatch-card').click()
  await assertDetail('执行过程')
  await window.locator('.back').click()

  await window.locator('.report-card').click()
  await assertDetail('测试报告')

  console.log('UI_NAV_SMOKE_PASS true')
} finally {
  await app.close()
}
