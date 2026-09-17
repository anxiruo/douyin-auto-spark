import 'dotenv/config'
import { chromium, type Browser, type Cookie, type Locator, type Page } from 'playwright'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'
import { acquireRunLock, RuntimeState } from './runtime-state'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const DOUYIN_ACCOUNTS_KEY = 'DOUYIN_ACCOUNTS'
const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const SPARK_MESSAGE_TEMPLATE_KEY = 'SPARK_MESSAGE_TEMPLATE'
const SPARK_STATE_PATH_KEY = 'SPARK_STATE_PATH'
const DRY_RUN_KEY = 'DRY_RUN'
const MAX_SENDS_PER_RUN_KEY = 'MAX_SENDS_PER_RUN'
const SEND_GAP_MIN_SECONDS_KEY = 'SEND_GAP_MIN_SECONDS'
const SEND_GAP_MAX_SECONDS_KEY = 'SEND_GAP_MAX_SECONDS'
const FAILURE_SCREENSHOT_DIRECTORY = 'artifacts'

const CHAT_PAGE_READY_TIMEOUT = 30000
const CHAT_PAGE_IDLE_TIMEOUT = 10000
const SEARCH_RESULT_TIMEOUT = 5000
const SEARCH_RETRY_LIMIT = 3
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_INPUT_RESET_DELAY = 500
const SEND_VERIFICATION_TIMEOUT = 10000
const MANUAL_VERIFICATION_TIMEOUT = 5 * 60 * 1000
const BROWSER_STATE_DIRECTORY = 'data/browser-state'
const SAFETY_WARNING_PATTERN =
  /(操作频繁|访问过于频繁|安全验证|请完成验证|滑块验证|账号存在风险|短信验证)/
const MANUAL_VERIFICATION_PATTERN = /(安全验证|请完成验证|滑块验证|短信验证)/
const HARD_STOP_WARNING_PATTERN = /(操作频繁|访问过于频繁|账号存在风险)/

const MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const MESSAGE_TEMPLATE_PLACEHOLDERS = [
  'account',
  'friend',
  'yiyan',
  'from',
  'date',
  'time',
  'weekday',
] as const

type MessageTemplatePlaceholder = (typeof MESSAGE_TEMPLATE_PLACEHOLDERS)[number]

