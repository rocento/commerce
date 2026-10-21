import { useEffect, useRef, useState } from 'react';
import { MobilePreviewIcon, type PreviewPlatform } from './mobile-preview-icon';
import './mobile-native-auth.css';
type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset';
type Issue = 'identifier' | 'password' | 'length' | 'confirmation' | 'code';
// Keep local guidance aligned with the Swift and Kotlin AccountForm implementations.
function issue(mode: Mode, identifier: string, password: string, confirmation: string, code: string): Issue | null {
  if (!identifier.trim()) return 'identifier';
  if (mode === 'login' && !password) return 'password';
  if (mode === 'register' || mode === 'reset') {
    const bytes = new TextEncoder().encode(password).length;
    if (bytes < 12 || bytes > 128) return 'length';
    if (password !== confirmation) return 'confirmation';
  }
  if ((mode === 'verify' || mode === 'reset') && !code.trim()) return 'code';
  return null;
}
export function NativeAuth({locale,platform,onSignIn}:{locale:'en'|'ar';platform:PreviewPlatform;onSignIn:(identifier:string)=>void}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [mode,setMode]=useState<Mode>('login'),[identifier,setIdentifier]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[code,setCode]=useState('');
  const [show,setShow]=useState(false),[validation,setValidation]=useState<Issue|null>(null),[notice,setNotice]=useState<Mode|'resend'|null>(null);
  const heading=useRef<HTMLHeadingElement>(null),error=useRef<HTMLParagraphElement>(null),first=useRef(true);
  const title={login:t('Sign in','تسجيل الدخول'),register:t('Create account','إنشاء حساب'),verify:t('Verify account','تأكيد الحساب'),forgot:t('Forgot password?','نسيت كلمة المرور؟'),reset:t('Reset password','إعادة تعيين كلمة المرور')}[mode];
  const messages={identifier:t('Enter your email or phone number.','أدخل بريدك الإلكتروني أو رقم هاتفك.'),password:t('Enter your password.','أدخل كلمة المرور.'),length:t('Use a password of 12–128 UTF-8 bytes; Arabic letters may use more than one byte.','استخدم كلمة مرور من ١٢ إلى ١٢٨ بايت UTF-8؛ قد يستخدم الحرف العربي أكثر من بايت.'),confirmation:t('Passwords do not match.','كلمتا المرور غير متطابقتين.'),code:t('Enter the verification code you received.','أدخل رمز التحقق الذي تلقيته.')};
  const notices={login:'',register:t('Account created. Check your email or phone for a verification code.','تم إنشاء الحساب. تحقق من بريدك أو هاتفك للحصول على رمز التحقق.'),forgot:t('If an account matches, you will receive a reset code. Check your inbox and spam folder.','إذا كان الحساب موجوداً، فسيصلك رمز إعادة التعيين. تحقق من البريد الوارد وغير المرغوب فيه.'),verify:t('Account verified. Sign in to continue.','تم تأكيد الحساب. سجل الدخول للمتابعة.'),reset:t('Password updated. Sign in with your new password.','تم تحديث كلمة المرور. سجل الدخول بكلمة المرور الجديدة.'),resend:t('If eligible, a code will be sent. Check your inbox and spam folder.','إذا كان الحساب مؤهلاً، فسيُرسل رمز. تحقق من البريد الوارد وغير المرغوب فيه.')};
  function change(next:Mode) {setMode(next);setPassword('');setConfirmation('');setCode('');setShow(false);setValidation(null);setNotice(null);}
  useEffect(()=>{if(first.current){first.current=false;return;}heading.current?.focus({preventScroll:true});heading.current?.scrollIntoView({block:'nearest'});},[mode]);
  useEffect(()=>{if(validation)error.current?.focus();},[validation]);
  const field=(label:string,value:string,set:(v:string)=>void,type='text',identifierField=false)=><label className={`ms-auth-field${identifierField?' ms-auth-identifier':''}`}><span>{label}</span><input aria-label={label} value={value} type={type} placeholder={platform==='iOS'&&!identifierField?label:undefined} autoComplete={type==='password'?'new-password':'off'} autoCapitalize="none" spellCheck={false} onChange={e=>set(e.target.value)}/></label>;
  return <form className="ms-native-auth ms-auth-parity" autoComplete="off" noValidate onSubmit={e=>{
    e.preventDefault();const invalid=issue(mode,identifier,password,confirmation,code);setValidation(invalid);if(invalid){error.current?.focus();return;}
    if(mode==='login'){setPassword('');setConfirmation('');setCode('');onSignIn(identifier.trim());return;}
    const action=mode;change(mode==='register'?'verify':mode==='forgot'?'reset':'login');setNotice(action);
  }}>
    <span className="ms-account-avatar">{platform==='iOS'&& !['login','register'].includes(mode)?<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z"/><rect x="8" y="10" width="8" height="7" rx="1"/><path d="M10 10V8a2 2 0 0 1 4 0v2"/></svg>:<MobilePreviewIcon platform={platform} name="account"/>}</span>
    <h3 ref={heading} tabIndex={-1}>{mode==='login'?t('Welcome back','مرحباً بعودتك'):title}</h3>
    <p>{t('Manage your orders and delivery addresses securely.','إدارة طلباتك وعناوين التوصيل بأمان.')}</p>
    {notice&&<p role="status">{notices[notice]}<small className="ms-auth-demo">{t('Preview only: no message sent. Use any nonempty demo code.','معاينة فقط: لم تُرسل رسالة. استخدم أي رمز تجريبي غير فارغ.')}</small></p>}
    {field(t('Email or phone','البريد أو الهاتف'),identifier,setIdentifier,'text',true)}
    <small>{t('For phone numbers, include the country code, e.g. +201012345678.','لأرقام الهاتف، أضف رمز الدولة مثل ‎+201012345678.')}</small>
    {['login','register','reset'].includes(mode)&&<>
      {field(t('Password','كلمة المرور'),password,setPassword,show?'text':'password')}
      <label className="ms-native-toggle"><input type="checkbox" role="switch" checked={show} onChange={e=>setShow(e.target.checked)}/>{t('Show password','إظهار كلمة المرور')}</label>
      {mode!=='login'&&<><small>{t('Use a long, unique password (12–128 UTF-8 bytes).','استخدم كلمة مرور طويلة وفريدة (١٢–١٢٨ بايت UTF-8).')}</small>{field(t('Confirm password','تأكيد كلمة المرور'),confirmation,setConfirmation,'password')}</>}
    </>}
    {['verify','reset'].includes(mode)&&<>{field(t('Verification code','رمز التحقق'),code,setCode)}<button type="button" className="ms-native-text-button" disabled={!identifier.trim()} onClick={()=>setNotice('resend')}>{t('Send a new code','إرسال رمز جديد')}</button></>}
    {validation&&<p className="ms-auth-error" role="alert" ref={error} tabIndex={-1}>{messages[validation]}</p>}
    <button type="submit" className="ms-cart-primary">{mode==='forgot'?t('Send reset code','إرسال رمز إعادة التعيين'):title}</button>
    {mode==='login'?<><hr/><small>{t('New here?','جديد هنا؟')}</small><button type="button" className="ms-account-secondary" onClick={()=>change('register')}>{t('Create account','إنشاء حساب')}</button><button type="button" className="ms-native-text-button" onClick={()=>change('forgot')}>{t('Forgot password?','نسيت كلمة المرور؟')}</button><button type="button" className="ms-native-text-button" onClick={()=>change('verify')}>{t('Verify an existing account','تأكيد حساب موجود')}</button></>:<button type="button" className="ms-native-text-button" onClick={()=>change('login')}>{t('Back to sign in','العودة لتسجيل الدخول')}</button>}
  </form>;
}
