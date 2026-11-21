import { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../../hooks/useAuth";
import api from "../../lib/api";
import { Eye, EyeOff, UserPlus, AlertCircle, CheckCircle2, User, Phone } from "lucide-react";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
} from "../../components/layout/AuthLayout";
import { MIN_PASSWORD_LENGTH, passwordTooShortMessage } from "../../lib/passwordPolicy";

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();
  const { login } = useAuth();

  const [status, setStatus] = useState<"validating" | "form" | "error" | "success">("validating");
  const [error, setError] = useState("");

  // School and invite details from validate response
  const [inviteData, setInviteData] = useState<{
    email: string;
    role: "ADMIN" | "TEACHER";
    firstName?: string;
    lastName?: string;
    phone?: string;
  } | null>(null);

  const [schoolData, setSchoolData] = useState<{
    name: string;
    slug: string;
  } | null>(null);

  // Form states
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Ссылка приглашения недействительна.");
      return;
    }

    setStatus("validating");
    api
      .get(`/invites/validate?token=${token}`)
      .then((res) => {
        if (res.data.success) {
          const { invite, school } = res.data.data;
          setInviteData(invite);
          setSchoolData(school);

          // Prefill values
          setFirstName(invite.firstName || "");
          setLastName(invite.lastName || "");
          setPhone(invite.phone || "");

          setStatus("form");
        } else {
          setStatus("error");
          setError("Ссылка приглашения недействительна или устарела.");
        }
      })
      .catch((err) => {
        setStatus("error");
        setError(err.response?.data?.error || "Ссылка приглашения недействительна или устарела.");
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (!firstName.trim() || !lastName.trim()) {
      setError("Имя и фамилия обязательны для заполнения.");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(passwordTooShortMessage() + ".");
      return;
    }

    if (password !== confirmPassword) {
      setError("Пароли не совпадают.");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const res = await api.post("/invites/accept", {
        token,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        password,
      });

      if (res.data.success) {
        setStatus("success");
        const { token: jwtToken, user, school } = res.data.data;

        // Log in immediately
        login(jwtToken, user, school);

        // Redirect based on role
        const role = user.role;
        const resolvedSlug = school?.slug || "";
        const roleStr = role.toLowerCase();
        const landingPage = role === "TEACHER" ? "schedule" : "dashboard";

        setTimeout(() => {
          navigate(`/${resolvedSlug}/${roleStr}/${landingPage}`, { replace: true });
        }, 1500);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Не удалось принять приглашение. Попробуйте еще раз.");
      setIsSubmitting(false);
    }
  };

  const roleLabels: Record<string, string> = {
    ADMIN: "Администратор",
    TEACHER: "Преподаватель",
  };
  const roleLabel = inviteData ? roleLabels[inviteData.role] || inviteData.role : "";

  return (
    <AuthLayout schoolName={schoolData?.name || "Shamdan"} slug={schoolData?.slug}>
      <AuthCard>
        {status === "validating" && (
          <div className="flex flex-col items-center py-10 space-y-4">
            <div className="w-10 h-10 rounded-full border-2 border-emerald-500/30 border-t-emerald-600 animate-spin" />
            <h2 className="text-xl font-bold text-slate-800">Проверяем приглашение...</h2>
          </div>
        )}

        {status === "error" && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 bg-rose-50 border border-rose-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <AlertCircle className="w-8 h-8 text-rose-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">
              Ссылка недействительна
            </h2>
            <p className="text-rose-700 text-sm leading-relaxed">{error}</p>
            <div className="text-xs text-slate-500 bg-slate-50 p-4 border border-slate-200/60 rounded-xl leading-relaxed">
              Пожалуйста, обратитесь к администратору вашей школы для повторной отправки приглашения.
            </div>
            <div className="pt-4 space-y-3">
              <Link
                to="/login"
                className="w-full py-3.5 block bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm text-center transition duration-200 shadow-md active:scale-[0.98]"
              >
                Перейти ко входу
              </Link>
              <Link
                to="/"
                className="w-full py-3.5 block bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl font-bold text-sm text-center transition-colors shadow-sm active:scale-[0.98]"
              >
                На главную
              </Link>
            </div>
          </div>
        )}

        {status === "success" && (
          <div className="text-center space-y-6 py-6">
            <div className="w-16 h-16 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">
              Приглашение принято!
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              Ваш аккаунт успешно создан. Входим в систему, пожалуйста, подождите...
            </p>
            <div className="flex justify-center pt-2">
              <div className="w-8 h-8 rounded-full border-2 border-emerald-500/30 border-t-emerald-600 animate-spin" />
            </div>
          </div>
        )}

        {status === "form" && inviteData && schoolData && (
          <>
            <div className="mb-6 text-center">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-full mb-3 shadow-sm">
                <UserPlus size={11} />
                {roleLabel}
              </div>
              <h1 className="text-2xl font-extrabold text-slate-800 mb-1.5 tracking-tight">
                Примите приглашение
              </h1>
              <p className="text-slate-500 text-[13px] leading-relaxed">
                Вас пригласили присоединиться к школе <br />
                <span className="font-semibold text-emerald-600">{schoolData.name}</span>
              </p>
            </div>

            {error && <AuthAlert message={error} type="error" />}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  Email
                </label>
                <input
                  type="email"
                  disabled
                  value={inviteData.email}
                  className="w-full px-0 py-2 bg-transparent border-0 border-b border-slate-200 text-slate-500 cursor-not-allowed opacity-60 text-[14px]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <AuthInput
                  id="firstName"
                  required
                  disabled={isSubmitting}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Иван"
                  label="Имя"
                  type="text"
                  icon={<User size={13} />}
                />

                <AuthInput
                  id="lastName"
                  required
                  disabled={isSubmitting}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Иванов"
                  label="Фамилия"
                  type="text"
                />
              </div>

              <AuthInput
                id="phone"
                disabled={isSubmitting}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 (999) 999-99-99"
                label="Телефон"
                type="tel"
                icon={<Phone size={13} />}
              />

              <div className="relative group">
                <AuthInput
                  id="password"
                  required
                  disabled={isSubmitting}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  label="Пароль"
                  type={showPassword ? "text" : "password"}
                  minLength={MIN_PASSWORD_LENGTH}
                  className="pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-0 bottom-2 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>

              <div className="relative group">
                <AuthInput
                  id="confirmPassword"
                  required
                  disabled={isSubmitting}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  label="Подтвердите пароль"
                  type={showConfirmPassword ? "text" : "password"}
                  minLength={MIN_PASSWORD_LENGTH}
                  className="pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-0 bottom-2 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                >
                  {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>

              <div className="pt-2">
                <AuthButton isLoading={isSubmitting}>Создать аккаунт и войти</AuthButton>
              </div>
            </form>

            <div className="mt-6 text-center border-t border-slate-200/60 pt-4">
              <p className="text-xs text-slate-500 transition">
                Уже есть аккаунт?{" "}
                <Link
                  to="/login"
                  className="text-emerald-600 hover:text-emerald-500 font-bold ml-1 transition-colors"
                >
                  Войти.
                </Link>
              </p>
            </div>
          </>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
