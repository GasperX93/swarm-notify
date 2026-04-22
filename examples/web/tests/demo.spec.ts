/**
 * Playwright E2E tests for the Swarm Notify web demo.
 *
 * Requires:
 * - Bee node running on localhost:1633 with a usable stamp
 * - Gnosis Chain RPC access (public endpoint)
 *
 * Run: cd examples/web && npx playwright test
 */
import { test, expect } from '@playwright/test'

test.describe('Web Demo UI', () => {
  let stamp: string

  test.beforeAll(async () => {
    const res = await fetch('http://localhost:1633/stamps')
    const data = (await res.json()) as { stamps: { batchID: string; usable: boolean }[] }
    const usable = data.stamps?.find((s) => s.usable)
    if (!usable) throw new Error('No usable postage stamp on Bee node')
    stamp = usable.batchID
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toContainText('Swarm Notify')
  })

  test('page loads with all sections', async ({ page }) => {
    // Header config
    await expect(page.locator('#cfg-bee')).toHaveValue('http://localhost:1633')
    await expect(page.locator('#cfg-contract')).toHaveValue(/^0x/)

    // Use cases section
    await expect(page.locator('.use-cases h2').first()).toContainText('Integration Scenarios')
    await expect(page.locator('.use-case-card')).toHaveCount(3)
    await expect(page.locator('.use-case-card').nth(0)).toContainText('Sharing with a Stranger')
    await expect(page.locator('.use-case-card').nth(1)).toContainText('Known Contacts')
    await expect(page.locator('.use-case-card').nth(2)).toContainText('Public Inbox')

    // Module checklists visible
    await expect(page.locator('.use-case-card').nth(1).locator('.mod.unused')).toContainText('registry')

    // Both column headers visible
    await expect(page.locator('.grid-header.alice-side h2')).toContainText('Alice')
    await expect(page.locator('.grid-header.bob-side h2')).toContainText('Bob')

    // Step cards have use case tags
    await expect(page.locator('.alice-side .card-header .uc-tags').first()).toContainText('All scenarios')

    // Spacer cells visible for sequential steps
    await expect(page.locator('.spacer-cell').first()).toBeVisible()

    // Event log
    await expect(page.locator('.log-header h3')).toContainText('Event Log')

    // Buttons initially disabled
    await expect(page.locator('#alice-publish')).toBeDisabled()
    await expect(page.locator('#bob-publish')).toBeDisabled()
  })

  test('initialize connects to Bee and generates identities', async ({ page }) => {
    // Fill stamp and initialize
    await page.fill('#cfg-stamp', stamp)
    await page.click('#btn-init')

    // Wait for initialization
    await expect(page.locator('#init-status')).toHaveText('Connected!', { timeout: 10000 })

    // Identity info populated
    await expect(page.locator('#alice-eth')).not.toHaveText('—')
    await expect(page.locator('#bob-eth')).not.toHaveText('—')
    await expect(page.locator('#alice-pub')).not.toHaveText('—')
    await expect(page.locator('#bob-pub')).not.toHaveText('—')

    // Publish buttons enabled
    await expect(page.locator('#alice-publish')).toBeEnabled()
    await expect(page.locator('#bob-publish')).toBeEnabled()

    // Event log has entries
    await expect(page.locator('#event-log .log-entry')).not.toHaveCount(0)
  })

  test('full flow: publish → resolve → send → read', async ({ page }) => {
    // Initialize
    await page.fill('#cfg-stamp', stamp)
    await page.click('#btn-init')
    await expect(page.locator('#init-status')).toHaveText('Connected!', { timeout: 10000 })

    // Step 1: Alice publishes identity
    await page.click('#alice-publish')
    await expect(page.locator('#alice-publish-result')).toContainText('Published', { timeout: 30000 })

    // Step 1: Bob publishes identity
    await page.click('#bob-publish')
    await expect(page.locator('#bob-publish-result')).toContainText('Published', { timeout: 30000 })

    // Step 2: Alice resolves Bob
    await page.click('#alice-resolve')
    await expect(page.locator('#alice-resolve-result')).toContainText('Found Bob', { timeout: 30000 })

    // Step 2: Bob resolves Alice
    await page.click('#bob-resolve')
    await expect(page.locator('#bob-resolve-result')).toContainText('Found Alice', { timeout: 30000 })

    // Step 3: Alice sends message to Bob
    await page.fill('#alice-msg-subject', 'Hello Bob')
    await page.fill('#alice-msg-body', 'This is a test from Playwright!')
    await page.click('#alice-send')
    await expect(page.locator('#alice-send-result')).toContainText('Sent', { timeout: 30000 })

    // Step 4: Bob reads messages
    await page.click('#bob-read')
    await expect(page.locator('#bob-read-result .msg-subject')).toContainText('Hello Bob', { timeout: 30000 })
    await expect(page.locator('#bob-read-result .msg-body')).toContainText('Playwright')

    // Step 7: Bob replies
    await page.fill('#bob-msg-subject', 'Re: Hello Bob')
    await page.fill('#bob-msg-body', 'Got it, thanks!')
    await page.click('#bob-send')
    await expect(page.locator('#bob-send-result')).toContainText('Sent', { timeout: 30000 })

    // Step 7: Alice checks inbox
    await page.click('#alice-inbox')
    await expect(page.locator('#alice-inbox-result .msg-subject')).toContainText('Re: Hello Bob', { timeout: 30000 })
  })

  test('registry flow: poll with no notifications returns empty', async ({ page }) => {
    // Initialize
    await page.fill('#cfg-stamp', stamp)
    await page.click('#btn-init')
    await expect(page.locator('#init-status')).toHaveText('Connected!', { timeout: 10000 })

    // Publish both and resolve
    await page.click('#alice-publish')
    await expect(page.locator('#alice-publish-result')).toContainText('Published', { timeout: 30000 })
    await page.click('#bob-publish')
    await expect(page.locator('#bob-publish-result')).toContainText('Published', { timeout: 30000 })
    await page.click('#bob-resolve')
    await expect(page.locator('#bob-resolve-result')).toContainText('Found Alice', { timeout: 30000 })

    // Bob polls — no notifications for fresh random keys
    await page.click('#bob-poll')
    await expect(page.locator('#bob-poll-result')).toContainText('No notifications', { timeout: 30000 })
  })

  // NOTE: The full registry notify → poll test requires a funded wallet (xDAI on Gnosis Chain).
  // Random keys generated by the demo have no funds. To test the full on-chain flow,
  // use the E2E tests in test/e2e.test.ts which use the funded DEPLOYER_PRIVATE_KEY.

  test('event log records operations', async ({ page }) => {
    await page.fill('#cfg-stamp', stamp)
    await page.click('#btn-init')
    await expect(page.locator('#init-status')).toHaveText('Connected!', { timeout: 10000 })

    // Log should have initialization entries
    const logEntries = page.locator('#event-log .log-entry')
    await expect(logEntries).not.toHaveCount(0)

    // Clear log
    await page.click('#log-clear')
    await expect(logEntries).toHaveCount(0)

    // Publish adds entries
    await page.click('#alice-publish')
    await expect(page.locator('#alice-publish-result')).toContainText('Published', { timeout: 30000 })
    await expect(logEntries).not.toHaveCount(0)

    // Log entries contain Alice tag
    await expect(page.locator('#event-log .log-tag.alice').first()).toContainText('Alice')
  })
})
