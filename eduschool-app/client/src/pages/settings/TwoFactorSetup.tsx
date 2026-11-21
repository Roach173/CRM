import { useState } from 'react';
import { useNavigate } from 'react-router';
import { startRegistration } from '@simplewebauthn/browser';
import api from '../../lib/api';
import { Spinner } from '../../components/ui/Spinner';


export default function TwoFactorSetup() {
  const navigate = useNavigate();
  
  const [step, setStep] = useState<'intro' | 'method-select' | 'totp-setup' | 'backup-codes'>('intro');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // TOTP State
  const [qrCode, setQrCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  
  // Backup Codes State
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  // We should check if 2FA is already enabled. The user might want to add another method.
  // We'll skip forcing an error if already enabled, just let them add more.

  const handleSetupPasskey = async () => {
    setIsLoading(true);
    setError('');
    try {
      const optsRes = await api.get('/2fa/setup/passkey/generate');
      const options = optsRes.data.data;

      let asseResp;
      try {
        asseResp = await startRegistration(options);
      } catch (err: any) {
         if (err.name === 'NotAllowedError') {
            setError('Операция отменена. Пожалуйста, попробуйте еще раз.');
            setIsLoading(false);
            return;
         }
         throw err;
      }

      const verifyRes = await api.post('/2fa/setup/passkey/verify', asseResp);
      
      if (verifyRes.data.success) {
        if (verifyRes.data.data.backupCodes) {
           setBackupCodes(verifyRes.data.data.backupCodes);
           setStep('backup-codes');
        } else {
           navigate(-1); // Or back to settings
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Ошибка настройки Passkey');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartTotp = async () => {
     setIsLoading(true);
     setError('');
     try {
       const res = await api.get('/2fa/setup/totp/generate');
       if (res.data.success) {
           setQrCode(res.data.data.qrDataUrl);
           setStep('totp-setup');
       }
     } catch(err: any) {
        setError(err.response?.data?.error || 'Ошибка при генерации TOTP');
     } finally {
        setIsLoading(false);
     }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
      e.preventDefault();
      setIsLoading(true);
      setError('');
      try {
        const res = await api.post('/2fa/setup/totp/verify', { code: totpCode });
        if (res.data.success) {
            if (res.data.data.backupCodes) {
                setBackupCodes(res.data.data.backupCodes);
                setStep('backup-codes');
            } else {
                navigate(-1);
            }
        }
      } catch(err: any) {
          setError(err.response?.data?.error || 'Неверный код TOTP');
      } finally {
          setIsLoading(false);
      }
  };

  const handleFinish = () => {
      navigate(-1);
  };

  return (
    <div className="min-h-screen bg-background text-surface flex items-center justify-center font-sans px-4 py-12">
      <div className="w-full max-w-[500px] bg-white rounded-3xl shadow-xl overflow-hidden border border-border/10 p-8 md:p-12 relative">
        <button 
          onClick={() => navigate(-1)}
          className="absolute top-6 left-6 text-textSecondary hover:text-primary transition-colors text-sm font-bold"
        >
           &larr; Назад
        </button>

        {error && (
          <div className="mt-8 mb-6 p-4 bg-danger/10 border-l-4 border-danger rounded-r-lg">
            <p className="text-danger text-sm font-medium">{error}</p>
          </div>
        )}

        {step === 'intro' && (
          <div className="mt-8 text-center animate-in fade-in zoom-in-95">
            <h2 className="font-serif text-3xl font-bold mb-4">Настройка 2FA</h2>
            <p className="text-textSecondary text-sm mb-8 leading-relaxed">
              Повысьте безопасность вашего аккаунта. Включите 2FA для добавления дополнительного шага при входе.
            </p>
            <button 
              onClick={() => setStep('method-select')}
              className="w-full py-4 bg-primary text-white rounded-2xl font-bold text-sm shadow-xl shadow-primary/20 hover:opacity-90 transition"
            >
              Включить двухфакторную аутентификацию
            </button>
          </div>
        )}

        {step === 'method-select' && (
          <div className="mt-8 text-center animate-in fade-in zoom-in-95">
             <h2 className="font-serif text-3xl font-bold mb-4">Выберите метод</h2>
             <p className="text-textSecondary text-sm mb-8 leading-relaxed">
                Мы рекомендуем использовать Passkey для быстрой и безопасной авторизации (через Touch ID, Face ID или Windows Hello).
             </p>

             <div className="space-y-4">
                <button 
                  onClick={handleSetupPasskey}
                  disabled={isLoading}
                  className="w-full py-4 bg-primary text-white rounded-2xl font-bold text-sm shadow-xl shadow-primary/20 hover:opacity-90 transition flex items-center justify-center"
                >
                  {isLoading ? <Spinner /> : 'Настроить Passkey'}
                </button>
                <button 
                  onClick={handleStartTotp}
                  disabled={isLoading}
                  className="w-full py-4 bg-surfaceLow text-surface rounded-2xl font-bold text-sm hover:bg-surfaceLow/70 transition border border-border/10"
                >
                  Использовать приложение аутентификатор (TOTP)
                </button>
             </div>
          </div>
        )}

        {step === 'totp-setup' && (
          <div className="mt-8 text-center animate-in fade-in slide-in-from-right-4">
            <h2 className="font-serif text-3xl font-bold mb-4">Настройка TOTP</h2>
            <p className="text-textSecondary text-sm mb-6 leading-relaxed">
               Отсканируйте этот QR код в приложении Google Authenticator, Authy или аналогичном.
            </p>
            <div className="bg-white p-4 inline-block rounded-xl shadow-sm mb-6 border border-border/10">
               {qrCode && <img src={qrCode} alt="TOTP QR Code" className="w-48 h-48" />}
            </div>
            
            <form onSubmit={handleVerifyTotp} className="space-y-4">
              <div className="space-y-2">
                <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-textSecondary/50 text-left ml-1"> Введите полученный код </label>
                <input 
                  type="text" 
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.trim().substring(0, 6))}
                  placeholder="000000"
                  required
                  className="w-full bg-surfaceLow rounded-xl px-4 py-4 text-center text-2xl tracking-[0.25em] font-bold text-surface focus:ring-2 focus:ring-primary/20 border-none outline-none transition"
                />
              </div>
              <button 
                type="submit"
                disabled={isLoading || totpCode.length !== 6}
                className="w-full py-4 bg-primary text-white rounded-xl font-bold text-sm shadow-xl shadow-primary/20 hover:opacity-90 transition flex items-center justify-center disabled:opacity-50"
              >
                 {isLoading ? <Spinner /> : 'Подтвердить'}
              </button>
            </form>
          </div>
        )}

        {step === 'backup-codes' && (
          <div className="mt-8 text-center animate-in zoom-in-95">
             <div className="w-16 h-16 bg-success/10 text-success rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
             </div>
             <h2 className="font-serif text-3xl font-bold mb-4">Резервные коды</h2>
             <p className="text-textSecondary text-sm mb-6 leading-relaxed">
               2FA успешно включена! Сохраните эти коды в надежном месте. Они понадобятся, если вы потеряете доступ к своему устройству. <b>Коды показываются только один раз.</b>
             </p>
             
             <div className="grid grid-cols-2 gap-3 mb-8 bg-surfaceLow p-6 rounded-2xl border border-border/10">
                {backupCodes.map((c, i) => (
                   <div key={i} className="font-mono text-sm tracking-widest font-bold text-primary bg-white py-2 rounded shadow-sm">
                      {c.substring(0, 4)} {c.substring(4)}
                   </div>
                ))}
             </div>

             <button 
               onClick={handleFinish}
               className="w-full py-4 bg-primary text-white rounded-2xl font-bold text-sm shadow-xl shadow-primary/20 hover:opacity-90 active:scale-95 transition"
             >
               Я сохранил коды, продолжить
             </button>
          </div>
        )}
      </div>
    </div>
  );
}
