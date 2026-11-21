import { Link, useLocation, useParams } from 'react-router';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useMobileChrome } from '../../context/MobileChromeContext';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Logo } from '../Logo';
import {
 Menu, Home, Bell, Users, ClipboardCheck, Calendar, User,
 Banknote, CreditCard, FileText, Settings, Clipboard,
 TrendingUp, BookOpen, HelpCircle, LogOut, Upload,
 MoreHorizontal, X, GraduationCap, ChevronRight, Send,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn as cx } from '../../lib/cn';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';

export type SidebarMode = 'expanded' | 'collapsed' | 'mobile';

export interface SidebarNavItem {
 name: string;
 href: string;
 icon: LucideIcon;
 category: string;
 collapsedLabel?: string;
 avatar?: string;
 hasNotification?: boolean;
}

export interface SidebarSection {
 title: string;
 items: SidebarNavItem[];
}

type CollapsedEntry =
 | { type: 'item'; item: SidebarNavItem; section: SidebarSection }
 | { type: 'group'; item: SidebarNavItem; section: SidebarSection };

type IconKey = keyof typeof NAV_ICONS;

const NAV_ICONS: Record<string, LucideIcon> = {
 home: Home,
 bell: Bell,
 send: Send,
 users: Users,
 check: ClipboardCheck,
 calendar: Calendar,
 teacher: GraduationCap,
 money: Banknote,
 card: CreditCard,
 receipt: FileText,
 settings: Settings,
 clipboard: Clipboard,
 analytics: TrendingUp,
 book: BookOpen,
 help: HelpCircle,
 upload: Upload,
 more: MoreHorizontal,
 close: X,
 student: User,
};

interface NavItem {
 name: string;
 href: string;
 icon: IconKey;
 category: string;
}

interface ProfileDropdownLink {
 name: string;
 href: string;
 icon: IconKey;
}

interface SidebarProps {
 sections?: SidebarSection[];
 brandName?: string;
 subtitle?: string;
 showLogo?: boolean;
 helpHref?: string;
 onLogout?: () => void;
 logoutLabel?: string;
 onCollapsedChange?: (collapsed: boolean) => void;
 storageKey?: string;
 openSectionsStorageKey?: string;
 hasUnreadNotifications?: boolean;
}

const SIDEBAR_COLLAPSED_WIDTH = 80;
const TABLET_COLLAPSE_WIDTH = 1180;
const MOBILE_BREAKPOINT = 768;
const SERVICE_SECTION_TITLES = new Set(['FOOTER', 'ACTIONS']);
const SERVICE_ITEM_NAMES = new Set(['Помощь', 'Настройки', 'Импорт/Экспорт']);
const COLLAPSED_LABELS: Record<string, string> = {
 'Панель управления': 'Панель',
 Уведомления: 'Увед.',
 Студенты: 'Студ.',
 Расписание: 'Распис.',
 Группы: 'Группы',
 Учителя: 'Учит.',
 Зарплата: 'З/п',
 Финансы: 'Финансы',
 Инвойсы: 'Инвойсы',
 'Фин. контроль': 'Контроль',
 Главная: 'Главная',
 Календарь: 'Календ.',
 Задания: 'Задания',
 Ресурсы: 'Ресурсы',
 Посещаемость: 'Посещ.',
 Оплата: 'Оплата',
 Школы: 'Школы',
 Сотрудники: 'Сотр.',
 CRM: 'CRM',
};


export function getNavigation(user: any, slug: string): NavItem[] {
 if (!user || !slug) return [];
 const roleString = user.role.toLowerCase();
 const base = `/${slug}/${roleString}`;

 switch (user.role) {
 case 'OWNER':
 return [
 // ponytail: soft-deleted per request — restore this line to bring back "Панель управления"
 // { name: 'Панель управления', href: `${base}/dashboard`,               icon: 'home',      category: 'ОСНОВНОЕ' },
 { name: 'Уведомления',      href: `${base}/notifications`,            icon: 'bell',      category: 'ОСНОВНОЕ' },
 { name: 'Студенты',         href: `${base}/students`,                 icon: 'users',     category: 'ОБЩЕЕ' },
 { name: 'Группы',           href: `${base}/groups`,                   icon: 'users',     category: 'ОБЩЕЕ' },
 { name: 'Расписание',       href: `${base}/schedule`,                 icon: 'calendar',  category: 'ОБЩЕЕ' },
 { name: 'Сотрудники',       href: `${base}/staff`,                    icon: 'users',     category: 'ОБЩЕЕ' },
 { name: 'Зарплата',         href: `${base}/salary`,                   icon: 'money',     category: 'ОБЩЕЕ' },
 { name: 'Финансы',          href: `${base}/finance-dashboard`,        icon: 'analytics', category: 'ОБЩЕЕ' },
 { name: 'Фин. контроль',    href: `${base}/finance-control`,          icon: 'check',     category: 'ОБЩЕЕ' },
 { name: 'Коммуникации',     href: `${base}/communications`,          icon: 'send',      category: 'СИСТЕМА' },
 ];
 case 'ADMIN':
 return [
 { name: 'Уведомления',      href: `${base}/notifications`,            icon: 'bell',      category: 'ОСНОВНОЕ' },
 { name: 'Студенты',         href: `${base}/students`,                 icon: 'users',     category: 'ОБЩЕЕ' },
 { name: 'Группы',           href: `${base}/groups`,                   icon: 'users',     category: 'ОБЩЕЕ' },
 { name: 'Расписание',       href: `${base}/schedule`,                 icon: 'calendar',  category: 'ОБЩЕЕ' },
 { name: 'Учителя',          href: `${base}/teachers`,                 icon: 'teacher',   category: 'ОБЩЕЕ' },
 { name: 'Зарплата',         href: `${base}/salary`,                   icon: 'money',     category: 'ОБЩЕЕ' },
 { name: 'Коммуникации',     href: `${base}/communications`,          icon: 'send',      category: 'СИСТЕМА' },
 ];
 case 'TEACHER':
 return [
 { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: 'ОСНОВНОЕ' },
 { name: 'Расписание', href: `${base}/schedule`, icon: 'calendar', category: 'ОСНОВНОЕ' },
 { name: 'Зарплата', href: `${base}/salary`, icon: 'money', category: 'ОСНОВНОЕ' },
 ];
 case 'STUDENT':
 return [
 { name: 'Главная', href: `${base}/dashboard`, icon: 'home', category: 'ОСНОВНОЕ' },
 { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: 'ОСНОВНОЕ' },
 { name: 'Календарь', href: `${base}/schedule`, icon: 'calendar', category: 'ОСНОВНОЕ' },
 ];
 case 'PARENT':
 return [
 { name: 'Главная', href: `${base}/dashboard`, icon: 'home', category: 'ОСНОВНОЕ' },
 { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: 'ОСНОВНОЕ' },
 ];
 default:
 return [];
 }
}

