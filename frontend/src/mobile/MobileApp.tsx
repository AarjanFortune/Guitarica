import { useEffect, useState } from 'react'
import LiveInputPanel from '../components/LiveInputPanel'
import UploadPanel from '../components/UploadPanel'
import YouTubePanel from '../components/YouTubePanel'
import useSupabaseAuth from '../hooks/useSupabaseAuth'
import { initializeGuitaricaAccount, listNotifications, listRoles, subscribeToAccount } from '../services/jobStore'
import { isSupabaseConfigured, signInWithGoogle, signOut } from '../services/supabaseClient'
import { SourceType, TranscriptionResult } from '../types/transcription'
import { AccountIcon, AdminIcon, BellIcon, HomeIcon, LiveIcon, UploadIcon, YoutubeIcon } from './icons'
import MobileAccountDashboard from './MobileAccountDashboard'
import MobileAdminDashboard from './MobileAdminDashboard'
import MobileAuthSheet from './MobileAuthSheet'
import MobileReport from './MobileReport'
import './Mobile.css'

type Page = 'studio' | 'account' | 'admin'

const SOURCES: Array<{ id: SourceType; label: string; detail: string; icon: () => JSX.Element }> = [
  { id: 'upload', label: 'Audio file', detail: 'Upload a track to transcribe', icon: UploadIcon },
  { id: 'youtube', label: 'YouTube', detail: 'Paste a link', icon: YoutubeIcon },
  { id: 'live', label: 'Live input', detail: 'Play and see it transcribed', icon: LiveIcon },
]

export default function MobileApp() {
  const { session, isAuthReady } = useSupabaseAuth()
  const [page, setPage] = useState<Page>(() => pageFromPath())
  const [activeSource, setActiveSource] = useState<SourceType | null>(null)
  const [result, setResult] = useState<TranscriptionResult | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [unread, setUnread] = useState(0)
  const [showAuth, setShowAuth] = useState(false)
  const isAdmin = roles.includes('admin')

  useEffect(() => {
    if (!session) { setRoles([]); setUnread(0); return }
    const refreshAccount = () => {
      initializeGuitaricaAccount()
        .then(() => Promise.all([listRoles(), listNotifications()]))
        .then(([nextRoles, notifications]) => {
          setRoles(nextRoles)
          setUnread(notifications.filter((item) => !item.read_at).length)
        })
        .catch(() => { setRoles([]); setUnread(0) })
    }
    refreshAccount()
    return subscribeToAccount(session.user.id, refreshAccount)
  }, [session])

  useEffect(() => {
    const onPopState = () => setPage(pageFromPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (nextPage: Page) => {
    const path = nextPage === 'studio' ? '/' : `/${nextPage}`
    if (window.location.pathname !== path) window.history.pushState({}, '', path)
    setPage(nextPage)
  }

  const goHome = () => { setActiveSource(null); setResult(null); navigate('studio') }
  const openSource = (source: SourceType) => { setActiveSource(source); setResult(null) }
  const acceptResult = (nextResult: TranscriptionResult) => setResult(nextResult)
  const openStoredResult = (restored: TranscriptionResult) => { setResult(restored); navigate('studio') }

  const openAccountOrAuth = () => {
    if (session) navigate('account')
    else setShowAuth(true)
  }

  return (
    <div className="m-root">
      <header className="m-header">
        <button type="button" onClick={goHome} style={{ background: 'none', border: 0, display: 'flex' }} aria-label="Guitarica home">
          <img src="/images/logo.svg" alt="Guitarica" />
        </button>
        {isAuthReady && (
          <button type="button" className="m-header-btn" onClick={openAccountOrAuth} aria-label={session ? 'Account' : 'Sign in'}>
            <BellIcon />
            {unread > 0 && <span className="m-notification-dot" />}
          </button>
        )}
      </header>

      <div className="m-content">
        {page === 'studio' && !result && !activeSource && (
          <div>
            <p className="m-eyebrow">Transcription studio</p>
            <h1 className="m-title">Choose source</h1>
            <div className="m-list m-source-grid">
              {SOURCES.map((source) => (
                <button key={source.id} type="button" className="m-source-card" onClick={() => openSource(source.id)}>
                  <span className="m-icon"><source.icon /></span>
                  <span>
                    <strong>{source.label}</strong>
                    <small>{source.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {page === 'studio' && !result && activeSource && (
          <div className="m-panel-frame">
            {activeSource === 'upload' && <UploadPanel onComplete={acceptResult} session={session} />}
            {activeSource === 'youtube' && <YouTubePanel onComplete={acceptResult} session={session} />}
            {activeSource === 'live' && <LiveInputPanel session={session} />}
          </div>
        )}

        {page === 'studio' && result && <MobileReport result={result} onReset={goHome} />}

        {page === 'account' && session && (
          <MobileAccountDashboard session={session} onOpenResult={openStoredResult} onSignOut={() => { void signOut().then(goHome) }} />
        )}

        {page === 'admin' && session && isAdmin && <MobileAdminDashboard onOpenResult={openStoredResult} />}

        {page !== 'studio' && (!session || (page === 'admin' && !isAdmin)) && (
          <div className="m-empty">
            <strong style={{ display: 'block', marginBottom: 12 }}>Account access required</strong>
            <button type="button" className="m-button secondary" onClick={goHome}>Back to studio</button>
          </div>
        )}
      </div>

      <nav className="m-navbar" aria-label="Sections">
        <button type="button" className={page === 'studio' ? 'active' : ''} onClick={goHome}><HomeIcon /><span>Studio</span></button>
        <button type="button" className={page === 'account' ? 'active' : ''} onClick={openAccountOrAuth}><AccountIcon /><span>Account</span></button>
        {isAdmin && <button type="button" className={page === 'admin' ? 'active' : ''} onClick={() => navigate('admin')}><AdminIcon /><span>Admin</span></button>}
      </nav>

      {showAuth && !session && (
        <MobileAuthSheet
          onClose={() => setShowAuth(false)}
          onSignInWithGoogle={() => { if (isSupabaseConfigured) void signInWithGoogle() }}
        />
      )}
    </div>
  )
}

function pageFromPath(): Page {
  if (window.location.pathname.startsWith('/admin')) return 'admin'
  if (window.location.pathname.startsWith('/account')) return 'account'
  return 'studio'
}
