import { useEffect, useRef, useState, type FormEvent } from 'react';
import { customerApi, type Customer } from '@commerce/api-client';
export function AssistantAuth({ mode, onClose, onAuthenticated }: { mode: 'login' | 'register' | null; onClose: () => void; onAuthenticated: (customer: Customer) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<'login' | 'register' | 'verify'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (mode) { setStep(mode); setShowPassword(false); setError(''); setPassword(''); setToken(''); dialog.current?.showModal(); } else dialog.current?.close(); }, [mode]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (step === 'register') { await customerApi.register(email, password); setPassword(''); setShowPassword(false); setStep('verify'); }
      else if (step === 'verify') { await customerApi.verify(email, token); setStep('login'); setToken(''); }
      else { onAuthenticated(await customerApi.login(email, password)); onClose(); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="assistant-auth-dialog" aria-labelledby="assistant-auth-title" aria-describedby="assistant-auth-description" onCancel={onClose} onClose={onClose}>
    <button type="button" className="assistant-auth-close" onClick={onClose} aria-label="Close authentication"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    <span className="assistant-auth-eyebrow">YOUR ACCOUNT</span>
    <h2 id="assistant-auth-title">{step === 'login' ? 'Log in to continue' : step === 'register' ? 'Create your account' : 'Verify your account'}</h2>
    <p id="assistant-auth-description">{step === 'verify' ? 'Enter the verification code or token sent to your email.' : 'Continue shopping with your account.'}</p>
    <form aria-busy={busy} onSubmit={event => void submit(event)}>
      <div className="assistant-auth-field">
        <label htmlFor="assistant-auth-email">Email address</label>
        <input id="assistant-auth-email" name="email" type="email" required maxLength={254} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" value={email} onChange={event => setEmail(event.target.value)} disabled={busy}/>
      </div>
      {step === 'verify' ? <div className="assistant-auth-field">
        <label htmlFor="assistant-auth-token">Verification code or token</label>
        <input id="assistant-auth-token" name="token" required autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} placeholder="Enter your verification code" value={token} onChange={event => setToken(event.target.value)} disabled={busy}/>
      </div> : <div className="assistant-auth-field">
        <label htmlFor="assistant-auth-password">Password</label>
        <div className="assistant-auth-password">
          <input id="assistant-auth-password" name="password" type={showPassword ? 'text' : 'password'} required minLength={step === 'register' ? 12 : undefined} maxLength={128} autoComplete={step === 'register' ? 'new-password' : 'current-password'} aria-describedby={step === 'register' ? 'assistant-auth-password-hint' : undefined} placeholder={step === 'register' ? 'Create a password' : 'Enter your password'} value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/>
          <button type="button" className="assistant-auth-reveal" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-controls="assistant-auth-password" disabled={busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button>
        </div>
        {step === 'register' && <p id="assistant-auth-password-hint" className="assistant-auth-hint">Use at least 12 characters.</p>}
      </div>}
      {error && <p className="assistant-auth-error" role="alert">{error}</p>}
      <button type="submit" className="assistant-auth-submit" disabled={busy}>{busy ? 'Please wait…' : step === 'login' ? 'Log in' : step === 'register' ? 'Register' : 'Verify account'}</button>
    </form>
    {step !== 'verify' && <div className="assistant-auth-footer"><span>{step === 'login' ? 'New here?' : 'Already have an account?'}</span> <button type="button" className="assistant-auth-switch" disabled={busy} onClick={() => { setStep(step === 'login' ? 'register' : 'login'); setError(''); setPassword(''); setShowPassword(false); }}>{step === 'login' ? 'Create an account' : 'Log in'}</button></div>}
  </dialog>;
}
