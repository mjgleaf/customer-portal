import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, LogOut, Users, Menu, X, Settings, Award, Receipt, FilePlus, Inbox, Shield } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { profile, signOut } = useAuth()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  const navLinkClass = (active: boolean) =>
    `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700 hover:text-white'
    }`

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar — static on desktop, slide-in drawer on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-800 flex flex-col transform transition-transform duration-200 md:static md:translate-x-0 md:z-auto ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-start gap-2">
            <div className="bg-white rounded-lg p-3 flex items-center justify-center flex-1 min-w-0">
              <img src="/logo.png" alt="Hydro-Wates" className="h-10 w-auto" />
            </div>
            <button
              onClick={() => setMobileOpen(false)}
              className="md:hidden text-slate-400 hover:text-white mt-1"
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          </div>
          {profile?.company && (
            <p className="text-slate-400 text-xs mt-2">{profile.company}</p>
          )}
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <Link to="/" onClick={() => setMobileOpen(false)} className={navLinkClass(location.pathname === '/')}>
            <LayoutDashboard size={17} />
            Dashboard
          </Link>
          {/* Customer-only aggregate views. Admins and service techs both
              skip these — admins have everything they need inside individual
              project pages, and techs don't deal with invoices or RFQs at
              all. Customers see them because they want the aggregate view
              across their company's projects. */}
          {profile?.role === 'customer' && (
            <>
              <Link
                to="/certificates"
                onClick={() => setMobileOpen(false)}
                className={navLinkClass(location.pathname.startsWith('/certificates'))}
              >
                <Award size={17} />
                Certificates
              </Link>
              <Link
                to="/invoices"
                onClick={() => setMobileOpen(false)}
                className={navLinkClass(location.pathname.startsWith('/invoices'))}
              >
                <Receipt size={17} />
                Invoices
              </Link>
              <Link
                to="/request-quote"
                onClick={() => setMobileOpen(false)}
                className={navLinkClass(location.pathname.startsWith('/request-quote'))}
              >
                <FilePlus size={17} />
                Request Quote
              </Link>
            </>
          )}
          {profile?.role === 'admin' && (
            <>
              <Link
                to="/customers"
                onClick={() => setMobileOpen(false)}
                className={navLinkClass(location.pathname.startsWith('/customers'))}
              >
                <Users size={17} />
                Customers
              </Link>
              <Link
                to="/quote-requests"
                onClick={() => setMobileOpen(false)}
                className={navLinkClass(location.pathname.startsWith('/quote-requests'))}
              >
                <Inbox size={17} />
                Quote Requests
              </Link>
            </>
          )}
          {/* Team directory — admins manage roles + invite; service techs
              get a read-only view so they have phone numbers handy on site. */}
          {(profile?.role === 'admin' || profile?.role === 'service_tech') && (
            <Link
              to="/team"
              onClick={() => setMobileOpen(false)}
              className={navLinkClass(location.pathname.startsWith('/team'))}
            >
              <Shield size={17} />
              Team
            </Link>
          )}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <p className="text-white text-sm font-medium truncate">{profile?.full_name || 'User'}</p>
          <p className="text-slate-400 text-xs truncate mb-3">{profile?.email}</p>
          <Link
            to="/account"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors mb-2"
          >
            <Settings size={15} />
            Account
          </Link>
          <button
            onClick={signOut}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar with hamburger */}
        <header className="md:hidden flex items-center gap-3 bg-slate-800 px-4 py-2.5 flex-shrink-0">
          <button onClick={() => setMobileOpen(true)} className="text-white" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <div className="bg-white rounded px-2 py-1">
            <img src="/logo.png" alt="Hydro-Wates" className="h-6 w-auto" />
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  )
}