interface DouyinAccount {
  name: string
  cookies: Cookie[]
  targetNames: string[]
  messageTemplate: string | undefined
}

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const dryRun = resolveBooleanEnvironment(DRY_RUN_KEY, true)
  const maxSendsPerRun = resolvePositiveIntegerEnvironment(MAX_SENDS_PER_RUN_KEY, 10)
  const sendGapMinSeconds = resolveNonNegativeIntegerEnvironment(SEND_GAP_MIN_SECONDS_KEY, 8)
  const sendGapMaxSeconds = resolveNonNegativeIntegerEnvironment(SEND_GAP_MAX_SECONDS_KEY, 15)
  if (sendGapMaxSeconds < sendGapMinSeconds) {
    throw new Error(`${SEND_GAP_MAX_SECONDS_KEY} 不能小于 ${SEND_GAP_MIN_SECONDS_KEY}`)
  }
  const globalMessageTemplate = resolveSparkMessageTemplate()
  const accounts = resolveDouyinAccounts(globalMessageTemplate)
  const yiyans = await resolveYiyans()
  const statePath = process.env[SPARK_STATE_PATH_KEY]?.trim() || 'data/spark-state.json'
  const runtimeState = await RuntimeState.load(statePath)
  const releaseRunLock = await acquireRunLock(`${statePath}.lock`)
  let browser: Browser | undefined
  const failures: Error[] = []

  try {
    browser = await chromium.launch({
      headless,
      ...(browserPath ? { executablePath: browserPath } : {}),
    })

    for (const [accountIndex, account] of accounts.entries()) {
      try {
        await runDouyinAccount(
          browser,
          account,
          accountIndex,
          yiyans,
          includeYiyanSource,
          autoClose,
          headless,
          runtimeState,
          dryRun,
          maxSendsPerRun,
          sendGapMinSeconds,
          sendGapMaxSeconds,
        )
      } catch (error) {
        const accountError = toError(error)
        failures.push(
          new Error(`[${account.name}] ${accountError.message}`, { cause: accountError }),
        )
        console.error(`账号执行失败：${account.name}`, accountError)
      }
    }

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('所有账号已执行完成，按回车键关闭浏览器...')
      readline.close()
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个抖音账号执行失败`)
    }
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    try {
      if (browser) await browser.close()
    } finally {
      await releaseRunLock()
    }
  }
}

/**
 * 使用独立浏览器上下文执行一个抖音账号，避免不同账号的 Cookie 相互污染。
 *
 * @param browser Playwright 浏览器实例。
 * @param account 当前执行的抖音账号配置。
 * @param yiyans 可供消息模板使用的一言列表。
 * @param includeYiyanSource 默认消息是否包含一言出处。
 * @param autoClose 执行结束后是否自动关闭浏览器上下文。
 * @returns 账号执行完成后的 Promise。
 */
async function runDouyinAccount(
  browser: Browser,
  account: DouyinAccount,
  accountIndex: number,
  yiyans: Yiyan[],
  includeYiyanSource: boolean,
  autoClose: boolean,
  headless: boolean,
  runtimeState: RuntimeState,
  dryRun: boolean,
  maxSendsPerRun: number,
  sendGapMinSeconds: number,
  sendGapMaxSeconds: number,
): Promise<void> {
  const browserStatePath = join(BROWSER_STATE_DIRECTORY, `account-${accountIndex + 1}.json`)
  const hasBrowserState = await fileExists(browserStatePath)
  const context = await browser.newContext(
    hasBrowserState ? { storageState: browserStatePath } : undefined,
  )
  let page: Page | undefined

  try {
    console.log(`开始执行账号：${account.name}`)
    if (!hasBrowserState) {
      await context.addCookies(account.cookies)
    } else {
      console.log(`[${account.name}] 已加载本地验证会话`)
    }

    page = await context.newPage()
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'domcontentloaded',
    })

    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    const searchVisible = await searchInput
      .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (!searchVisible) {
      throw new Error('聊天页搜索框未出现，Cookie 可能已经失效')
    }

    await waitForChatListReady(page, account.name)

    // 记录未命中的会话，等其余好友都发完再统一报错，避免一个人改名连累当天所有人。
    const missingNames: string[] = []
    const needsYiyan =
      account.messageTemplate === undefined ||
      /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)
    const today = dayjs().tz('Asia/Shanghai').format('YYYY-MM-DD')
    let sentCount = 0

    for (const targetName of account.targetNames) {
      const previousStatus = runtimeState.getStatus(today, account.name, targetName)
      if (previousStatus === 'sent') {
        console.log(`[${account.name}] 今日已经发送，跳过：${targetName}`)
        continue
      }
      if (previousStatus === 'pending') {
        throw new Error(
          `[${account.name}] ${targetName} 存在未确认的发送记录；为避免重复发送，本次任务已停止，请人工检查聊天记录和状态文件`,
        )
      }
      if (sentCount >= maxSendsPerRun) {
        console.log(`[${account.name}] 已达到本轮发送上限 ${maxSendsPerRun}，停止处理剩余好友`)
        break
      }

      await handleSafetyWarning(page, account.name, !headless, browserStatePath)
      console.log(`[${account.name}] 开始搜索会话：${targetName}`)

      const searchResult = await searchConversation(page, searchInput, account.name, targetName)

      if (!searchResult) {
        await captureFailureScreenshot(page, `${account.name}-${targetName}-search`)
        console.log(`[${account.name}] 找不到搜索结果，已跳过：${targetName}`)
        missingNames.push(targetName)
        continue
      }

      await searchResult.getByText(/^(发消息|发私信)$/).click({ timeout: 5000 })
      console.log(`[${account.name}] 已打开私信：${targetName}`)
      await assertConversationTarget(page, targetName)
      await handleSafetyWarning(page, account.name, !headless, browserStatePath)

      const editorInput = page
        .locator(
          '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
        )
        .first()
      await editorInput.waitFor({ state: 'visible', timeout: 10000 })
      await editorInput.click()

      let message: string

      if (account.messageTemplate !== undefined) {
        message = renderMessageTemplate(
          account.messageTemplate,
          account.name,
          targetName,
          needsYiyan ? pickRandomYiyan(yiyans) : undefined,
        )
      } else {
        const yiyan = pickRandomYiyan(yiyans)
        message = includeYiyanSource ? `${yiyan.hitokoto}\n——「${yiyan.from}」` : yiyan.hitokoto
      }

      if (dryRun) {
        console.log(`[${account.name}] 模拟演练通过，未发送消息：${targetName}`)
        continue
      }

      // 在按下 Enter 前落盘 pending；即使进程意外退出，下次也不会盲目重复发送。
      await runtimeState.markPending(today, account.name, targetName)
      await sendMessageAndVerify(page, editorInput, message)
      await runtimeState.markSent(today, account.name, targetName)
      sentCount += 1
      console.log(`[${account.name}] 消息已验证发送成功：${targetName}`)
      await handleSafetyWarning(page, account.name, !headless, browserStatePath)

      const gapSeconds = randomInteger(sendGapMinSeconds, sendGapMaxSeconds)
      if (gapSeconds > 0) {
        console.log(`[${account.name}] 等待 ${gapSeconds} 秒后处理下一位好友`)
        await page.waitForTimeout(gapSeconds * 1000)
      }
    }

    await page.waitForTimeout(5000)

    if (missingNames.length > 0) {
      throw new Error(
        `以下会话未找到，火花可能已经中断：${missingNames.join('、')}。` +
          `好友改昵称是最常见的原因，建议在抖音中为好友设置备注名，` +
          `并把备注名填入账号的 targetNames，这样好友再改昵称也不会影响续火。`,
      )
    }

    await persistBrowserState(page, browserStatePath)
    console.log(`账号执行完成：${account.name}`)
  } catch (error) {
    await captureFailureScreenshot(page, account.name)
    throw error
  } finally {
    if (autoClose) {
      await context.close()
    }
  }
}

async function assertConversationTarget(page: Page, targetName: string): Promise<void> {
  const headerSelectors = [
    '.RightPanelHeadertitleContainer',
    '[class*="RightPanelHeader"]',
    '[class*="rightPanelHeader"]',
  ]

  for (const selector of headerSelectors) {
    const exactTitle = page.locator(selector).getByText(targetName, { exact: true }).first()
    const matched = await exactTitle
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false)
    if (matched) return
  }

  throw new Error(`无法确认当前会话标题为“${targetName}”，已停止发送以防错发`)
}

async function sendMessageAndVerify(
  page: Page,
  editorInput: Locator,
  message: string,
): Promise<void> {
  const exactMessage = page.getByText(message, { exact: true })
  const previousMessageCount = await exactMessage.count()

  await page.keyboard.insertText(message)
  await page.keyboard.press('Enter')

  let editorCleared = await waitForEditorToClear(editorInput, SEND_VERIFICATION_TIMEOUT)
  let messageAppeared = await waitForMessageCountToIncrease(
    exactMessage,
    previousMessageCount,
    SEND_VERIFICATION_TIMEOUT,
  )

  if (!editorCleared && !messageAppeared) {
    // 输入框仍保留完整消息且没有新气泡时，再按一次 Enter 是可判定的安全重试。
    const currentText = await readEditorText(editorInput)
    if (normalizeText(currentText) === normalizeText(message)) {
      await page.keyboard.press('Enter')
      editorCleared = await waitForEditorToClear(editorInput, SEND_VERIFICATION_TIMEOUT)
      messageAppeared = await waitForMessageCountToIncrease(
        exactMessage,
        previousMessageCount,
        SEND_VERIFICATION_TIMEOUT,
      )
    }
  }

  if (!editorCleared || !messageAppeared) {
    const reason = editorCleared
      ? '输入框已清空，但没有确认到新消息气泡，发送结果不明确'
      : '输入框未清空，发送没有得到确认'
    throw new Error(`${reason}；已保留 pending 状态并停止，避免重复发送`)
  }
}

async function waitForEditorToClear(editorInput: Locator, timeout: number): Promise<boolean> {
  return waitUntil(async () => normalizeText(await readEditorText(editorInput)) === '', timeout)
}

async function readEditorText(editorInput: Locator): Promise<string> {
  return editorInput.evaluate((element) => element.textContent ?? '').catch(() => '')
}

async function waitForMessageCountToIncrease(
  locator: Locator,
  previousCount: number,
  timeout: number,
): Promise<boolean> {
  return waitUntil(async () => (await locator.count()) > previousCount, timeout)
}

async function waitUntil(check: () => Promise<boolean>, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function handleSafetyWarning(
  page: Page,
  accountName: string,
  allowManualVerification: boolean,
  browserStatePath: string,
): Promise<void> {
  const initialWarning = await findVisibleSafetyWarning(page)
  if (!initialWarning) return

  if (
    HARD_STOP_WARNING_PATTERN.test(initialWarning) ||
    !MANUAL_VERIFICATION_PATTERN.test(initialWarning) ||
    !allowManualVerification
  ) {
    throw new Error(`检测到平台安全提示“${initialWarning}”，本轮立即停止`)
  }

  console.log(
    `[${accountName}] 检测到“${initialWarning}”，请在浏览器中手动完成验证；程序最多等待 5 分钟`,
  )
  const deadline = Date.now() + MANUAL_VERIFICATION_TIMEOUT

  while (Date.now() < deadline) {
    const warning = await findVisibleSafetyWarning(page)
    if (warning && HARD_STOP_WARNING_PATTERN.test(warning)) {
      throw new Error(`检测到平台安全提示“${warning}”，本轮立即停止`)
    }
    if (!warning) {
      await page.waitForTimeout(1500)
      if (!(await findVisibleSafetyWarning(page))) {
        await persistBrowserState(page, browserStatePath)
        console.log(`[${accountName}] 手动验证已通过，本地会话已保存，继续执行`)
        return
      }
    }
    await page.waitForTimeout(500)
  }

  throw new Error('等待手动验证超时，本轮已停止')
}

async function findVisibleSafetyWarning(page: Page): Promise<string | undefined> {
  const warningCandidates = page.locator(
    '[role="dialog"], [role="alert"], .semi-toast-content, [class*="captcha"], [class*="Captcha"], [class*="verify"], [class*="Verify"]',
  )
  const count = Math.min(await warningCandidates.count(), 30)

  for (let index = 0; index < count; index += 1) {
    const candidate = warningCandidates.nth(index)
    if (!(await candidate.isVisible().catch(() => false))) continue
    const text = await candidate.innerText().catch(() => '')
    const match = text.match(SAFETY_WARNING_PATTERN)
    if (match) return match[1]
  }

  return undefined
}

async function persistBrowserState(page: Page, browserStatePath: string): Promise<void> {
  await mkdir(BROWSER_STATE_DIRECTORY, { recursive: true })
  await page.context().storageState({ path: browserStatePath })
}

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function randomInteger(minimum: number, maximum: number): number {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum
}

/**
 * 等待会话列表真正渲染出数据再开始搜索。
 *
 * 搜索框会先于会话列表渲染，若此时就输入关键词，抖音的搜索索引尚未就绪，
 * 结果面板会一直为空，导致好友被误判成「改名了」。
 *
 * @param page 当前账号的聊天页。
 * @param accountName 账号名称，仅用于日志。
 * @returns 等待结束后的 Promise，超时也不抛错，交给后续搜索重试兜底。
 */
async function waitForChatListReady(page: Page, accountName: string): Promise<void> {
  const conversationListReady = await page
    .locator('[class*="conversation"], [class*="Conversation"]')
    .first()
    .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)

  if (!conversationListReady) {
    console.log(`[${accountName}] 会话列表未在预期时间内出现，将依赖搜索重试兜底`)
  }

  // 会话列表的头像与最近消息还会继续拉取，等网络安静下来搜索命中率更高。
  await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT }).catch(() => {})
}

/**
 * 带重试地搜索会话，避免把「数据还没加载好」误判成「好友改了昵称」。
 *
 * 每一轮都重新清空输入框并等待旧结果消失，防止上一个好友的残留结果被当成命中。
 *
 * @param page 当前账号的聊天页。
 * @param searchInput 聊天页左侧的搜索输入框。
 * @param accountName 账号名称，仅用于日志。
 * @param targetName 需要搜索的好友昵称或备注名。
 * @returns 命中的搜索结果项，全部重试都没命中时返回 undefined。
 */
async function searchConversation(
  page: Page,
  searchInput: Locator,
  accountName: string,
  targetName: string,
): Promise<Locator | undefined> {
  const searchResult = page
    .locator('.SearchPanelitembox')
    .filter({
      has: page.getByText(targetName, { exact: true }),
    })
    .first()

  for (let attempt = 1; attempt <= SEARCH_RETRY_LIMIT; attempt += 1) {
    await searchInput.fill('')
    // 等旧的结果面板收起，否则会读到上一个好友残留的列表项。
    await page
      .locator('.SearchPanelitembox')
      .first()
      .waitFor({ state: 'hidden', timeout: SEARCH_RESULT_TIMEOUT })
      .catch(() => {})
    await page.waitForTimeout(SEARCH_INPUT_RESET_DELAY)
    await searchInput.fill(targetName)

    const searchResultVisible = await searchResult
      .waitFor({ state: 'visible', timeout: SEARCH_RESULT_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (searchResultVisible) {
      return searchResult
    }

    if (attempt < SEARCH_RETRY_LIMIT) {
      console.log(
        `[${accountName}] 第 ${attempt} 次搜索未命中，${SEARCH_RETRY_INTERVAL} 毫秒后重试：${targetName}`,
      )
      await page.waitForTimeout(SEARCH_RETRY_INTERVAL)
    }
  }

  return undefined
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(
  page: Page | undefined,
  accountName: string,
): Promise<void> {
  if (!page || page.isClosed()) {
    return
  }

  try {
    await mkdir(FAILURE_SCREENSHOT_DIRECTORY, { recursive: true })
    const screenshotPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-screenshot-${toSafeFileName(accountName)}.png`
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    })
    console.log(`已保存失败截图：${screenshotPath}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

function resolveBooleanEnvironment(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase()
  if (!value) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${key} 只能配置为 true 或 false`)
}

