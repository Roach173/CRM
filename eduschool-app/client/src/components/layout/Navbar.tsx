import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/Button';
import { Menu, X } from 'lucide-react';
import { Logo } from '../Logo';

/* ── Shamdan Wordmark ────────────────────────────────────────── */
function Wordmark({ name }: { name?: string }) {
 return (
 <Link
 to="/"
 className="flex items-center gap-2.5 select-none group"
 aria-label="Shamdan — на главную"
 >
 <Logo size={28} className="group-hover:scale-105 transition-transform duration-150" aria-hidden="true" />
 <span className="text-heading-sm font-semibold text-textPrimary ">
 {name ?? 'Shamdan'}
 </span>
 </Link>
 );
}

export default function Navbar() {
 const { user, school, logout } = useAuth();
 const navigate = useNavigate();
 const [mobileOpen, setMobileOpen] = useState(false);

 const handleLogout = () => {
 logout();
 navigate('/');
 setMobileOpen(false);
 };

 const getDashboardLink = () => {
 if (!user) return '/';
 const activeSlug = school?.slug || localStorage.getItem('schoolSlug');
 const rolePath = `${user.role.toLowerCase()}/dashboard`;
 return `/${activeSlug}/${rolePath}`;
 };

 return (
 <header
 className="
 sticky top-0 z-sticky w-full
 bg-white/90
 border-b border-border
 "
 >
 <nav
 className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between"
 aria-label="Основная навигация"
 >
 {/* Logo */}
 <Wordmark name={school?.name} />

 {/* Desktop nav */}
 <div className="hidden md:flex items-center gap-2">
 {user ? (
 <>
 <Link
 to={getDashboardLink()}
 className="
 text-body-sm font-medium text-textSecondary
 hover:text-textPrimary transition-colors duration-150
 px-3 py-2 rounded-sm hover:bg-surface
 "
 >
 Личный кабинет
 </Link>
 <Button variant="outline" size="sm" onClick={handleLogout}>
 Выйти
 </Button>
 </>
 ) : (
 <>
 <Link
 to="/login"
 className="
 text-body-sm font-medium text-textSecondary
 hover:text-textPrimary transition-colors duration-150
 px-3 py-2 rounded-sm hover:bg-surface
 "
 >
 Войти
 </Link>
 <Button size="sm" onClick={() => navigate('/register')}>
 Начать бесплатно
 </Button>
 </>
 )}
 </div>

 {/* Mobile hamburger */}
 <button
 className="md:hidden p-2 rounded-sm text-textSecondary hover:text-textPrimary hover:bg-surface transition-colors"
 onClick={() => setMobileOpen(v => !v)}
 aria-label={mobileOpen ? 'Закрыть меню' : 'Открыть меню'}
 aria-expanded={mobileOpen}
 >
 {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
 </button>
 </nav>

 {/* Mobile menu */}
 {mobileOpen && (
 <div
 className="md:hidden border-t border-border bg-white px-4 pb-4 pt-2 space-y-1 animate-slide-down"
 role="navigation"
 aria-label="Мобильная навигация"
 >
 {user ? (
 <>
 <Link
 to={getDashboardLink()}
 onClick={() => setMobileOpen(false)}
 className="block px-3 py-2.5 text-body-sm font-medium text-textPrimary rounded-sm hover:bg-surface"
 >
 Личный кабинет
 </Link>
 <button
 onClick={handleLogout}
 className="block w-full text-left px-3 py-2.5 text-body-sm font-medium text-critical rounded-sm hover:bg-[#FFF4F4]"
 >
 Выйти
 </button>
 </>
 ) : (
 <>
 <Link
 to="/login"
 onClick={() => setMobileOpen(false)}
 className="block px-3 py-2.5 text-body-sm font-medium text-textPrimary rounded-sm hover:bg-surface"
 >
 Войти
 </Link>
 <div className="pt-1">
 <Button
 fullWidth
 onClick={() => { navigate('/register'); setMobileOpen(false); }}
 >
 Начать бесплатно
 </Button>
 </div>
 </>
 )}
 </div>
 )}
 </header>
 );
}