export function getMobileBottomNav(user: any, slug: string): NavItem[] {
 if (!user || !slug) return [];
 const base = `/${slug}/${user.role.toLowerCase()}`;
 switch (user.role) {
  case 'OWNER': return [
   { name: 'Студенты',   href: `${base}/students`,    icon: 'users',     category: '' },
   { name: 'Расписание', href: `${base}/schedule`,    icon: 'calendar',  category: '' },
   { name: 'Группы',     href: `${base}/groups`,      icon: 'users',     category: '' },
  ];
  case 'ADMIN': return [
   { name: 'Студенты',   href: `${base}/students`,    icon: 'users',     category: '' },
   { name: 'Расписание', href: `${base}/schedule`,    icon: 'calendar',  category: '' },
   { name: 'Зарплата',   href: `${base}/salary`,      icon: 'money',     category: '' },
  ];
  case 'TEACHER': return [
   { name: 'Расписание', href: `${base}/schedule`,    icon: 'calendar',  category: '' },
   { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: '' },
   { name: 'Зарплата',   href: `${base}/salary`,      icon: 'money',     category: '' },
  ];
  case 'STUDENT': return [
   { name: 'Главная',    href: `${base}/dashboard`,   icon: 'home',      category: '' },
   { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: '' },
   { name: 'Расписание', href: `${base}/schedule`,    icon: 'calendar',  category: '' },
  ];
  case 'PARENT': return [
   { name: 'Главная', href: `${base}/dashboard`, icon: 'home', category: '' },
   { name: 'Уведомления', href: `${base}/notifications`, icon: 'bell', category: '' },
   { name: 'Профиль', href: `/${slug}/profile`, icon: 'student', category: '' },
  ];
  default: return [];
 }
}

export function getProfileDropdownLinks(slug: string, role?: string): ProfileDropdownLink[] {
 const roleSettingsHref = role ? `/${slug}/${role.toLowerCase()}/settings` : `/${slug}/settings`;

 const links: ProfileDropdownLink[] = [
 { name: 'Мой профиль', href: `/${slug}/profile`, icon: 'student' },
 { name: 'Настройки уведомлений', href: `/${slug}/settings/notifications`, icon: 'bell' },
 ];
 if (role !== 'STUDENT' && role !== 'TEACHER') {
 links.push({ name: 'Настройки', href: roleSettingsHref, icon: 'settings' });
 }
 return links;
}

function normalizeNavItems(items: NavItem[]): SidebarNavItem[] {
 return items.map(item => ({
 ...item,
 icon: NAV_ICONS[item.icon] ?? MoreHorizontal,
 collapsedLabel: COLLAPSED_LABELS[item.name],
 }));
}

function isNotificationsHref(href: string) {
 return href.includes('/notifications');
}

function withNotificationBadge(items: SidebarNavItem[], hasUnreadNotifications: boolean): SidebarNavItem[] {
 return items.map(item => (
 isNotificationsHref(item.href)
 ? { ...item, hasNotification: hasUnreadNotifications }
 : item
 ));
}

function withNotificationBadgeSections(sections: SidebarSection[], hasUnreadNotifications: boolean): SidebarSection[] {
 return sections.map(section => ({
 ...section,
 items: withNotificationBadge(section.items, hasUnreadNotifications),
 }));
}

export function createSidebarSections(items: SidebarNavItem[]): SidebarSection[] {
 const grouped = new Map<string, SidebarNavItem[]>();

 items.forEach(item => {
 const title = item.category || 'MENU';
 grouped.set(title, [...(grouped.get(title) ?? []), item]);
 });

 return Array.from(grouped.entries()).map(([title, sectionItems]) => ({
 title,
 items: sectionItems,
 }));
}

