import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, LogOut, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Layout({ children }: { children: React.ReactNode }) {
  const { profile, signOut } = useAuth()
  const location = useLocation()

  return (
    <div className="flex h-screen bg-gray-50">
      <aside className="w-64 bg-slate-800 flex flex-col flex-shrink-0">
        <div className="p-6 border-b border-slate-700">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              CP
            </div>
            <span className="text-white font-semibold">Client Portal</span>
          </div>
          {profile?.company && (
            <p className="text-slate-400 text-xs mt-2 ml-11">{profile.company}</p>
          )}
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <Link
            to="/"
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              location.pathname === '/'
                ? 'bg-blue-600 text-white'
                : 'text-slate-300 hover:bg-slate-700 hover:text-white'
            }`}
          >
            <LayoutDashboard size={17} />
            Dashboard
          </Link>
          {profile?.role === 'admin' && (
            <Link
              to="/customers"
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                location.pathname.startsWith('/customers')
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <Users size={17} />
              Customers
            </Link>
          )}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <p className="text-white text-sm font-medium truncate">{profile?.full_name || 'User'}</p>
          <p className="text-slate-400 text-xs truncate mb-3">{profile?.email}</p>
          <button
            onClick={signOut}
            className="flex items-center gap-2 text-slate-400 hover:text-white text-sm transition-colors"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
