/**
 * Wallet session persistence.
 *
 * ## Why sessionStorage and not localStorage
 *
 * Issue #477 requires the connected **public key** to survive a page refresh
 * without writing anything sensitive to disk that outlives the tab. A Stellar
 * public key is a public identifier, but persisting it in `localStorage` makes
 * a wallet "sticky" across browser restarts and across every tab on a shared
 * machine — a real footgun on a shared desktop. `sessionStorage` is scoped to
 * the tab and cleared when it closes.
 *
 * ## What is never persisted
 *
 * The Ed25519 **secret key** is deliberately absent from this module. It lives
 * only in `WalletContext` state for the lifetime of the page, which is why a
 * secret-key session has to ask the user to re-enter it after a refresh. Any
 * attempt to write it here would be a critical security regression, so the
 * storage surface below is typed to make that impossible to express.
 */

import { Networks } from '@stellar/stellar-sdk'

export type ConnectionMethod = 'freighter' | 'secret-key'

export interface WalletSession {
  publicKey: string
  method: ConnectionMethod
  /** Network observed at connect time, used to detect a later mismatch. */
  network: Networks | null
}

const KEY_PUBKEY = 'wallet_pubkey'
const KEY_PUBKEY_LEGACY = 'walletAddress'
const KEY_METHOD = 'wallet_connection_method'
const KEY_NETWORK = 'wallet_network'
const KEY_WIZARD = 'wallet_wizard_completed'

/**
 * All reads and writes are wrapped because `sessionStorage` throws in a few
 * real environments: Safari private browsing historically threw on write, and
 * a fully disabled-cookies profile throws on read. Losing persistence is a
 * degraded-but-working state, never a crash.
 */
function safeGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // Persistence is a convenience — a private-mode failure must not break the app.
  }
}

function safeRemove(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    // See safeGet.
  }
}

/**
 * Reads a session that was written by an older build.
 *
 * `localStorage` was used before #477. Migrating on read (rather than
 * clearing) means a user who reloads once across the deploy keeps their session
 * instead of being silently logged out — and the legacy keys are removed
 * immediately afterwards so the migration happens at most once.
 */
function readLegacySession(): WalletSession | null {
  let publicKey: string | null = null
  let method: ConnectionMethod | null = null
  try {
    publicKey = window.localStorage.getItem(KEY_PUBKEY) ?? window.localStorage.getItem(KEY_PUBKEY_LEGACY)
    const storedMethod = window.localStorage.getItem(KEY_METHOD)
    method = storedMethod === 'freighter' || storedMethod === 'secret-key' ? storedMethod : null
  } catch {
    return null
  }
  if (!publicKey) return null

  // A pre-#477 session has no recorded method. Freighter is the only method
  // that can be silently resumed, so treat the legacy session as a Freighter
  // one and let auto-reconnect confirm or discard it.
  const session: WalletSession = { publicKey, method: method ?? 'freighter', network: null }

  try {
    window.localStorage.removeItem(KEY_PUBKEY)
    window.localStorage.removeItem(KEY_PUBKEY_LEGACY)
    window.localStorage.removeItem(KEY_METHOD)
  } catch {
    // Best effort.
  }
  return session
}

/** The persisted session for this tab, or null when there is none. */
export function readWalletSession(): WalletSession | null {
  const publicKey = safeGet(KEY_PUBKEY)
  if (!publicKey) return readLegacySession()

  const storedMethod = safeGet(KEY_METHOD)
  const method: ConnectionMethod =
    storedMethod === 'secret-key' ? 'secret-key' : storedMethod === 'freighter' ? 'freighter' : 'freighter'
  const network = (safeGet(KEY_NETWORK) as Networks | null) ?? null

  return { publicKey, method, network }
}

export function writeWalletSession(session: WalletSession): void {
  safeSet(KEY_PUBKEY, session.publicKey)
  safeSet(KEY_METHOD, session.method)
  if (session.network) {
    safeSet(KEY_NETWORK, session.network)
  } else {
    safeRemove(KEY_NETWORK)
  }
}

/**
 * Clears every wallet key.
 *
 * Note there is deliberately no way to write a secret key through this module,
 * so a leaked call site cannot persist one even by accident.
 */
export function clearWalletSession(): void {
  safeRemove(KEY_PUBKEY)
  safeRemove(KEY_METHOD)
  safeRemove(KEY_NETWORK)
  try {
    window.localStorage.removeItem(KEY_PUBKEY)
    window.localStorage.removeItem(KEY_PUBKEY_LEGACY)
    window.localStorage.removeItem(KEY_METHOD)
  } catch {
    // See safeGet.
  }
}

