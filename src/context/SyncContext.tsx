import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

// Kicks a background Zoho + leads sync on every page load (route change) for
// admin sessions, so the portal mirrors Zoho Books as the admin works instead
// of waiting for the hourly cron. Customers can't trigger it — sync-zoho
// rejects non-admin JWTs — their freshness comes from the cron plus whatever
// admin activity keeps the mirror warm.
//
// Guard rails — the Zoho org allows 10,000 API calls per DAY, shared with
// everything else that talks to Zoho (we exhausted it once on 2026-07-28,
// which killed syncing for the rest of that day):
//   * inFlight ref — navigating mid-run never stacks a second run (per tab).
//   * localStorage stamp — a run started in another tab counts as in-flight.
//   * cooldown — a run that just finished isn't repeated for 2 minutes.
//     A delta run costs ~10–20 Zoho calls, so continuous use all day stays
//     around 2–4k calls, leaving headroom for the daily full sweep
//     (~2 calls per contact) and every other Zoho consumer.

const LAST_SYNC_KEY = 'hwLastSyncAt'
const SYNC_STARTED_KEY = 'hwSyncStartedAt'
const SYNC_COOLDOWN_MS = 120_000
// A run stuck longer than this (tab closed mid-sync, function timeout) stops
// counting as in-flight so syncing can resume.
const STALE_RUN_MS = 3 * 60_000

interface SyncState {
  syncing: boolean
  lastSyncedAt: number | null
  /** Human-readable reason the last sync attempt failed, or null if it succeeded. */
  lastError: string | null
  /** Start a sync now unless one is running; force skips the cooldown. */
  triggerSync: (opts?: { force?: boolean }) => void
}

const SyncContext = createContext<SyncState>({
  syncing: false,
  lastSyncedAt: null,
  lastError: null,
  triggerSync: () => {},
})

// eslint-disable-next-line react-refresh/only-export-components
export function useSync() {
  return useContext(SyncContext)
}

function readStamp(key: string): number {
  try {
    const v = localStorage.getItem(key)
    return v ? Number(v) : 0
  } catch {
    return 0
  }
}

function writeStamp(key: string, value: number | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch {
    // private mode — per-tab guards still apply
  }
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const location = useLocation()
  const [syncing, setSyncing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => {
    const v = readStamp(LAST_SYNC_KEY)
    return v || null
  })
  const [lastError, setLastError] = useState<string | null>(null)
  const inFlight = useRef(false)

  async function triggerSync(opts?: { force?: boolean }) {
    if (!isAdmin) return
    if (inFlight.current) return
    const startedElsewhere = readStamp(SYNC_STARTED_KEY)
    if (startedElsewhere && Date.now() - startedElsewhere < STALE_RUN_MS) return
    if (!opts?.force && Date.now() - readStamp(LAST_SYNC_KEY) < SYNC_COOLDOWN_MS) return

    inFlight.current = true
    setSyncing(true)
    writeStamp(SYNC_STARTED_KEY, Date.now())
    try {
      const { data, error } = await supabase.functions.invoke('sync-zoho', { body: {} })
      if (error) {
        // The edge function returns { error } with its HTTP failure; pull the
        // real message out of the response body so failures aren't silent
        // (a whole afternoon of quota-exhausted syncs once showed nothing
        // but a stale "Last synced" time).
        let message = error.message ?? 'sync failed'
        try {
          const body = await (error as { context?: Response }).context?.json()
          if (body?.error) message = String(body.error)
        } catch { /* body already consumed or not JSON */ }
        console.error('sync-zoho failed:', message)
        setLastError(message)
        return
      }
      // Lead notes are best-effort; ignored if sync-leads isn't deployed.
      try {
        await supabase.functions.invoke('sync-leads', { body: {} })
      } catch {
        // sync-leads not available
      }
      if (data?.synced) {
        const now = Date.now()
        setLastSyncedAt(now)
        setLastError(null)
        writeStamp(LAST_SYNC_KEY, now)
      }
    } finally {
      writeStamp(SYNC_STARTED_KEY, null)
      inFlight.current = false
      setSyncing(false)
    }
  }

  // Every page load kicks a sync: initial load once the profile resolves,
  // then every route change after that.
  useEffect(() => {
    if (!isAdmin) return
    void triggerSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, location.pathname])

  return (
    <SyncContext.Provider value={{ syncing, lastSyncedAt, lastError, triggerSync }}>
      {children}
    </SyncContext.Provider>
  )
}
