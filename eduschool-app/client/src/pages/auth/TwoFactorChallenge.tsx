import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { startAuthentication } from "@simplewebauthn/browser";
import api from "../../lib/api";
import { ShieldCheck, Fingerprint, Keyboard } from "lucide-react";
import { useAuth } from "../../hooks/useAuth";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
} from "../../components/layout/AuthLayout";

export default function TwoFactorChallenge() {
  const location = useLocation();
  const navigate = useNavigate();
  const { login } = useAuth();
  const { tempToken } = location.state || {};

  const [usePasskey, setUsePasskey] = useState(true);
  const [totpCode, setTotpCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!tempToken) {
      navigate("/login");
    }
  }, [tempToken, navigate]);

  const handlePasskeyLogin = async () => {
    setIsLoading(true);
    setError("");
    try {
      const optsRes = await api.get("/2fa/login/passkey/generate", {
        headers: { Authorization: `Bearer ${tempToken}` },
      });
      const options = optsRes.data.data;

      const asseResp = await startAuthentication(options);

      const verifyRes = await api.post("/2fa/login/passkey/verify", asseResp, {
        headers: { Authorization: `Bearer ${tempToken}` },
      });

      if (verifyRes.data.success) {
        finishLogin(verifyRes.data.data);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || "Passkey authentication failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleTotpLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      // First try TOTP
      let res;
      try {
        res = await api.post(
          "/2fa/login/totp/verify",
          { code: totpCode },
          {
            headers: { Authorization: `Bearer ${tempToken}` },
          }
        );
      } catch (err: any) {
        // Fallback to testing if it's a backup code
        if (totpCode.length === 8) {
          res = await api.post(
            "/2fa/login/backup/verify",
            { code: totpCode },
            {
              headers: { Authorization: `Bearer ${tempToken}` },
            }
          );
        } else {
          throw err;
        }
      }

      if (res?.data?.success) {
        finishLogin(res.data.data);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Неверный код подтверждения");
    } finally {
      setIsLoading(false);
    }
  };

  const finishLogin = (data: any) => {
    login(data.token, data.user, data.school);
    const role = data.user.role;
    if (role === "SUPERADMIN") {
      navigate("/superadmin/dashboard");
    } else {
      const resolvedSlug = data.school?.slug || "";
      const roleStr = role.toLowerCase();
      navigate(`/${resolvedSlug}/${roleStr}/dashboard`);
    }
  };

  if (!tempToken) return null;

  return (
    <AuthLayout schoolName="Shamdan">
      <AuthCard>
        <div className="mb-6 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-full mb-3 shadow-sm">
            <ShieldCheck size={11} />
            Защищённый вход
          </div>
          <h1 className="text-2xl font-extrabold text-slate-800 mb-1.5 tracking-tight animate-in fade-in">
            Двухфакторная защита
          </h1>
          <p className="text-slate-500 text-[13px] leading-relaxed">
            Подтвердите личность с помощью ключа доступа или приложения.
          </p>
        </div>

        {error && <AuthAlert message={error} type="error" />}

        {usePasskey ? (
          <div className="space-y-6">
            <div className="flex flex-col items-center py-4 space-y-4">
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-200 shadow-[0_4px_20px_rgba(16,185,129,0.06)] ring-1 ring-emerald-400/20">
                <Fingerprint size={32} />
              </span>
              <p className="text-slate-500 text-xs text-center max-w-[280px] leading-relaxed">
                Используйте встроенный датчик отпечатков пальцев, распознавание лица или PIN-код.
              </p>
            </div>

            <AuthButton onClick={handlePasskeyLogin} isLoading={isLoading}>
              Подтвердить с помощью Passkey
            </AuthButton>

            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setUsePasskey(false);
                  setError("");
                }}
                className="text-emerald-600 hover:text-emerald-500 text-xs font-bold transition-colors flex items-center gap-1.5 justify-center mx-auto"
              >
                <Keyboard size={13} />
                Другой способ (Код/Приложение)
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleTotpLogin} className="space-y-6">
            <div className="space-y-4">
              <AuthInput
                type="text"
                required
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.trim())}
                placeholder="000000"
                label="Код аутентификатора или Backup-код"
                className="text-center text-xl tracking-[0.2em] font-semibold text-emerald-600 placeholder-slate-300 focus:border-emerald-500"
              />
            </div>

            <AuthButton isLoading={isLoading} disabled={!totpCode}>
              Подтвердить
            </AuthButton>

            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setUsePasskey(true);
                  setError("");
                }}
                className="text-emerald-600 hover:text-emerald-500 text-xs font-bold transition-colors flex items-center gap-1.5 justify-center mx-auto"
              >
                <Fingerprint size={13} />
                Использовать Passkey
              </button>
            </div>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
