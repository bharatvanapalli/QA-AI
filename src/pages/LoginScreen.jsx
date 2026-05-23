import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogIn, UserPlus, Sparkles, AlertTriangle } from 'lucide-react';
import { useAuth, ApiError } from '../store/auth';
import { useToast } from '../lib/useToast';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import SecretInput from '../components/ui/SecretInput';

// Surface a soft warning after this many consecutive failed sign-in attempts
// so users with a typo see a hint before getting locked out at the server.
const RATE_LIMIT_HINT_AT = 3;

// Lightweight client-side validators. We don't try to match every RFC quirk —
// the server is the source of truth — but we catch obvious typos before a
// round-trip and keep the screen reader chatter down to "real" failures.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validate(mode, form) {
  const fieldErrors = {};
  if (!form.email.trim()) fieldErrors.email = 'Email is required.';
  else if (!EMAIL_RE.test(form.email.trim())) fieldErrors.email = 'Enter a valid email address.';
  if (!form.password) fieldErrors.password = 'Password is required.';
  else if (mode === 'signup' && form.password.length < 8) fieldErrors.password = 'Password must be at least 8 characters.';
  return fieldErrors;
}

export default function LoginScreen() {
  const { login, signup } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    organisation: '',
  });
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [failedAttempts, setFailedAttempts] = useState(0);

  // Refs let us move keyboard focus to the announced error and to the first
  // input on mount — both required for accessible form errors.
  const errorRef = useRef(null);
  const emailRef = useRef(null);

  // Initial focus: drop the caret in the email field so keyboard-only and
  // screen-reader users don't have to tab in from the document root.
  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  // When a submission fails, push focus to the error region so screen readers
  // announce the message and keyboard users can read+dismiss without losing
  // their place in the form.
  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.focus();
    }
  }, [error]);

  const update = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (error) setError(null);
    if (fieldErrors[k]) setFieldErrors((fe) => ({ ...fe, [k]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    const fe = validate(mode, form);
    if (Object.keys(fe).length > 0) {
      setFieldErrors(fe);
      // Surface the first field error as the form-level message too so screen
      // readers get a single short announcement.
      setError(Object.values(fe)[0]);
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      if (mode === 'login') {
        await login(form.email.trim(), form.password);
      } else {
        await signup({
          email: form.email.trim(),
          password: form.password,
          firstName: form.firstName.trim() || null,
          lastName: form.lastName.trim() || null,
          organisation: form.organisation.trim() || null,
        });
        toast.success('Account created. Welcome to QAAI.');
      }
      const dest = location.state?.from?.pathname || '/overview';
      navigate(dest, { replace: true });
      setFailedAttempts(0);
    } catch (err) {
      const msg = err instanceof ApiError ? err.payload?.message || err.message : err.message;
      setError(msg || 'Sign-in failed. Please try again.');
      if (mode === 'login') setFailedAttempts((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = () => {
    // Stub — once the backend has a reset-password endpoint, swap this for
    // a `navigate('/forgot-password')` or a modal. The placeholder is here
    // so the link is present in the UI from day one and we don't ship a
    // login screen that visibly lacks the convention.
    toast.info(
      'Password reset is handled by your administrator. Contact them to reset your password.',
      { title: 'Reset password', ttl: 6000 }
    );
  };

  const handleSso = () => {
    // Stub — wired to a real SSO endpoint when one is provisioned.
    toast.info(
      'SSO is not yet configured. Ask your administrator to enable SAML or OIDC.',
      { title: 'SSO', ttl: 6000 }
    );
  };

  return (
    <div className="min-h-screen bg-ink-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <Sparkles className="w-5 h-5 text-ink-900" aria-hidden="true" />
          <span className="text-lg font-black text-ink-900">QAAI</span>
        </div>

        <div className="bg-white rounded-lg border border-ink-200 shadow-sm p-6">
          <div className="flex bg-ink-100 rounded-md p-1 mb-5" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              onClick={() => { setMode('login'); setError(null); setFieldErrors({}); }}
              className={`flex-1 py-1.5 rounded text-sm font-semibold focus-visible:outline-none focus-visible:shadow-ring ${
                mode === 'login' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              onClick={() => { setMode('signup'); setError(null); setFieldErrors({}); }}
              className={`flex-1 py-1.5 rounded text-sm font-semibold focus-visible:outline-none focus-visible:shadow-ring ${
                mode === 'signup' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500'
              }`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={submit} className="space-y-3" noValidate aria-label={mode === 'login' ? 'Sign in form' : 'Create account form'}>
            <Input
              ref={emailRef}
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              required
              autoComplete="email"
              error={fieldErrors.email}
            />
            <SecretInput
              label="Password"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
              error={fieldErrors.password}
            />
            {mode === 'signup' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="First name"
                    value={form.firstName}
                    onChange={(e) => update('firstName', e.target.value)}
                    autoComplete="given-name"
                  />
                  <Input
                    label="Last name"
                    value={form.lastName}
                    onChange={(e) => update('lastName', e.target.value)}
                    autoComplete="family-name"
                  />
                </div>
                <Input
                  label="Organisation"
                  value={form.organisation}
                  onChange={(e) => update('organisation', e.target.value)}
                  autoComplete="organization"
                />
              </>
            )}

            {/* Always render the error container so the live region exists
                from the first paint; toggle visibility on `error`. Keeping
                the node mounted is what lets aria-live actually announce
                changes instead of being lost on re-render. */}
            <div
              ref={errorRef}
              role="alert"
              aria-live="assertive"
              tabIndex={-1}
              className={`rounded-md text-xs p-3 outline-none focus-visible:shadow-ring ${
                error
                  ? 'bg-danger-50 border border-danger-200 text-danger-800'
                  : 'sr-only'
              }`}
            >
              {error || ''}
            </div>

            {/* After repeated failures, hint at rate-limiting before the
                server actually clamps down. Lower-key than an error — uses
                warn tones, polite live region. */}
            {failedAttempts >= RATE_LIMIT_HINT_AT && mode === 'login' && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md text-xs p-3 bg-warn-50 border border-warn-200 text-warn-800 flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                <div>
                  <div className="font-semibold">Too many failed attempts.</div>
                  <div className="opacity-80 mt-0.5">
                    Double-check your email and password. Repeated failures may temporarily lock you out.
                    {' '}
                    <button type="button" onClick={handleForgotPassword} className="underline font-semibold hover:text-warn-900">
                      Forgot password?
                    </button>
                  </div>
                </div>
              </div>
            )}

            <Button type="submit" loading={busy} disabled={busy} className="w-full">
              {mode === 'login' ? (
                <>
                  <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                  Sign in
                </>
              ) : (
                <>
                  <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                  Create account
                </>
              )}
            </Button>

            {mode === 'login' && (
              <>
                {/* Divider + SSO + forgot-password */}
                <div className="flex items-center gap-3 pt-1" role="presentation">
                  <div className="flex-1 h-px bg-ink-200" />
                  <span className="text-2xs uppercase tracking-wider text-ink-400 font-semibold">or</span>
                  <div className="flex-1 h-px bg-ink-200" />
                </div>
                <Button type="button" variant="outline" onClick={handleSso} className="w-full">
                  Continue with SSO
                </Button>
                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={handleForgotPassword}
                    className="text-xs text-ink-500 hover:text-ink-900 underline focus-visible:outline-none focus-visible:shadow-ring rounded"
                  >
                    Forgot your password?
                  </button>
                </div>
              </>
            )}
          </form>
        </div>

        <p className="text-xs text-ink-400 text-center mt-4">
          By signing in, you agree to your organisation's{' '}
          <a href="#privacy" className="underline hover:text-ink-600">privacy</a>
          {' '}and{' '}
          <a href="#terms" className="underline hover:text-ink-600">terms</a>.
        </p>
      </div>
    </div>
  );
}