function readCollapsed(storageKey: string): boolean | null {
 try {
 const raw = localStorage.getItem(storageKey);
 if (raw === null) return null;
 return raw === '1';
 } catch {
 return null;
 }
}

function writeCollapsed(storageKey: string, value: boolean) {
 try {
 localStorage.setItem(storageKey, value ? '1' : '0');
 } catch {}
}

function readOpenSections(storageKey: string, allCategories: string[]): Set<string> {
 try {
 const raw = localStorage.getItem(storageKey);
 if (raw === null) return new Set(allCategories);
 return new Set(JSON.parse(raw) as string[]);
 } catch {
 return new Set(allCategories);
 }
}

function writeOpenSections(storageKey: string, value: Set<string>) {
 try {
 localStorage.setItem(storageKey, JSON.stringify([...value]));
 } catch {}
}

function getInitialExpanded(storageKey: string) {
 const storedCollapsed = readCollapsed(storageKey);
 if (storedCollapsed !== null) return !storedCollapsed;
 if (typeof window === 'undefined') return true;
 return window.innerWidth >= TABLET_COLLAPSE_WIDTH;
}

function clampFlyoutTop(top: number) {
 if (typeof window === 'undefined') return top;
 return Math.max(72, Math.min(top, window.innerHeight - 420));
}

function getCollapsedLabel(item: SidebarNavItem) {
 return item.collapsedLabel ?? COLLAPSED_LABELS[item.name] ?? item.name;
}

function isServiceSection(section: SidebarSection) {
 return SERVICE_SECTION_TITLES.has(section.title.toUpperCase());
}

function isServiceItem(item: SidebarNavItem) {
 return SERVICE_ITEM_NAMES.has(item.name);
}

