import { FormEvent, useState } from 'react'
import {
  sendPasswordReset,
  signInWithMagicLink,
  signInWithPassword,
  signUpWithPassword,
} from '../services/supabaseClient'
import { GoogleIcon } from './icons'

interface Props {
  onClose: () => void
  onSignInWithGoogle: () => void
}

export default function MobileAuthSheet({ onClose, onSignInWithGoogle }: Props) {
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setStatus('')
    try {
      if (authMode === 'signup') {
        await signUpWithPassword(email, password, username)
        setStatus('Check your email to confirm the account.')
      } else {
        await signInWithPassword(email, password)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.')
    }
  }

  const submitMagicLink = async () => {
    setError('')
    setStatus('')
    try {
      await signInWithMagicLink(email)
      setStatus('Magic link sent. Check your inbox.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send magic link.')
    }
  }

  const resetPassword = async () => {
    setError('')
    setStatus('')
    try {
      await sendPasswordReset(email)
      setStatus('Password reset email sent.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset email.')
    }
  }

  return (
    <div className="m-sheet-overlay" role="presentation" onMouseDown={onClose}>
      <section className="m-sheet" aria-label="Sign in" onMouseDown={(event) => event.stopPropagation()}>
        <div className="m-sheet-handle" />
        <header className="m-sheet-header">
          <img src="/images/logo.svg" alt="Guitarica" />
          <span>Guitarica account</span>
        </header>

        <div className="m-tabs">
          <button type="button" className={authMode === 'signin' ? 'active' : ''} onClick={() => setAuthMode('signin')}>Sign in</button>
          <button type="button" className={authMode === 'signup' ? 'active' : ''} onClick={() => setAuthMode('signup')}>Sign up</button>
        </div>

        <button type="button" className="m-button google" onClick={onSignInWithGoogle}>
          <GoogleIcon />
          <span>Continue with Google</span>
        </button>

        <div className="m-muted" style={{ textAlign: 'center', margin: '14px 0' }}>or</div>

        <form onSubmit={submitPassword}>
          {authMode === 'signup' && (
            <label className="m-field">
              <span>Username</span>
              <input className="m-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
          )}
          <label className="m-field">
            <span>Email</span>
            <input className="m-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label className="m-field">
            <span>Password</span>
            <input
              className="m-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
              required
            />
          </label>
          <button type="submit" className="m-button">{authMode === 'signup' ? 'Create account' : 'Sign in'}</button>
        </form>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
          <button type="button" className="m-link-button" onClick={submitMagicLink}>Magic link</button>
          {authMode === 'signin' && <button type="button" className="m-link-button" onClick={resetPassword}>Forgot password</button>}
        </div>

        {status && <p className="m-status">{status}</p>}
        {error && <p className="m-error">{error}</p>}
      </section>
    </div>
  )
}