function resolvePositiveIntegerEnvironment(key: string, defaultValue: number): number {
  const value = resolveNonNegativeIntegerEnvironment(key, defaultValue)
  if (value < 1) throw new Error(`${key} 必须是大于 0 的整数`)
  return value
}

function resolveNonNegativeIntegerEnvironment(key: string, defaultValue: number): number {
  const text = process.env[key]?.trim()
  if (!text) return defaultValue
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} 必须是大于等于 0 的整数`)
  }
  return value
}

/**
 * 解析自定义火花消息模板，未配置时返回 undefined 以沿用默认的一言格式。
 */
function resolveSparkMessageTemplate(): string | undefined {
  const template = process.env[SPARK_MESSAGE_TEMPLATE_KEY]?.trim()

  if (!template) {
    return undefined
  }

  return normalizeMessageTemplate(template, SPARK_MESSAGE_TEMPLATE_KEY)
}

/**
 * 校验并标准化消息模板。
 */
function normalizeMessageTemplate(template: string, sourceName: string): string {
  // 启动时就校验占位符，避免把写错的 {{xxx}} 原样发给好友。
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN)]
        .map((match) => match[1])
        .filter(
          (name) => !MESSAGE_TEMPLATE_PLACEHOLDERS.includes(name as MessageTemplatePlaceholder),
        ),
    ),
  ]

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${sourceName} 中存在未识别的占位符：${unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(
          '、',
        )}。支持的占位符：${MESSAGE_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}`,
    )
  }

  // .env 中难以书写多行值，因此支持用字面 \n 表示换行。
  return template.replace(/\\n/g, '\n')
}

