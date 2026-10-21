import { FeatureState } from './featureState';
export type AuthMode = 'login' | 'register' | 'verify' | 'forgot-password' | 'reset-password';
export interface AuthenticationFormState {
  mode: AuthMode; identifier: string; password: string; confirmation: string; code: string; showPassword: boolean;
  validation: 'identifier' | 'password' | 'length' | 'confirmation' | 'code' | null;
}
const empty = (): AuthenticationFormState => ({ mode: 'login', identifier: '', password: '', confirmation: '', code: '', showPassword: false, validation: null });
/** Memory only: credentials must never enter persisted app preferences. */
export class AuthenticationForm extends FeatureState<AuthenticationFormState> {
  constructor() { super(empty()); }
  edit(value: Partial<Omit<AuthenticationFormState, 'mode' | 'validation'>>) { this.publish({ ...this.state, ...value, validation: null }); }
  open(mode: AuthMode) { this.publish({ ...empty(), identifier: this.state.identifier, mode }); }
  clearSecrets() {
    const s = this.state;
    if (!s.password && !s.confirmation && !s.code && !s.showPassword && s.validation === null) return;
    this.open(s.mode);
  }
  reset() { this.publish(empty()); }
  prepare(): AuthenticationFormState | null {
    const s = this.state;
    const bytes = Array.from(s.password).reduce((n, char) => n + (char.codePointAt(0)! <= 0x7f ? 1 : char.codePointAt(0)! <= 0x7ff ? 2 : char.codePointAt(0)! <= 0xffff ? 3 : 4), 0);
    const validation = !s.identifier.trim() ? 'identifier'
      : s.mode === 'login' && !s.password ? 'password'
      : ['register', 'reset-password'].includes(s.mode) && (bytes < 12 || bytes > 128) ? 'length'
      : ['register', 'reset-password'].includes(s.mode) && s.password !== s.confirmation ? 'confirmation'
      : ['verify', 'reset-password'].includes(s.mode) && !s.code.trim() ? 'code' : null;
    this.publish({ ...s, validation });
    return validation ? null : this.state;
  }
  complete(submitted: AuthenticationFormState) {
    if (this.state !== submitted) return false;
    this.open(submitted.mode === 'register' ? 'verify' : submitted.mode === 'forgot-password' ? 'reset-password' : 'login');
    return true;
  }
}