/**
 * Whether the onboarding wizard has been dismissed.
 *
 * This is a UI preference, not session data: keeping it in `localStorage`
 * stops every user from being shown the wizard on each new tab.
 */
export function hasCompletedWizardPreference(): boolean {
  try {
    return window.localStorage.getItem(KEY_WIZARD) === 'true'
  } catch {
    return false
  }
}

export function setCompletedWizardPreference(): void {
  try {
    window.localStorage.setItem(KEY_WIZARD, 'true')
  } catch {
    // See safeGet.
  }
}

// ── Session expiry timer (#828) ──────────────────────────────────────────────

export interface SessionConfig {
  /** How long a session lasts in ms. Default: 3 600 000 (1 hour). */
  sessionTtlMs?: number
  /** How far before expiry the warning fires. Default: 120 000 (2 min). */
  warningBeforeExpiryMs?: number
  /** Minimum ms between activity-driven extensions. Default: 30 000. */
  extensionThrottleMs?: number
}

type TimerCallback = () => void

const DEFAULT_SESSION_TTL_MS = 3_600_000
const DEFAULT_WARNING_BEFORE_EXPIRY_MS = 120_000
const DEFAULT_EXTENSION_THROTTLE_MS = 30_000

/**
 * Tracks wallet session lifetime and fires callbacks before expiry and on
 * expiry. Activity (click, keydown, scroll) extends the session subject to
 * a throttle so that automated polling cannot reset the clock constantly.
 *
 * Usage:
 *   const timer = new SessionTimer({ onWarning: showModal, onExpiry: signOut })
 *   timer.start()
 *   // later:
 *   timer.stop()
 */
export class SessionTimer {
  private readonly sessionTtlMs: number
  private readonly warningBeforeExpiryMs: number
  private readonly extensionThrottleMs: number

  private warningCbs: TimerCallback[] = []
  private expiryCbs: TimerCallback[] = []

  private warningTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null

  private sessionStart = 0
  private lastExtensionAt = 0
  private running = false

  private readonly boundOnActivity: () => void

  constructor(config: SessionConfig = {}) {
    this.sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.warningBeforeExpiryMs =
      config.warningBeforeExpiryMs ?? DEFAULT_WARNING_BEFORE_EXPIRY_MS
    this.extensionThrottleMs =
      config.extensionThrottleMs ?? DEFAULT_EXTENSION_THROTTLE_MS
    this.boundOnActivity = this._onActivity.bind(this)
  }

  onWarning(cb: TimerCallback): this {
    this.warningCbs.push(cb)
    return this
  }

  onExpiry(cb: TimerCallback): this {
    this.expiryCbs.push(cb)
    return this
  }

  getTimeUntilExpiry(): number {
    if (!this.running) return 0
    const elapsed = Date.now() - this.sessionStart
    return Math.max(0, this.sessionTtlMs - elapsed)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.sessionStart = Date.now()
    this.lastExtensionAt = this.sessionStart
    this._scheduleTimers()
    this._attachActivityListeners()
  }

  extendSession(): void {
    if (!this.running) return
    this.sessionStart = Date.now()
    this.lastExtensionAt = this.sessionStart
    this._clearTimers()
    this._scheduleTimers()
  }

  stop(): void {
    this.running = false
    this._clearTimers()
    this._detachActivityListeners()
  }

  private _scheduleTimers(): void {
    const warningDelay = this.sessionTtlMs - this.warningBeforeExpiryMs
    this.warningTimer = setTimeout(() => {
      this.warningCbs.forEach((cb) => cb())
    }, Math.max(0, warningDelay))

    this.expiryTimer = setTimeout(() => {
      this.running = false
      this._detachActivityListeners()
      this.expiryCbs.forEach((cb) => cb())
    }, this.sessionTtlMs)
  }

  private _clearTimers(): void {
    if (this.warningTimer !== null) {
      clearTimeout(this.warningTimer)
      this.warningTimer = null
    }
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  private _onActivity(): void {
    const now = Date.now()
    if (now - this.lastExtensionAt < this.extensionThrottleMs) return
    this.extendSession()
  }

  private _attachActivityListeners(): void {
    if (typeof window === 'undefined') return
    window.addEventListener('click', this.boundOnActivity, { passive: true })
    window.addEventListener('keydown', this.boundOnActivity, { passive: true })
    window.addEventListener('scroll', this.boundOnActivity, { passive: true })
  }

  private _detachActivityListeners(): void {
    if (typeof window === 'undefined') return
    window.removeEventListener('click', this.boundOnActivity)
    window.removeEventListener('keydown', this.boundOnActivity)
    window.removeEventListener('scroll', this.boundOnActivity)
  }
}
