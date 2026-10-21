import { useSyncExternalStore } from 'react';
import { useCommercePanel, type CommercePanelProps } from './useCommercePanel';
import { Platform, Pressable, View } from 'react-native';
import type { AuthMode } from '../core/authenticationForm';
import { Button, Copy } from './Storefront';
import { MenuRow } from './ScreenParts';
import { NavigationIcon } from './NavigationIcon';

export function AuthenticationPanel({ runtime, locale }: CommercePanelProps) {
  const { session, colors, s, t, busy, setNotice, setPanel, act, field, feedback } = useCommercePanel({ runtime, locale });
  const { authForm } = runtime;
  const { mode: authMode, identifier, password, confirmation, code, showPassword, validation } = useSyncExternalStore(authForm.subscribe, authForm.getSnapshot, authForm.getSnapshot);
  const setIdentifier = (identifier: string) => authForm.edit({ identifier });
  const setPassword = (password: string) => authForm.edit({ password });
  const setConfirmation = (confirmation: string) => authForm.edit({ confirmation });
  const setCode = (code: string) => authForm.edit({ code });
  const setShowPassword = (showPassword: boolean) => authForm.edit({ showPassword });
  const login = () => act(async () => {
    const submitted = authForm.prepare();
    if (!submitted) return;
    const { mode: authMode, identifier, password, code } = submitted;
    if (authMode === 'login') {
      await session.actions.login(identifier.trim(), password);
    } else {
      await session.actions.auth(authMode, identifier.trim(), ['register', 'reset-password'].includes(authMode) ? password : undefined, ['verify', 'reset-password'].includes(authMode) ? code.trim() : undefined);
      const completed = authForm.complete(submitted);
      if (authMode === 'verify' && session.account.getSnapshot().customer) setPanel(null);
      if (!completed) return;
      setNotice(t('Request completed. Check your email or phone when a code is needed.', 'تم الطلب. تحقق من بريدك أو هاتفك إذا كان الرمز مطلوباً.'));

    }
  });
  const authTitle = authMode === 'login' ? t('Sign in', 'تسجيل الدخول') : authMode === 'register' ? t('Create account', 'إنشاء حساب') : authMode === 'verify' ? t('Verify account', 'تأكيد الحساب') : authMode === 'forgot-password' ? t('Forgot password', 'نسيت كلمة المرور') : t('Reset password', 'تعيين كلمة المرور');
  const openAuth = (mode: AuthMode) => { authForm.open(mode); session.feedback.setError(''); setPanel('auth'); };
  return <>
      <View style={{ width: 64, height: 64, justifyContent: 'center' }}><NavigationIcon name="account" size={32} color={colors.primary} /></View>
      <Copy accessibilityRole="header" style={s.largeTitle}>{authMode === 'login' ? t('Welcome back', 'مرحباً بعودتك') : authTitle}</Copy>
      <Copy style={s.muted}>{t('Manage your orders and delivery addresses securely.', 'إدارة طلباتك وعناوين التوصيل بأمان.')}</Copy>
      {feedback}
      {Platform.OS === 'web' && <Copy>{t('Use the iOS or Android app for secure sign-in and shopping.', 'استخدم تطبيق آيفون أو أندرويد لتسجيل الدخول والتسوق بأمان.')}</Copy>}
      {field(t('Email or mobile number', 'البريد الإلكتروني أو رقم الهاتف'), identifier, setIdentifier)}
      <Copy style={s.caption}>{t('For phone numbers, include the country code, e.g. +201012345678.', 'لأرقام الهاتف، أضف رمز الدولة مثل ‎+201012345678.')}</Copy>
      {['login', 'register', 'reset-password'].includes(authMode) && <>
        {field(t('Password', 'كلمة المرور'), password, setPassword, !showPassword)}
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: showPassword }} onPress={() => setShowPassword(!showPassword)} style={s.language}><Copy>{showPassword ? '☑' : '□'} {t('Show password', 'إظهار كلمة المرور')}</Copy></Pressable>
        {authMode !== 'login' && field(t('Confirm password', 'تأكيد كلمة المرور'), confirmation, setConfirmation, !showPassword)}
      </>}
      {['verify', 'reset-password'].includes(authMode) && field(t('Verification code', 'رمز التحقق'), code, setCode)}
      {validation && <Copy accessibilityRole="alert">{validation === 'length' ? t('Use a password of 12–128 UTF-8 bytes.', 'استخدم كلمة مرور من ١٢ إلى ١٢٨ بايت UTF-8.') : validation === 'confirmation' ? t('Passwords do not match.', 'كلمتا المرور غير متطابقتين.') : t('Complete the required fields.', 'أكمل الحقول المطلوبة.')}</Copy>}
      <Button title={authMode === 'forgot-password' ? t('Send reset code', 'إرسال رمز إعادة التعيين') : authTitle} label={t('Continue', 'متابعة')} disabled={busy || Platform.OS === 'web'} onPress={() => void login()} />
      {authMode === 'verify' && <Button title={t('Send verification code', 'إرسال رمز التحقق')} secondary disabled={busy || !identifier.trim() || Platform.OS === 'web'} onPress={() => void act(async () => { await session.actions.auth('request-verification', identifier.trim()); setNotice(t('Check your email or phone.', 'تحقق من بريدك أو هاتفك.')); })} />}
      <View style={s.divider} />
      {authMode === 'login' ? <><Button title={t('Create account', 'إنشاء حساب')} secondary onPress={() => openAuth('register')} /><MenuRow title={t('Forgot password?', 'نسيت كلمة المرور؟')} onPress={() => openAuth('forgot-password')} /><MenuRow title={t('Verify an existing account', 'تأكيد حساب موجود')} onPress={() => openAuth('verify')} /></> : <MenuRow title={t('Back to sign in', 'العودة لتسجيل الدخول')} onPress={() => openAuth('login')} />}
      {authMode === 'forgot-password' && <MenuRow title={t('I already have a reset code', 'لدي رمز إعادة تعيين')} onPress={() => openAuth('reset-password')} />}
      </>;
}
