import React, { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Building2, LayoutDashboard, Settings } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import Sidebar, { createSidebarSections } from './Sidebar';
import type { SidebarNavItem } from './Sidebar';

interface SuperAdminLayoutProps {
 children: React.ReactNode;
}

export default function SuperAdminLayout({ children }: SuperAdminLayoutProps) {
 const { user, isLoading, logout } = useAuth();
 const navigate = useNavigate();
 const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

 const sections = useMemo(() => {
 const navigation: SidebarNavItem[] = [
 { name: 'Дашборд', href: '/superadmin/dashboard', icon: LayoutDashboard, category: 'ОСНОВНОЕ' },
 { name: 'Школы', href: '/superadmin/schools', icon: Building2, category: 'ОСНОВНОЕ' },
 { name: 'Настройки', href: '/superadmin/settings', icon: Settings, category: 'СИСТЕМА' },
 ];

 return createSidebarSections(navigation);
 }, []);

 if (isLoading) {
 return (
 <div className="min-h-screen flex items-center justify-center bg-background">
 <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
 </div>
 );
 }

 if (!user || user.role !== 'SUPERADMIN') {
 return <Navigate to="/login" replace />;
 }

 return (
 <div className="min-h-screen bg-background">
 <Sidebar
 sections={sections}
 brandName="Shamdan"
 subtitle="Super Admin Panel"
 showLogo
 onLogout={() => {
 logout();
 navigate('/login');
 }}
 onCollapsedChange={setSidebarCollapsed}
 />

 <main className={`${sidebarCollapsed ? 'md:ml-[80px]' : 'md:ml-[272px]'} min-h-screen transition duration-200`}>
 <div className="p-4 pt-20 sm:p-6 sm:pt-20 md:p-8 max-w-7xl mx-auto">
 {children}
 </div>
 </main>
 </div>
 );
}