/**
 * 将消息模板渲染为实际发送的文本。
 */
function renderMessageTemplate(
  template: string,
  account: string,
  friend: string,
  yiyan: Yiyan | undefined,
): string {
  // 定时任务跑在 UTC 时区的 runner 上，日期占位符统一按上海时区计算。
  const now = dayjs().tz('Asia/Shanghai')
  const placeholderValues: Record<MessageTemplatePlaceholder, string> = {
    account,
    friend,
    yiyan: yiyan?.hitokoto ?? '',
    from: yiyan?.from ?? '',
    date: now.format('YYYY-MM-DD'),
    time: now.format('HH:mm'),
    weekday: now.format('dddd'),
  }

  return template.replace(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN, (_match, name: string) => {
    return placeholderValues[name as MessageTemplatePlaceholder] ?? ''
  })
}

/**
 * 解析多账号配置。未配置新变量时，回退到旧的单账号变量。
 */
function resolveDouyinAccounts(globalMessageTemplate: string | undefined): DouyinAccount[] {
  const accountsText = process.env[DOUYIN_ACCOUNTS_KEY]?.trim()

  if (!accountsText) {
    return [
      {
        name: '默认账号',
        cookies: resolveLegacyDouyinCookies(),
        targetNames: resolveLegacyDouyinTargetNames(),
        messageTemplate: globalMessageTemplate,
      },
    ]
  }

  const accountsValue = parseJson(accountsText, DOUYIN_ACCOUNTS_KEY)

  if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
    throw new Error(`${DOUYIN_ACCOUNTS_KEY} 必须是非空账号数组 JSON`)
  }

  const accountNames = new Set<string>()

  return accountsValue.map((value, index) => {
    const sourceName = `${DOUYIN_ACCOUNTS_KEY}[${index}]`

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${sourceName} 必须是账号对象`)
    }

    const accountValue = value as Record<string, unknown>
    const name = resolveAccountName(accountValue.name, sourceName)

    if (accountNames.has(name)) {
      throw new Error(`${DOUYIN_ACCOUNTS_KEY} 中存在重复账号名称：${name}`)
    }
    accountNames.add(name)

    return {
      name,
      cookies: resolveCookieArray(accountValue.cookie, `${sourceName}.cookie`),
      targetNames: resolveTargetNameArray(accountValue.targetNames, `${sourceName}.targetNames`),
      messageTemplate: resolveAccountMessageTemplate(
        accountValue.messageTemplate,
        `${sourceName}.messageTemplate`,
        globalMessageTemplate,
      ),
    }
  })
}

function resolveAccountName(value: unknown, sourceName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourceName}.name 必须是非空字符串`)
  }

  return value.trim()
}

