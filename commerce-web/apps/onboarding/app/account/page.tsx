'use client';
import {useEffect,useState} from 'react';
import {api,message} from '../client';
import rocentoLogo from '../../../../packages/ui/src/brand/rocento-logo-320.webp';
type Mode='login'|'register'|'verify'|'forgot'|'reset';
export default function Account(){const[mode,setMode]=useState<Mode>('login'),[identifier,setIdentifier]=useState(''),[password,setPassword]=useState(''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 useEffect(()=>{const p=new URLSearchParams(window.location.hash.slice(1));if(p.get('purpose')==='verify'||p.get('purpose')==='reset'){setMode(p.get('purpose') as Mode);setIdentifier(p.get('identifier')??'');setToken(p.get('token')??'');history.replaceState(null,'','/account');}},[]);
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');setNotice('');try{const action={login:'login',register:'register',verify:'verify',forgot:'forgot-password',reset:'reset-password'}[mode];await api('customer/auth/'+action,'POST',{identifier,...(['login','register','reset'].includes(mode)?{password}:{}),...(['verify','reset'].includes(mode)?{token}:{})});setPassword('');if(mode==='login'){window.location.assign('/');return;}if(mode==='verify'||mode==='reset'){setMode('login');setToken('');setNotice(mode==='verify'?'Your email is verified. You can now sign in.':'Password updated. Sign in with your new password.');}else setNotice('If this email is eligible, a link has been queued. Check your inbox; the link expires in 15 minutes.');}catch(e){setError(message(e));}finally{setBusy(false);}}
 async function resend(){setBusy(true);try{await api('customer/auth/request-verification','POST',{identifier});setNotice('If verification is needed, a new link has been queued.');}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <div className="account-shell">
  <div className="setup-topbar">
   <a className="wordmark" href="/" aria-label="Rocento onboarding home"><img src={rocentoLogo.src} alt="Rocento" width="320" height="77" /></a>
   <span className="topbar-divider"/><span className="workspace-label">Commerce workspace</span>
   <div className="topbar-meta"><a className="account-top-link" href="/">Back to store setup <span aria-hidden="true">↗</span></a></div>
  </div>
  <div className="account-layout">
   <aside className="account-story" aria-label="Your Rocento workspace">
    <span className="eyebrow">BUILT AROUND YOUR BUSINESS</span>
    <h1>Your vision.<br/>Your storefront.<br/>Your next chapter.</h1>
    <p>One account to shape your store, save your progress, and take the next step with Rocento.</p>
    <div className="story-art" aria-hidden="true"><span/><span/></div>
    <p className="story-caption">A SPACE FOR WHAT COMES NEXT.</p>
   </aside>
   <main className="account-page"><section>
    <span className="eyebrow">YOUR ROCENTO ACCOUNT</span>
    <h2>{{login:'Welcome back.',register:'Create your account.',verify:'Verify your email.',forgot:'Reset your password.',reset:'Choose a new password.'}[mode]}</h2>
    <p className="intro">{{login:'Sign in to continue setting up your store and track your onboarding status.',register:'Save your setup and manage your next steps in one place.',verify:'Confirm your email address to reserve your store.',forgot:'We’ll email you a link to reset your password.',reset:'Choose a strong password for your account.'}[mode]}</p>
    <form onSubmit={submit}>
     <label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" required maxLength={254} value={identifier} onChange={e=>setIdentifier(e.target.value)}/>
     {['login','register','reset'].includes(mode)&&<><label htmlFor="password">Password</label><input id="password" type="password" autoComplete={mode==='login'?'current-password':'new-password'} required minLength={12} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)}/><p className="hint">Use a password of 12–128 bytes.</p></>}
     {['verify','reset'].includes(mode)&&<><label htmlFor="token">Verification token</label><input id="token" required autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></>}
     {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
     <button className="primary" disabled={busy}>{busy?'Please wait…':{login:'Sign in',register:'Create account',verify:'Verify email',forgot:'Send reset link',reset:'Update password'}[mode]}</button>
    </form>
    <div className="account-links">{(['login','register','forgot'] as Mode[]).filter(m=>m!==mode).map(m=><button className="back" disabled={busy} key={m} onClick={()=>{setMode(m);setPassword('');setError('');setNotice('');}}>{{login:'Sign in',register:'Create account',forgot:'Forgot password?'}[m as 'login'|'register'|'forgot']}</button>)}<button className="back" disabled={busy||!identifier} onClick={resend}>Resend verification</button></div>
    <a className="account-return" href="/">Back to your store setup</a>
   </section></main>
  </div>
 </div>;
}
