import { NavLink } from 'react-router-dom';
import { Truck, Menu, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

const navItems = [
    { to: '/ops/load-out', label: 'Load Out a Job', icon: <Truck size={20} /> },
];

export default function OpsLayout({ children }: { children: ReactNode }) {
    const [mobileOpen, setMobileOpen] = useState(false);

    return (
        <div className="portal-shell">
            <aside className="portal-sidebar">
                <div className="portal-brand">
                    <span className="brand-mark">OPS</span>
                    <span className="brand-text">Operations</span>
                </div>

                <nav className="portal-nav">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            className={({ isActive }) => `portal-nav-btn ${isActive ? 'portal-nav-btn--active' : ''}`}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                        </NavLink>
                    ))}
                </nav>
            </aside>

            <header className="portal-mobile-header">
                <button className="portal-hamburger" onClick={() => setMobileOpen(!mobileOpen)}>
                    {mobileOpen ? <X size={24} /> : <Menu size={24} />}
                </button>
                <span className="brand-mark">OPS</span>
                <span className="brand-text">Operations</span>
            </header>

            {mobileOpen && (
                <div className="portal-mobile-overlay" onClick={() => setMobileOpen(false)}>
                    <nav className="portal-mobile-drawer" onClick={(e) => e.stopPropagation()}>
                        {navItems.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                className={({ isActive }) => `portal-nav-btn ${isActive ? 'portal-nav-btn--active' : ''}`}
                                onClick={() => setMobileOpen(false)}
                            >
                                {item.icon}
                                <span>{item.label}</span>
                            </NavLink>
                        ))}
                    </nav>
                </div>
            )}

            <main className="portal-main">
                {children}
            </main>
        </div>
    );
}
