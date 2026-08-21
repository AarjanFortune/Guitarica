import { FormEvent, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Session } from '@supabase/supabase-js'
import {
  sendPasswordReset,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
} from '../services/supabaseClient'

interface AccountMenuProps {
  session: Session | null
  configured: boolean
  onSignIn: () => void
  onOpenAccount: () => void
  unreadNotifications: number
}

export default function AccountMenu({
  session,
  configured,
  onSignIn,
  onOpenAccount,
  unreadNotifications,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [authError, setAuthError] = useState('')
  const userLabel = session?.user.user_metadata?.name || session?.user.email || 'Account'

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    setAuthError('')
    setAuthStatus('')

    try {
      if (authMode === 'signup') {
        await signUpWithPassword(email, password, username)
        setAuthStatus('Check your email to confirm the account.')
      } else {
        await signInWithPassword(email, password)
        setOpen(false)
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed.')
    }
  }

  const submitMagicLink = async () => {
    setAuthError('')
    setAuthStatus('')
    try {
      await signInWithMagicLink(email)
      setAuthStatus('Magic link sent. Check your inbox.')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not send magic link.')
    }
  }

  const resetPassword = async () => {
    setAuthError('')
    setAuthStatus('')
    try {
      await sendPasswordReset(email)
      setAuthStatus('Password reset email sent.')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not send reset email.')
    }
  }

  const switchMode = (mode: 'signin' | 'signup') => {
    setAuthMode(mode)
    setAuthStatus('')
    setAuthError('')
  }

  return (
    <div className="account-menu">
      <button
        type="button"
        className="account-trigger"
        onClick={() => session ? onOpenAccount() : setOpen((current) => !current)}
        aria-label={session ? `Open account for ${userLabel}` : 'Sign in'}
        title={session ? userLabel : 'Sign in'}
      >
        <AccountIcon />
        {session && unreadNotifications > 0 && <i className="account-notification" aria-label={`${unreadNotifications} unread notifications`} />}
      </button>

      {open && !session && createPortal(
        <div className="auth-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="auth-modal"
            aria-label="Account"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" className="auth-close" onClick={() => setOpen(false)}>Close</button>

            {!configured && <p>Supabase env is missing.</p>}

            {configured && !session && (
              <>
                <header className="auth-header">
                  <img src="/images/logo.svg" alt="Guitarica" />
                  <span>Guitarica account</span>
                </header>

                <div className="auth-switch">
                  <button
                    type="button"
                    className={authMode === 'signin' ? 'auth-active' : undefined}
                    onClick={() => switchMode('signin')}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className={authMode === 'signup' ? 'auth-active' : undefined}
                    onClick={() => switchMode('signup')}
                  >
                    Sign up
                  </button>
                </div>

                <form className="auth-form" onSubmit={submitPassword}>
                  {authMode === 'signup' && (
                    <label className="field">
                      <span className="field-label">Username</span>
                      <input
                        className="text-input"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                      />
                    </label>
                  )}

                  <label className="field">
                    <span className="field-label">Email</span>
                    <input
                      className="text-input"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                    />
                  </label>

                  <label className="field">
                    <span className="field-label">Password</span>
                    <input
                      className="text-input"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                      required
                    />
                  </label>

                  <button type="submit" className="primary-action">
                    {authMode === 'signup' ? 'Create account' : 'Sign in'}
                  </button>
                </form>

                <div className="auth-actions">
                  <button type="button" className="auth-google" onClick={onSignIn}>
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </button>
                  <div className="auth-secondary-actions">
                    <button type="button" className="account-link" onClick={submitMagicLink}>Magic link</button>
                    {authMode === 'signin' && (
                      <button type="button" className="account-link" onClick={resetPassword}>Forgot password</button>
                    )}
                  </div>
                </div>

                {authStatus && <p className="auth-status">{authStatus}</p>}
                {authError && <p className="form-error">{authError}</p>}
              </>
            )}

          </section>
        </div>,
        document.body,
      )}
    </div>
  )
}

function AccountIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path d="M12 12.2a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8Z" />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path fill="#4285f4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34a853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.24 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#fbbc05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z" />
      <path fill="#ea4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  )
}
