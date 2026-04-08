import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Package, FileText, Headphones, LogOut, Menu, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';

const navItems = [
    { to: '/', label: 'Projects', icon: <LayoutDashboard size={20} /> },
    { to: '/equipment', label: 'Equipment', icon: <Package size={20} /> },
    { to: '/documents', label: 'Documents', icon: <FileText size={20} /> },
    { to: '/contact', label: 'Support', icon: <Headphones size={20} /> },
];

export default function PortalLayout({ children }: { children: ReactNode }) {
    const { customer, logout } = useAuth();
    const navigate = useNavigate();
    const [mobileOpen, setMobileOpen] = useState(false);

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    return (
        <div className="portal-shell">
            <aside className="portal-sidebar">
                <div className="portal-brand">
                    <span className="brand-mark">HW</span>
                    <span className="brand-text">Client Portal</span>
                </div>

                <nav className="portal-nav">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.to === '/'}
                            className={({ isActive }) => `portal-nav-btn ${isActive ? 'portal-nav-btn--active' : ''}`}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                        </NavLink>
                    ))}
                </nav>

                <div className="portal-sidebar-footer">
                    {customer && (
                        <div className="portal-user-info">
                            <div className="portal-user-company">{customer.companyName}</div>
                            <div className="portal-user-email">{customer.contactEmail}</div>
                        </div>
                    )}
                    <button className="portal-nav-btn portal-nav-btn--danger" onClick={handleLogout}>
                        <LogOut size={18} />
                        <span>Sign Out</span>
                    </button>
                </div>
            </aside>

            {/* Mobile header */}
            <header className="portal-mobile-header">
                <button className="portal-hamburger" onClick={() => setMobileOpen(!mobileOpen)}>
                    {mobileOpen ? <X size={24} /> : <Menu size={24} />}
                </button>
                <span className="brand-mark">HW</span>
                <span className="brand-text">Client Portal</span>
            </header>

            {/* Mobile drawer */}
            {mobileOpen && (
                <div className="portal-mobile-overlay" onClick={() => setMobileOpen(false)}>
                    <nav className="portal-mobile-drawer" onClick={(e) => e.stopPropagation()}>
                        {navItems.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.to === '/'}
                                className={({ isActive }) => `portal-nav-btn ${isActive ? 'portal-nav-btn--active' : ''}`}
                                onClick={() => setMobileOpen(false)}
                            >
                                {item.icon}
                                <span>{item.label}</span>
                            </NavLink>
                        ))}
                        <button className="portal-nav-btn portal-nav-btn--danger" onClick={handleLogout}>
                            <LogOut size={18} />
                            <span>Sign Out</span>
                        </button>
                    </nav>
                </div>
            )}

            <main className="portal-main">
                {children}
            </main>
        </div>
    );
}