function resolveAccountMessageTemplate(
  value: unknown,
  sourceName: string,
  globalMessageTemplate: string | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return globalMessageTemplate
  }

  if (typeof value !== 'string') {
    throw new Error(`${sourceName} 必须是字符串`)
  }

  const template = value.trim()
  return template ? normalizeMessageTemplate(template, sourceName) : globalMessageTemplate
}

/**
 * 解析旧版单账号 Cookie 配置。
 */
function resolveLegacyDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(
      `请设置 ${DOUYIN_ACCOUNTS_KEY}，或继续使用旧版 ${DOUYIN_COOKIE_KEY} 和 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveCookieArray(parseJson(douyinCookieText, DOUYIN_COOKIE_KEY), DOUYIN_COOKIE_KEY)
}

/**
 * 解析旧版单账号会话名称配置。
 */
function resolveLegacyDouyinTargetNames(): string[] {
  const targetNamesText = process.env[DOUYIN_TARGET_NAMES_KEY]?.trim()

  if (!targetNamesText) {
    throw new Error(
      `请设置环境变量 ${DOUYIN_TARGET_NAMES_KEY}，或在 .env 中配置 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveTargetNameArray(
    parseJson(targetNamesText, DOUYIN_TARGET_NAMES_KEY),
    DOUYIN_TARGET_NAMES_KEY,
  )
}

function resolveCookieArray(value: unknown, sourceName: string): Cookie[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${sourceName} 必须是非空 Cookie 数组`)
  }

  return (value as DouyinCookie[]).map(toPlaywrightCookie)
}

function resolveTargetNameArray(value: unknown, sourceName: string): string[] {
  const targetNames = value as unknown[]

  if (
    !Array.isArray(targetNames) ||
    targetNames.length === 0 ||
    targetNames.some((targetName) => typeof targetName !== 'string' || !targetName.trim())
  ) {
    throw new Error(`${sourceName} 必须是非空字符串数组`)
  }

  return targetNames.map((targetName) => (targetName as string).trim())
}

function parseJson(value: string, sourceName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${sourceName} 不是有效的 JSON`, { cause: error })
  }
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})
