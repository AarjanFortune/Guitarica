import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import AccountMenu from './components/AccountMenu'
import AccountDashboard from './components/AccountDashboard'
import AdminDashboard from './components/AdminDashboard'
import IntroLoader from './components/IntroLoader'
import LiveInputPanel from './components/LiveInputPanel'
import SourceMenu from './components/SourceMenu'
import SourceTabs from './components/SourceTabs'
import TranscriptionReport from './components/TranscriptionReport'
import UploadPanel from './components/UploadPanel'
import VisualCalibrator from './components/VisualCalibrator'
import YouTubePanel from './components/YouTubePanel'
import useSupabaseAuth from './hooks/useSupabaseAuth'
import { initializeGuitaricaAccount, listNotifications, listRoles, subscribeToAccount } from './services/jobStore'
import { isSupabaseConfigured, signInWithGoogle, signOut } from './services/supabaseClient'
import { SourceType, TranscriptionResult } from './types/transcription'
import {
  DEFAULT_VISUAL_CONFIG,
  mergeVisualConfig,
  VisualConfig,
  visualStyle,
} from './visualConfig'

const VISUAL_CONFIG_KEY = 'guitarica.visual-config.v3'

export default function App() {
  const [showLoader, setShowLoader] = useState(true)
  const [view, setView] = useState<'menu' | 'studio'>('menu')
  const [page, setPage] = useState<'main' | 'account' | 'admin'>(() => pageFromPath())
  const [activeSource, setActiveSource] = useState<SourceType>('upload')
  const [result, setResult] = useState<TranscriptionResult | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [unreadNotifications, setUnreadNotifications] = useState(0)
  const [showCalibrator, setShowCalibrator] = useState(false)
  const { session, isAuthReady } = useSupabaseAuth()
  const [visualConfig, setVisualConfig] = useState<VisualConfig>(() => {
    try {
      return mergeVisualConfig(JSON.parse(localStorage.getItem(VISUAL_CONFIG_KEY) || 'null'))
    } catch {
      return DEFAULT_VISUAL_CONFIG
    }
  })
  const soundRef = useRef<HTMLAudioElement | null>(null)
  const soundUnlockedRef = useRef(false)
  const debugSequenceRef = useRef('')

  useEffect(() => {
    const sound = new Audio('/images/GEF.wav')
    sound.preload = 'auto'
    sound.volume = 0.55
    soundRef.current = sound
    return () => {
      sound.pause()
      soundRef.current = null
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(VISUAL_CONFIG_KEY, JSON.stringify(visualConfig))
  }, [visualConfig])

  useEffect(() => {
    if (!session) { setRoles([]); setUnreadNotifications(0); return }
    // subscribeToAccount fires refreshAccount on every realtime job/notification
    // event, so overlapping calls are normal. Without requestId, a slow earlier
    // call landing *after* a newer one would stomp fresh state with stale
    // data -- including wiping a real admin's roles back to [] because an
    // in-flight refresh from moments ago finally settled. Roles and
    // notifications are also now independent: a notifications hiccup used to
    // wipe roles too because both awaited the same Promise.all.
    let requestId = 0
    const refreshAccount = () => {
      const thisRequest = ++requestId
      initializeGuitaricaAccount()
        .then(() => {
          if (thisRequest !== requestId) return
          listRoles()
            .then((nextRoles) => { if (thisRequest === requestId) setRoles(nextRoles) })
            .catch(() => { if (thisRequest === requestId) setRoles([]) })
          listNotifications()
            .then((notifications) => {
              if (thisRequest === requestId) setUnreadNotifications(notifications.filter((item) => !item.read_at).length)
            })
            .catch(() => { if (thisRequest === requestId) setUnreadNotifications(0) })
        })
        .catch(() => {
          if (thisRequest !== requestId) return
          setRoles([])
          setUnreadNotifications(0)
        })
    }
    refreshAccount()
    return subscribeToAccount(session.user.id, refreshAccount)
  }, [session])

  useEffect(() => {
    const onPopState = () => setPage(pageFromPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    const handleDebugShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        setShowCalibrator((current) => !current)
        return
      }

      const activeTag = document.activeElement?.tagName.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return
      debugSequenceRef.current = `${debugSequenceRef.current}${event.key.toLowerCase()}`.slice(-10)
      if (debugSequenceRef.current === 'studiomode') {
        setShowCalibrator((current) => !current)
        debugSequenceRef.current = ''
      }
    }

    window.addEventListener('keydown', handleDebugShortcut)
    return () => window.removeEventListener('keydown', handleDebugShortcut)
  }, [])

  const playFeedback = useCallback(() => {
    const sound = soundRef.current
    if (!sound) return
    sound.currentTime = 0
    sound.play().catch(() => undefined)
  }, [])

  const unlockFeedback = useCallback(() => {
    const sound = soundRef.current
    if (!sound || soundUnlockedRef.current) return
    sound.muted = true
    sound.play().then(() => {
      sound.pause()
      sound.currentTime = 0
      sound.muted = false
      soundUnlockedRef.current = true
    }).catch(() => {
      sound.muted = false
    })
  }, [])

  const reset = () => setResult(null)

  const acceptResult = (nextResult: TranscriptionResult) => {
    setResult(nextResult)
    playFeedback()

  }

  const openSource = (source: SourceType) => {
    unlockFeedback()
    setActiveSource(source)
    setResult(null)
    navigate('main')
    setView('studio')
  }

  const openMenu = () => {
    setResult(null)
    setView('menu')
    navigate('main')
  }

  const openStoredResult = (restored: TranscriptionResult) => {
    setActiveSource(restored.source.kind)
    setView('studio')
    setResult(restored)
    navigate('main')
  }

  const navigate = (nextPage: 'main' | 'account' | 'admin') => {
    const path = nextPage === 'main' ? '/' : `/${nextPage}`
    if (window.location.pathname !== path) window.history.pushState({}, '', path)
    setPage(nextPage)
  }

  return (
    <main className="app-shell">
      {showLoader && <IntroLoader onComplete={() => setShowLoader(false)} />}

      <header className="studio-header">
        <button
          type="button"
          className="brand-home"
          style={visualStyle(visualConfig.navLogo)}
          onClick={openMenu}
          aria-label="Guitarica home"
        >
          <img src="/images/logo.svg" alt="Guitarica" />
        </button>
        <div style={visualStyle(visualConfig.sourceTabs)}>
          <SourceTabs activeSource={activeSource} onChange={openSource} />
        </div>
        <div className="header-tools" style={visualStyle(visualConfig.headerTools)}>
          {isAuthReady && (
            <AccountMenu
              session={session}
              configured={isSupabaseConfigured}
              onSignIn={() => { void signInWithGoogle() }}
              onOpenAccount={() => navigate('account')}
              unreadNotifications={unreadNotifications}
            />
          )}
        </div>
      </header>

      {page === 'main' && !result && view === 'menu' && (
        <SourceMenu
          onSelect={openSource}
          onGuitarClick={playFeedback}
          visualConfig={visualConfig}
        />
      )}

      {page === 'main' && !result && view === 'studio' && (
        <div className={`workspace workspace-${activeSource}`}>
          <span className="workspace-index" style={visualStyle(visualConfig.studioIndex)} aria-hidden="true">
            {activeSource === 'upload' ? '01' : activeSource === 'youtube' ? '02' : '03'}
          </span>
          <button
            type="button"
            className="workspace-guitar"
            style={visualStyle(visualConfig.studioGuitar)}
            onClick={playFeedback}
            aria-label="Play Guitarica sound"
          >
            <img src="/images/Guitarica.png" alt="" />
          </button>
          <div className="workspace-content" style={visualStyle(visualConfig.studioContent)}>
            {activeSource === 'upload' && (
              <div style={visualStyle(visualConfig.uploadPanel)}>
                <UploadPanel onComplete={acceptResult} session={session} />
              </div>
            )}

            {activeSource === 'youtube' && (
              <div style={visualStyle(visualConfig.youtubePanel)}>
                <YouTubePanel onComplete={acceptResult} session={session} />
              </div>
            )}

            {activeSource === 'live' && (
              <div style={visualStyle(visualConfig.livePanel)}>
                <LiveInputPanel session={session} />
              </div>
            )}
          </div>
        </div>
      )}

      {page === 'main' && result && (
        <TranscriptionReport
          result={result}
          onReset={reset}
          visualConfig={visualConfig}
        />
      )}

      {page === 'account' && session && (
        <AccountDashboard
          session={session}
          onBack={openMenu}
          onOpenResult={openStoredResult}
          onSignOut={() => { void signOut().then(openMenu) }}
          onOpenAdmin={() => navigate('admin')}
          isAdmin={roles.includes('admin')}
        />
      )}

      {page === 'admin' && session && roles.includes('admin') && (
        <AdminDashboard onBack={() => navigate('account')} onOpenResult={openStoredResult} />
      )}

      {page !== 'main' && (!session || (page === 'admin' && !roles.includes('admin'))) && (
        <section className="route-empty"><strong>Account access required</strong><button type="button" className="text-command" onClick={openMenu}>Back to studio</button></section>
      )}

      {showCalibrator && (
        <VisualCalibrator
          config={visualConfig}
          onChange={setVisualConfig}
          onClose={() => setShowCalibrator(false)}
          onOpenMenu={openMenu}
          onOpenSource={openSource}
        />
      )}
    </main>
  )
}

function pageFromPath(): 'main' | 'account' | 'admin' {
  if (window.location.pathname.startsWith('/admin')) return 'admin'
  if (window.location.pathname.startsWith('/account')) return 'account'
  return 'main'
}