export default function Sidebar({
 sections: providedSections,
 brandName,
 subtitle = 'Shamdan',
 showLogo = false,
 helpHref,
 onLogout,
 logoutLabel = 'Выйти',
 onCollapsedChange,
 storageKey = 'school_sb_collapsed',
 openSectionsStorageKey = 'school_sb_open_sections',
 hasUnreadNotifications = false,
}: SidebarProps) {
 const location = useLocation();
 const { slug } = useParams<{ slug: string }>();
 const { user, school } = useAuth();
 const closeFlyoutTimer = useRef<number | null>(null);
 const openSectionsReady = useRef(false);

 const defaultSections = useMemo(
 () => createSidebarSections(withNotificationBadge(normalizeNavItems(getNavigation(user, slug || '')), hasUnreadNotifications)),
 [hasUnreadNotifications, slug, user]
 );
 const sections = useMemo(
 () => providedSections ? withNotificationBadgeSections(providedSections, hasUnreadNotifications) : defaultSections,
 [defaultSections, hasUnreadNotifications, providedSections]
 );
 const sectionTitles = useMemo(() => sections.map(section => section.title), [sections]);
 const allItems = useMemo(() => sections.flatMap(section => section.items), [sections]);

 const mobileBottomNavItems = useMemo(
  () => withNotificationBadge(normalizeNavItems(getMobileBottomNav(user, slug || '')), hasUnreadNotifications),
  [hasUnreadNotifications, slug, user]
 );
 const mobileBottomNavHrefs = useMemo(
  () => new Set(mobileBottomNavItems.map(i => i.href)),
  [mobileBottomNavItems]
 );
 const mobileSheetItems = useMemo(
  () => allItems.filter(item => !mobileBottomNavHrefs.has(item.href) && !isServiceItem(item)),
  [allItems, mobileBottomNavHrefs]
 );
 const mobileMoreHasNotification = mobileSheetItems.some(item => item.hasNotification);

 const [isExpanded, setIsExpanded] = useState(() => getInitialExpanded(storageKey));
 const [activeItem, setActiveItem] = useState('');
 const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
 const [isMobileOpen, setIsMobileOpen] = useState(false);
 const [bottomSheetOpen, setBottomSheetOpen] = useState(false);
 const { navHidden } = useMobileChrome();
 const [openSections, setOpenSections] = useState<Set<string>>(() =>
 readOpenSections(openSectionsStorageKey, sectionTitles)
 );
 const [flyoutTop, setFlyoutTop] = useState(96);
 const [profileOpen, setProfileOpen] = useState(false);
 const [profileDropdownPos, setProfileDropdownPos] = useState({ bottom: 80, left: 12, width: 248 });
 const profileButtonRef = useRef<HTMLButtonElement>(null);
 const profileDropdownRef = useRef<HTMLDivElement>(null);
 const profileLinks = useMemo(
  () => getProfileDropdownLinks(slug || '', user?.role),
  [slug, user?.role]
 );

 const sidebarMode: SidebarMode = isMobileOpen ? 'mobile' : isExpanded ? 'expanded' : 'collapsed';
 const mobileDrawerOpen = sidebarMode === 'mobile';
 useBodyScrollLock(mobileDrawerOpen || bottomSheetOpen);
 useBackButtonClose(mobileDrawerOpen, closeMobile);
 useBackButtonClose(bottomSheetOpen, () => setBottomSheetOpen(false));
 const activeSection = hoveredGroup ? sections.find(section => section.title === hoveredGroup) : undefined;
 const brand = brandName ?? school?.name ?? 'Shamdan';
 const resolvedHelpHref = helpHref ?? (slug ? `/${slug}/help` : undefined);
 const collapsedEntries = useMemo<CollapsedEntry[]>(() => {
 // ponytail: every nav item gets its own collapsed icon — no foldering/flyout grouping.
 const entries: CollapsedEntry[] = [];

 sections.forEach(section => {
 if (isServiceSection(section)) return;
 section.items
 .filter(item => !isServiceItem(item))
 .forEach(item => entries.push({ type: 'item', item, section }));
 });

 return entries;
 }, [sections]);

  const isActive = useCallback((href: string) => {
    return location.pathname === href || location.pathname === `${href}/` || location.pathname.startsWith(`${href}/`);
  }, [location.pathname]);

  useEffect(() => {
    const nextActive = allItems.find(item => isActive(item.href));
    setActiveItem(nextActive?.href ?? '');
  }, [allItems, isActive]);

 useEffect(() => {
 onCollapsedChange?.(!isExpanded);
 }, [isExpanded, onCollapsedChange]);

 useEffect(() => {
 if (!sections.length) return;
 if (!openSectionsReady.current) {
 setOpenSections(readOpenSections(openSectionsStorageKey, sectionTitles));
 openSectionsReady.current = true;
 return;
 }
 setOpenSections(prev => {
 const next = new Set(prev);
 sectionTitles.forEach(title => next.add(title));
 return next;
 });
 }, [openSectionsStorageKey, sectionTitles, sections.length]);

 useEffect(() => {
 function handleResize() {
 const width = window.innerWidth;
 const storedCollapsed = readCollapsed(storageKey);

 if (width < TABLET_COLLAPSE_WIDTH && width >= MOBILE_BREAKPOINT) {
 setIsExpanded(false);
 return;
 }

 if (width >= TABLET_COLLAPSE_WIDTH && storedCollapsed !== null) {
 setIsExpanded(!storedCollapsed);
 return;
 }

 if (width >= TABLET_COLLAPSE_WIDTH) {
 setIsExpanded(true);
 }
 }

 handleResize();
 window.addEventListener('resize', handleResize);
 return () => window.removeEventListener('resize', handleResize);
 }, [storageKey]);

 useEffect(() => {
 if (isExpanded) setHoveredGroup(null);
 else setProfileOpen(false);
 }, [isExpanded]);

 useEffect(() => {
 if (!isMobileOpen) return;

 function handleEscape(event: KeyboardEvent) {
 if (event.key === 'Escape') setIsMobileOpen(false);
 }

 document.addEventListener('keydown', handleEscape);
 return () => document.removeEventListener('keydown', handleEscape);
 }, [isMobileOpen]);

 useEffect(() => {
 return () => {
 if (closeFlyoutTimer.current !== null) window.clearTimeout(closeFlyoutTimer.current);
 };
 }, []);

 useEffect(() => {
 if (!profileOpen) return;
 function handleClick(e: MouseEvent) {
 const target = e.target as Node;
 const inButton = profileButtonRef.current?.contains(target) ?? false;
 const inDropdown = profileDropdownRef.current?.contains(target) ?? false;
 if (!inButton && !inDropdown) setProfileOpen(false);
 }
 document.addEventListener('mousedown', handleClick);
 return () => document.removeEventListener('mousedown', handleClick);
 }, [profileOpen]);

 function toggleCollapse() {
 setIsExpanded(prev => {
 const next = !prev;
 writeCollapsed(storageKey, !next);
 return next;
 });
 }

 function toggleSection(title: string) {
 setOpenSections(prev => {
 const next = new Set(prev);
 if (next.has(title)) next.delete(title);
 else next.add(title);
 writeOpenSections(openSectionsStorageKey, next);
 return next;
 });
 }

 function closeMobile() {
 setIsMobileOpen(false);
 setProfileOpen(false);
 }

 function openFlyout(title: string, element: HTMLElement) {
 if (closeFlyoutTimer.current !== null) {
 window.clearTimeout(closeFlyoutTimer.current);
 closeFlyoutTimer.current = null;
 }
 setFlyoutTop(clampFlyoutTop(element.getBoundingClientRect().top));
 setHoveredGroup(title);
 }

 function scheduleCloseFlyout() {
 if (closeFlyoutTimer.current !== null) window.clearTimeout(closeFlyoutTimer.current);
 closeFlyoutTimer.current = window.setTimeout(() => setHoveredGroup(null), 120);
 }

 function keepFlyoutOpen() {
 if (closeFlyoutTimer.current !== null) {
 window.clearTimeout(closeFlyoutTimer.current);
 closeFlyoutTimer.current = null;
 }
 }

 function renderTooltip(label: string) {
 return (
 <span className="pointer-events-none fixed left-[86px] z-[70] rounded-sm bg-[#1f1f1f] px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-md transition-opacity delay-300 duration-150 group-hover:opacity-100">
 {label}
 </span>
 );
 }

 function renderExpandedItem(item: SidebarNavItem, onClick?: () => void) {
 const Icon = item.icon;
 const active = activeItem === item.href || isActive(item.href);

 return (
 <Link
 key={item.href}
 to={item.href}
 onClick={onClick}
 className={cx(
 'flex items-center gap-5 rounded-xl px-4 py-3 text-[15px] font-medium transition-colors duration-150',
 active
 ? 'sb-active font-semibold'
 : 'sb-hover'
 )}
 >
 <Icon className="h-6 w-6 flex-shrink-0" />
 <span className="min-w-0 truncate">{item.name}</span>
 {item.hasNotification && <span className="ml-auto h-2 w-2 rounded-full bg-primary" />}
 </Link>
 );
 }

 function renderHelpItem(onClick?: () => void) {
 const href = resolvedHelpHref ?? '/';

 return (
 <Link
 to={href}
 onClick={onClick}
 className="flex items-center gap-5 rounded-xl px-4 py-3 text-[15px] font-medium !text-textPrimary transition-colors duration-150 sb-hover"
 >
 <HelpCircle className="h-6 w-6 flex-shrink-0" />
 <span>Помощь</span>
 </Link>
 );
 }

 function renderSettingsItem(onClick?: () => void) {
 if (user?.role === 'STUDENT' || user?.role === 'TEACHER') return null;
 const href = slug && user ? `/${slug}/${user.role.toLowerCase()}/settings` : '/';
 return (
 <Link
 to={href}
 onClick={onClick}
 className="flex items-center gap-5 rounded-xl px-4 py-3 text-[15px] font-medium !text-textPrimary transition-colors duration-150 sb-hover"
 >
 <Settings className="h-6 w-6 flex-shrink-0" />
 <span>Настройки</span>
 </Link>
 );
 }

 function renderLogoutItem(mode: SidebarMode, onClick?: () => void) {
 if (!onLogout) return null;

 const handleClick = () => {
 onClick?.();
 onLogout();
 };

 if (mode === 'collapsed') {
 return (
 <button
 type="button"
 onClick={handleClick}
 className="group relative mx-auto flex min-h-16 w-[68px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center text-textPrimary transition-colors duration-150 hover:bg-danger/10 hover:text-danger"
 >
 <LogOut className="h-6 w-6 flex-shrink-0" />
 <span className="w-full max-w-16 truncate whitespace-nowrap px-0.5 text-[11px] leading-tight">{logoutLabel}</span>
 {renderTooltip(logoutLabel)}
 </button>
 );
 }

 return (
 <button
 type="button"
 onClick={handleClick}
 className="flex w-full items-center gap-5 rounded-xl px-4 py-3 text-left text-[15px] font-medium text-textPrimary transition-colors duration-150 hover:bg-danger/10 hover:text-danger"
 >
 <LogOut className="h-6 w-6 flex-shrink-0" />
 <span className="min-w-0 truncate">{logoutLabel}</span>
 </button>
 );
 }


 function renderCollapsedLink(item: SidebarNavItem) {
 const Icon = item.icon;
 const active = activeItem === item.href || isActive(item.href);
 const collapsedLabel = getCollapsedLabel(item);

 return (
 <Link
 key={item.href}
 to={item.href}
 onClick={() => setHoveredGroup(null)}
 className={cx(
 'group relative mx-auto flex min-h-16 w-[68px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors duration-150',
 active ? 'sb-active font-semibold' : 'sb-hover'
 )}
 >
 <Icon className="h-6 w-6 flex-shrink-0" />
 {item.hasNotification && <span className="absolute right-4 top-3 h-2 w-2 rounded-full bg-primary" />}
 <span className="w-full max-w-16 truncate whitespace-nowrap px-0.5 text-[11px] leading-tight">{collapsedLabel}</span>
 {renderTooltip(item.name)}
 </Link>
 );
 }

 function renderCollapsedGroup(section: SidebarSection) {
 const trigger = section.items[0];
 const Icon = trigger?.icon ?? MoreHorizontal;
 const sectionActive = section.items.some(item => activeItem === item.href || isActive(item.href));
 const isHovered = hoveredGroup === section.title;
 const collapsedLabel = trigger ? getCollapsedLabel(trigger) : section.title;

 return (
 <button
 key={section.title}
 type="button"
 onClick={event => openFlyout(section.title, event.currentTarget)}
 onMouseEnter={event => openFlyout(section.title, event.currentTarget)}
 onMouseLeave={scheduleCloseFlyout}
 className={cx(
 'group relative mx-auto flex min-h-16 w-[68px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center text-textPrimary transition-colors duration-150',
 sectionActive || isHovered
 ? 'sb-active font-semibold'
 : 'sb-hover'
 )}
 aria-expanded={isHovered}
 >
 <Icon className="h-6 w-6 flex-shrink-0" />
 {section.items.some(item => item.hasNotification) && <span className="absolute right-4 top-3 h-2 w-2 rounded-full bg-primary" />}
 <span className="w-full max-w-16 truncate whitespace-nowrap px-0.5 text-[11px] leading-tight">{collapsedLabel}</span>
 </button>
 );
 }

 function handleProfileButtonClick() {
 if (profileButtonRef.current) {
 const rect = profileButtonRef.current.getBoundingClientRect();
 setProfileDropdownPos({
 bottom: window.innerHeight - rect.top + 4,
 left: rect.left,
 width: Math.max(rect.width + 24, 220),
 });
 }
 setProfileOpen(v => !v);
 }

 function renderProfileSection(onClose?: () => void) {
 return (
 <div className="border-t border-border py-1">
 <div className="flex items-center">
 <button
 ref={profileButtonRef}
 type="button"
 onClick={handleProfileButtonClick}
 className="flex min-w-0 flex-1 items-center gap-5 rounded-xl px-4 py-3 text-[15px] font-medium transition-colors duration-150 sb-hover"
 >
 <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#e7f3ef] text-[10px] font-bold text-primary">
 {user?.firstName?.[0] ?? 'U'}
 </div>
 <span className="min-w-0 truncate text-textPrimary">
 {user?.firstName} {user?.lastName}
 </span>
 </button>
 <button
 type="button"
 onClick={() => { onClose?.(); onLogout?.(); }}
 className="mr-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-textSecondary transition-colors duration-150 hover:bg-danger/10 hover:text-danger"
 aria-label="Выйти"
 >
 <LogOut className="h-5 w-5" />
 </button>
 </div>
 </div>
 );
 }

 function renderExpandedSections(onItemClick?: () => void) {
 return sections.map((section, index) => {
 const sectionOpen = openSections.has(section.title);

 return (
 <div key={section.title} className={cx(index > 0 && 'border-t border-border pt-3', 'space-y-1')}>
 <button
 type="button"
 onClick={() => toggleSection(section.title)}
 className="flex w-full items-center justify-between rounded-lg px-4 py-2 text-left text-[15px] font-semibold text-textPrimary transition-colors duration-150 sb-hover"
 >
 <span className="truncate">{section.title}</span>
 <ChevronRight
 className={cx(
 'h-4 w-4 flex-shrink-0 text-textSecondary transition-transform duration-150',
 sectionOpen && 'rotate-90'
 )}
 />
 </button>

 {sectionOpen && (
 <div className="space-y-1">
 {section.items.map(item => renderExpandedItem(item, onItemClick))}
 </div>
 )}
 </div>
 );
 });
 }

 return (
 <>
 <button
 type="button"
 onClick={() => setIsMobileOpen(true)}
 className="hidden"
 aria-label="Открыть меню"
 >
 <Menu className="h-6 w-6" />
 </button>

 <aside
 className={cx(
 'fixed left-0 top-0 z-40 hidden h-screen flex-col text-textPrimary md:flex',
 isExpanded
 ? 'w-[272px] overflow-hidden border-r border-border dark:border-r-0 bg-card'
 : 'w-[80px] items-center overflow-visible border-r-0 bg-transparent shadow-none'
 )}
 >
 <div className={cx('flex flex-shrink-0 items-center gap-4', isExpanded ? 'h-20 justify-start px-4' : 'h-16 w-[80px] justify-center px-0')}>
 <button
 type="button"
 onClick={toggleCollapse}
 className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-textPrimary transition-colors duration-150 sb-hover"
 aria-label={isExpanded ? 'Свернуть меню' : 'Развернуть меню'}
 >
 <Menu className="h-6 w-6" />
 </button>

 {isExpanded && (
 <>
 {showLogo && (
 <span className="flex-shrink-0">
 <Logo size={28} variant="light" className="dark:hidden" />
 <Logo size={28} variant="dark" className="hidden dark:block" />
 </span>
 )}
 <div className="min-w-0 flex-1">
 <h2 className="truncate text-lg font-bold leading-tight text-textPrimary">{brand}</h2>
 <p className="mt-0.5 truncate text-xs font-medium text-textSecondary">{subtitle}</p>
 </div>
 <ThemeToggle />
 </>
 )}
 </div>

 <div
 className={cx(
 'sidebar-content flex-1',
 isExpanded
 ? 'custom-scrollbar overflow-y-auto overflow-x-hidden px-3 pb-4'
 : 'w-[80px] custom-scrollbar overflow-y-auto px-0 pb-2'
 )}
 >
 {isExpanded ? (
 <>
 <nav className="space-y-3 py-2">
 {renderExpandedSections()}
 </nav>
 <div className="border-t border-border py-3">
 {renderHelpItem()}
 {renderSettingsItem()}
 </div>
 {renderProfileSection()}
 </>
 ) : (
 <div className="flex w-[80px] flex-col items-center gap-2 px-1 py-2">
 {collapsedEntries.map(entry =>
 entry.type === 'item'
 ? renderCollapsedLink(entry.item)
 : renderCollapsedGroup(entry.section)
 )}
 {slug && user && user.role !== 'STUDENT' && user.role !== 'TEACHER' && (
 <Link
 to={`/${slug}/${user.role.toLowerCase()}/settings`}
 className="group relative mx-auto flex min-h-16 w-[68px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors duration-150 sb-hover"
 >
 <Settings className="h-6 w-6 flex-shrink-0" />
 <span className="w-full max-w-16 truncate whitespace-nowrap px-0.5 text-[11px] leading-tight">Настр.</span>
 {renderTooltip('Настройки')}
 </Link>
 )}
 <button
 ref={profileButtonRef}
 type="button"
 onClick={handleProfileButtonClick}
 className={cx(
 'group relative mx-auto flex min-h-16 w-[68px] flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-2 text-center transition-colors duration-150 sb-hover',
 profileOpen ? 'sb-active font-semibold' : ''
 )}
 >
 <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#e7f3ef] text-xs font-bold text-primary">
 {user?.firstName?.[0] ?? 'U'}
 </div>
 <span className="w-full max-w-16 truncate whitespace-nowrap px-0.5 text-[11px] leading-tight">Профиль</span>
 {renderTooltip(`${user?.firstName ?? ''} ${user?.lastName ?? ''}`)}
 </button>
 {renderLogoutItem('collapsed')}
 </div>
 )}
 </div>
 </aside>

 {!isExpanded && activeSection && (
 <>
 <div
 className="fixed z-[55] hidden w-4 md:block"
 style={{
 left: SIDEBAR_COLLAPSED_WIDTH,
 top: flyoutTop,
 height: Math.min(420, Math.max(180, activeSection.items.length * 54 + 96)),
 }}
 onMouseEnter={keepFlyoutOpen}
 onMouseLeave={scheduleCloseFlyout}
 />

 <div
 className="yt-sidebar-flyout fixed z-[60] hidden w-[320px] max-w-[calc(100vw-104px)] rounded-2xl bg-card p-4 text-textPrimary opacity-100 shadow-xl dark:shadow-[0_16px_42px_rgba(0,0,0,0.5)] ring-1 ring-border transition duration-200 ease-out md:block"
 style={{
 left: SIDEBAR_COLLAPSED_WIDTH + 14,
 top: flyoutTop,
 maxHeight: 'calc(100vh - 96px)',
 transform: 'translateX(0)',
 }}
 onMouseEnter={keepFlyoutOpen}
 onMouseLeave={scheduleCloseFlyout}
 >
 <h3 className="mb-3 px-1 text-xl font-bold leading-tight">{activeSection.title}</h3>
 <div className="custom-scrollbar max-h-[calc(100vh-168px)] space-y-1 overflow-y-auto">
 {activeSection.items.map(item => {
 const Icon = item.icon;
 const active = activeItem === item.href || isActive(item.href);

 return (
 <Link
 key={item.href}
 to={item.href}
 onClick={() => setHoveredGroup(null)}
 className={cx(
 'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors duration-150',
 active ? 'sb-active font-semibold' : 'sb-hover'
 )}
 >
 {item.avatar ? (
 <img src={item.avatar} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
 ) : (
 <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-surface">
 <Icon className="h-5 w-5" />
 </span>
 )}
 <span className="min-w-0 flex-1 truncate">{item.name}</span>
 {item.hasNotification && <span className="h-2 w-2 rounded-full bg-primary" />}
 </Link>
 );
 })}
 </div>
 </div>
 </>
 )}

 {mobileDrawerOpen && (
 <div className="fixed inset-0 z-50 md:hidden">
 <div
 className="yt-sidebar-overlay absolute inset-0 bg-black/40 opacity-100 transition-opacity duration-200"
 onClick={closeMobile}
 />
 <aside className="yt-sidebar-drawer relative flex h-full w-[280px] max-w-[86vw] flex-col overflow-hidden bg-card text-textPrimary shadow-2xl transition-transform duration-200 ease-out">
 <div className="flex h-20 flex-shrink-0 items-center gap-3 border-b border-border px-4">
 <button
 type="button"
 onClick={closeMobile}
 className="flex h-10 w-10 items-center justify-center rounded-full text-textPrimary transition-colors duration-150 sb-hover"
 aria-label="Закрыть меню"
 >
 <X className="h-6 w-6" />
 </button>
 {showLogo && (
 <span className="flex-shrink-0">
 <Logo size={28} variant="light" className="dark:hidden" />
 <Logo size={28} variant="dark" className="hidden dark:block" />
 </span>
 )}
 <div className="min-w-0 flex-1">
 <h2 className="truncate text-lg font-bold leading-tight">{brand}</h2>
 <p className="mt-0.5 truncate text-xs font-medium text-textSecondary">{subtitle}</p>
 </div>
 <ThemeToggle />
 </div>

 <div className="sidebar-content custom-scrollbar flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
 <nav className="space-y-3 py-4">
 {renderExpandedSections(closeMobile)}
 </nav>

 <div className="border-t border-border py-3">
 {renderHelpItem(closeMobile)}
 {renderSettingsItem(closeMobile)}
 </div>

 {renderProfileSection(closeMobile)}
 </div>
 </aside>
 </div>
 )}

 {/* ── Mobile bottom nav ── */}
 <nav
  className={`md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 border-t border-border/30 shadow-lg transition-transform duration-200 ${navHidden ? 'translate-y-full' : 'translate-y-0'}`}
  style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
 >
  <div className="flex items-stretch justify-around px-1 py-2">
   {mobileBottomNavItems.map(item => {
    const Icon = item.icon;
    const active = isActive(item.href);
    return (
     <Link
      key={item.href}
      to={item.href}
      className="flex flex-1 min-w-0 flex-col items-center gap-0.5 px-0.5 py-1.5 rounded-2xl transition"
     >
      <div className={`relative p-1.5 rounded-xl transition ${active ? 'bg-primary/10' : ''}`}>
       <Icon className={`w-5 h-5 transition-colors ${active ? 'text-primary' : 'text-textSecondary'}`} />
       {item.hasNotification && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary" />}
      </div>
      <span className={`w-full truncate text-center text-[0.625rem] font-bold uppercase leading-tight tracking-tight transition-colors ${active ? 'text-primary' : 'text-textSecondary/60'}`}>
       {item.name}
      </span>
     </Link>
    );
   })}
   <button
    type="button"
    onClick={() => setBottomSheetOpen(true)}
    className="flex flex-1 min-w-0 flex-col items-center gap-0.5 px-0.5 py-1.5 rounded-2xl"
   >
    <div className="relative p-1.5 rounded-xl">
     <MoreHorizontal className="w-5 h-5 text-textSecondary" />
     {mobileMoreHasNotification && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-primary" />}
    </div>
    <span className="w-full truncate text-center text-[0.625rem] font-bold uppercase leading-tight tracking-tight text-textSecondary/60">Ещё</span>
   </button>
  </div>
 </nav>

 {/* ── Bottom sheet "Ещё" ── */}
 {bottomSheetOpen && (
  <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end">
   <div
    className="absolute inset-0 bg-black/40"
    onClick={() => setBottomSheetOpen(false)}
   />
   <div
    className="relative bg-background rounded-t-3xl shadow-2xl overflow-hidden animate-slide-up"
    style={{ maxHeight: '80vh', paddingBottom: 'env(safe-area-inset-bottom)' }}
   >
    <div className="flex justify-center pt-3 pb-1">
     <div className="w-10 h-1 rounded-full bg-border/60" />
    </div>
    <div className="flex items-center justify-between px-6 py-3 border-b border-border/30">
     <span className="text-xs font-bold uppercase tracking-widest text-textSecondary">Меню</span>
     <button
      type="button"
      onClick={() => setBottomSheetOpen(false)}
      className="p-1.5 rounded-xl hover:bg-surfaceLow transition-colors"
     >
      <X className="w-4 h-4 text-textSecondary" />
     </button>
    </div>
    <div className="overflow-y-auto custom-scrollbar px-4 py-3 space-y-1">
     {mobileSheetItems.map(item => {
      const Icon = item.icon;
      const active = isActive(item.href);
      return (
       <Link
        key={item.href}
        to={item.href}
        onClick={() => setBottomSheetOpen(false)}
        className={`flex items-center gap-3 px-4 py-3 rounded-2xl transition ${
         active ? 'bg-primary/10 text-primary' : 'text-textSecondary hover:bg-surfaceLow'
        }`}
       >
        <Icon className={`w-5 h-5 flex-shrink-0 ${active ? 'text-primary' : ''}`} />
        <span className="min-w-0 flex-1 text-sm font-medium">{item.name}</span>
        {item.hasNotification && <span className="h-2 w-2 rounded-full bg-primary" />}
       </Link>
      );
     })}
    </div>
    <div className="px-4 pb-6 pt-2 border-t border-border/30">
     <button
      type="button"
      onClick={() => { setBottomSheetOpen(false); onLogout?.(); }}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-textSecondary hover:bg-danger/5 hover:text-danger transition"
     >
      <LogOut className="w-5 h-5 flex-shrink-0" />
      <span className="text-sm font-medium">Выйти</span>
     </button>
    </div>
   </div>
  </div>
 )}

 {profileOpen && (
 <div
 ref={profileDropdownRef}
 style={{
 position: 'fixed',
 bottom: profileDropdownPos.bottom,
 left: profileDropdownPos.left,
 width: profileDropdownPos.width,
 zIndex: 70,
 }}
 className="rounded-lg border border-border bg-card py-2 shadow-xl"
 >
 <div className="mb-1 border-b border-border px-4 py-3">
 <p className="text-sm font-semibold text-textPrimary">{user?.firstName} {user?.lastName}</p>
 <p className="mt-0.5 text-xs text-textSecondary">{user?.email}</p>
 </div>
 {profileLinks.map(link => {
 const Icon = NAV_ICONS[link.icon] ?? MoreHorizontal;
 return (
 <Link
 key={link.href}
 to={link.href}
 onClick={() => { setProfileOpen(false); if (isMobileOpen) setIsMobileOpen(false); }}
 className="mx-1 flex items-center gap-3 rounded-sm px-4 py-2.5 text-sm !text-textSecondary transition-colors duration-100 hover:bg-surface hover:!text-textPrimary"
 >
 <Icon className="h-4 w-4" />
 {link.name}
 </Link>
 );
 })}
 <div className="mt-1 border-t border-border pt-1">
 <button
 type="button"
 onClick={() => { setProfileOpen(false); if (isMobileOpen) setIsMobileOpen(false); onLogout?.(); }}
 className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-sm px-4 py-2.5 text-sm text-textSecondary transition-colors duration-100 hover:bg-[#FFF4F4] hover:text-critical"
 >
 <LogOut className="h-4 w-4" />
 Выйти
 </button>
 </div>
 </div>
 )}
 </>
 );
}

