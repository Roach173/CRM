import { useState, useCallback, useEffect } from 'react';
import {
  ShieldOff, AlertTriangle, Eye, EyeOff, Key,
  Smartphone, X, Loader2, CheckCircle2, ArrowLeft,
  Lock, ShieldAlert,
} from 'lucide-react';
import { startAuthentication } from '@simplewebauthn/browser';
import api from '../../lib/api';
import { Modal, ModalContent } from './Modal';

// ─── Types ──────────────────────────────────────────────────────────────────
type ModalStep = 'confirm' | 'passkey-loading' | 'totp-input' | 'submitting' | 'success';

interface Props {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
}

// ─── Disable2FAModal Component ───────────────────────────────────────────────
export function Disable2FAModal({ open, onCancel, onSuccess }: Props) {
  const [step, setStep] = useState<ModalStep>('confirm');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // ── Reset state on close ──
  const reset = useCallback(() => {
    setStep('confirm');
    setPassword('');
    setShowPassword(false);
    setTotpCode('');
    setError('');
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // ── Handle cancel ──
  const handleCancel = () => {
    reset();
    onCancel();
  };

  // ── Passkey flow ──
  const handlePasskeyConfirm = async () => {
    if (!password.trim()) {
      setError('Введите текущий пароль для продолжения');
      return;
    }
    setError('');
    setLoading(true);
    setStep('passkey-loading');

    try {
      // 1. Get challenge
      const challengeRes = await api.get('/2fa/disable/passkey/generate');
      const options = challengeRes.data.data;

      // 2. Invoke browser WebAuthn
      let passkeyResponse;
      try {
        passkeyResponse = await startAuthentication({ optionsJSON: options });
      } catch (err: any) {
        if (err.name === 'NotAllowedError') {
          setError('Passkey операция отменена. Попробуйте снова или используйте TOTP.');
          setStep('confirm');
          setLoading(false);
          return;
        }
        throw err;
      }

      // 3. Submit to disable endpoint
      setStep('submitting');
      await api.post('/2fa/disable', { password, passkeyResponse });

      setStep('success');
      setTimeout(() => {
        reset();
        onSuccess();
      }, 2000);
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || 'Ошибка при отключении 2FA';
      setError(msg);
      setStep('confirm');
    } finally {
      setLoading(false);
    }
  };

  // ── TOTP flow ──
  const handleTotpConfirm = async () => {
    if (!password.trim()) {
      setError('Введите текущий пароль для продолжения');
      return;
    }
    if (totpCode.length !== 6) {
      setError('Введите 6-значный TOTP-код');
      return;
    }
    setError('');
    setLoading(true);
    setStep('submitting');

    try {
      await api.post('/2fa/disable', { password, totpCode });
      setStep('success');
      setTimeout(() => {
        reset();
        onSuccess();
      }, 2000);
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Ошибка при отключении 2FA';
      setError(msg);
      setStep('totp-input');
    } finally {
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Modal
      open={open}
      onOpenChange={(v) => {
        if (!v && step !== 'submitting' && step !== 'passkey-loading') handleCancel();
      }}
    >
      <ModalContent showClose={false} className="rounded-[2rem] overflow-y-auto p-0 max-w-md w-full">

        {/* ── Danger Header Strip ── */}
        <div className="bg-gradient-to-r from-red-500 to-orange-500 px-8 pt-8 pb-6">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center shrink-0">
                <ShieldOff className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="text-white/70 text-[10px] font-black uppercase tracking-[0.2em] mb-0.5">
                  Критическое действие
                </p>
                <h2 className="text-white font-bold text-lg leading-snug">
                  Отключить двухфакторную<br />аутентификацию?
                </h2>
              </div>
            </div>
            {step !== 'submitting' && step !== 'passkey-loading' && (
              <button
                onClick={handleCancel}
                className="w-9 h-9 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div className="px-8 py-6 flex flex-col gap-5">

          {/* ── Success Step ── */}
          {step === 'success' && (
            <div className="flex flex-col items-center gap-4 py-6 animate-in fade-in zoom-in-95">
              <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              </div>
              <div className="text-center">
                <p className="font-bold text-surface text-lg mb-1">Отключено!</p>
                <p className="text-sm text-textSecondary/60">
                  Двухфакторная аутентификация успешно отключена
                </p>
              </div>
            </div>
          )}

          {/* ── Submitting / Loading ── */}
          {(step === 'submitting' || step === 'passkey-loading') && (
            <div className="flex flex-col items-center gap-4 py-8 animate-in fade-in">
              <div className="w-16 h-16 bg-orange-50 rounded-full flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
              </div>
              <p className="text-sm font-bold text-textSecondary/70 text-center">
                {step === 'passkey-loading'
                  ? 'Ожидание подтверждения Passkey...'
                  : 'Обрабатываем запрос...'}
              </p>
              {step === 'passkey-loading' && (
                <p className="text-xs text-textSecondary/40 text-center">
                  Используйте биометрию или ключ безопасности
                </p>
              )}
            </div>
          )}

          {/* ── Main Confirm Step ── */}
          {step === 'confirm' && (
            <>
              {/* Warning Banner */}
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-700 leading-relaxed">
                  Вы собираетесь отключить 2FA. Это{' '}
                  <strong>значительно снизит безопасность</strong>{' '}
                  вашего аккаунта. После отключения для входа будет достаточно
                  только пароля или аккаунта Google.
                </p>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 flex items-center gap-2.5">
                  <ShieldAlert className="w-4 h-4 text-red-500 shrink-0" />
                  <p className="text-sm text-red-600 font-medium">{error}</p>
                </div>
              )}

              {/* Password Field */}
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-black text-textSecondary uppercase tracking-[0.2em] opacity-60 ml-1">
                  Текущий пароль
                </label>
                <div className="relative">
                  <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary/30" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Введите ваш пароль"
                    className="w-full bg-surfaceLow rounded-2xl pl-11 pr-12 py-4 text-sm font-bold text-surface outline-none focus:ring-2 focus:ring-red-300/40 transition"
                    onKeyDown={e => e.key === 'Enter' && handlePasskeyConfirm()}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-textSecondary/30 hover:text-textSecondary/60 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-3 pt-1">
                {/* Primary: Passkey */}
                <button
                  onClick={handlePasskeyConfirm}
                  disabled={!password.trim()}
                  className="w-full flex items-center justify-center gap-3 py-4 bg-red-500 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl font-bold text-sm shadow-lg shadow-red-200 transition active:scale-[0.98]"
                >
                  <Key className="w-4 h-4" />
                  Подтвердить с помощью Passkey
                </button>

                {/* Secondary: TOTP */}
                <button
                  onClick={() => { setError(''); setStep('totp-input'); }}
                  disabled={!password.trim()}
                  className="w-full py-3.5 border-2 border-red-200 hover:border-red-300 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed text-red-500 rounded-2xl font-bold text-sm transition flex items-center justify-center gap-2"
                >
                  <Smartphone className="w-4 h-4" />
                  Другой способ — ввести TOTP-код
                </button>

                {/* Cancel */}
                <button
                  onClick={handleCancel}
                  className="w-full py-3 text-sm font-bold text-textSecondary/50 hover:text-textSecondary transition-colors"
                >
                  Отмена — оставить 2FA включённой
                </button>
              </div>
            </>
          )}

          {/* ── TOTP Input Step ── */}
          {step === 'totp-input' && (
            <>
              {/* Header */}
              <div className="flex items-center gap-3 mb-1">
                <button
                  onClick={() => { setError(''); setTotpCode(''); setStep('confirm'); }}
                  className="w-9 h-9 rounded-xl bg-surfaceLow hover:bg-surfaceLowest flex items-center justify-center text-textSecondary/50 hover:text-textSecondary transition"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div>
                  <p className="font-bold text-surface text-sm">Введите TOTP-код</p>
                  <p className="text-[11px] text-textSecondary/50">
                    Откройте приложение-аутентификатор
                  </p>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl px-4 py-3 flex items-center gap-2.5">
                  <ShieldAlert className="w-4 h-4 text-red-500 shrink-0" />
                  <p className="text-sm text-red-600 font-medium">{error}</p>
                </div>
              )}

              {/* Code Input */}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full text-center text-4xl font-mono font-bold tracking-[0.45em] bg-surfaceLow border-2 border-transparent focus:border-red-300/50 rounded-2xl px-6 py-5 outline-none transition"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && totpCode.length === 6) handleTotpConfirm();
                }}
              />

              <div className="flex flex-col gap-2">
                <button
                  onClick={handleTotpConfirm}
                  disabled={loading || totpCode.length !== 6}
                  className="w-full py-4 bg-red-500 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl font-bold text-sm shadow-lg shadow-red-200 transition flex items-center justify-center gap-2 active:scale-[0.98]"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Подтвердить отключение 2FA'}
                </button>

                <button
                  onClick={handleCancel}
                  className="w-full py-3 text-sm font-bold text-textSecondary/50 hover:text-textSecondary transition-colors"
                >
                  Отмена
                </button>
              </div>
            </>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}
