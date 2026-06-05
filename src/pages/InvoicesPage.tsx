import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Receipt, FileText, Search, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Invoice } from '../types'

// All-invoices view across every project the user has access to (RLS handles
// the per-user scoping). Each row links to its project; clicking the row
// opens the PDF inline (fetched live from Zoho via the invoice-pdf edge fn).

type InvoiceWithRelations = Invoice & {
  project?: { id: string; name: string } | null
  customer?: { company: string | null; name: string | null } | null
}

function formatDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return String(amount)
  }
}

function invoiceStatusColor(status: string | null): string {
  if (status === 'paid') return 'text-green-700 bg-green-100'
  if (status === 'overdue') return 'text-red-700 bg-red-100'
  if (status === 'partially_paid') return 'text-yellow-700 bg-yellow-100'
  return 'text-gray-600 bg-gray-100'
}

function invoiceStatusLabel(status: string | null): string {
  if (!status) return 'Open'
  return status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default function InvoicesPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [invoices, setInvoices] = useState<InvoiceWithRelations[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void fetchInvoices()
  }, [])

  async function fetchInvoices() {
    setLoading(true)
    // RLS gates rows: customer sees own; admin sees all. The customer
    // embed pulls company name so admins can scan whose invoice is whose.
    const { data } = await supabase
      .from('invoices')
      .select('*, project:projects(id, name), customer:customers(company, name)')
      .order('invoice_date', { ascending: false, nullsFirst: false })
    setInvoices((data ?? []) as InvoiceWithRelations[])
    setLoading(false)
  }

  async function viewInvoice(inv: Invoice) {
    setOpeningId(inv.id)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
        body: JSON.stringify({ invoiceId: inv.id }),
      })
      if (!res.ok) {
        let msg = 'Could not open this invoice.'
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
        setError(msg)
        return
      }
      const blob = await res.blob()
      window.open(URL.createObjectURL(blob), '_blank')
    } catch {
      setError('Could not open this invoice.')
    } finally {
      setOpeningId(null)
    }
  }

  const filtered = invoices.filter(inv => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      (inv.invoice_number ?? '').toLowerCase().includes(q)
      || (inv.project?.name ?? '').toLowerCase().includes(q)
      || (inv.customer?.company ?? '').toLowerCase().includes(q)
      || (inv.status ?? '').toLowerCase().includes(q)
    )
  })

  // Summary stats — only meaningful when filter is empty (full list).
  const outstandingTotal = invoices.reduce((sum, inv) => {
    const b = Number(inv.balance)
    return !isNaN(b) && b > 0 ? sum + b : sum
  }, 0)
  const outstandingCurrency = invoices.find(i => Number(i.balance) > 0)?.currency_code || 'USD'
  const outstandingCount = invoices.filter(i => Number(i.balance) > 0).length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
        <p className="text-gray-500 text-sm mt-1">
          {isAdmin
            ? 'Every invoice across all customers, synced from Zoho Books.'
            : 'All your invoices in one place, synced from Zoho Books.'}
        </p>
      </div>

      {/* Outstanding-balance summary card */}
      {!loading && invoices.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5 max-w-xs">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <Receipt size={16} />
            <span className="text-xs font-medium uppercase tracking-wide">Outstanding</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatMoney(outstandingTotal, outstandingCurrency)}</p>
          <p className="text-xs text-gray-400 mt-1">
            {outstandingCount === 0 ? 'All caught up' : `Across ${outstandingCount} invoice${outstandingCount === 1 ? '' : 's'}`}
          </p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="p-4 border-b border-gray-100">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by invoice #, project, customer, or status…"
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
        )}

        {loading ? (
          <div className="flex justify-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14">
            <Receipt className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">
              {invoices.length === 0 ? 'No invoices yet' : 'No invoices match your search'}
            </p>
            <p className="text-gray-400 text-xs mt-1">
              {invoices.length === 0
                ? 'Invoices synced from Zoho Books will appear here.'
                : 'Try a different invoice number, project, or status.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(inv => (
              <div key={inv.id} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <button
                  onClick={() => viewInvoice(inv)}
                  disabled={openingId === inv.id}
                  title="View invoice PDF"
                  className="flex items-center gap-3 min-w-0 text-left flex-1 disabled:opacity-60"
                >
                  <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText size={16} className="text-blue-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">
                      {inv.invoice_number || '(no number)'}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      {inv.project ? (
                        <Link
                          to={`/projects/${inv.project.id}`}
                          onClick={e => e.stopPropagation()}
                          className="text-blue-600 hover:underline"
                        >
                          {inv.project.name}
                        </Link>
                      ) : isAdmin && inv.customer?.company ? (
                        <span>{inv.customer.company}</span>
                      ) : (
                        <span className="italic">No project</span>
                      )}
                      {' · '}
                      {formatDate(inv.invoice_date)}
                      {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}
                    </p>
                  </div>
                </button>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">{formatMoney(inv.total, inv.currency_code)}</p>
                    {Number(inv.balance) > 0 && (
                      <p className="text-xs text-amber-600">{formatMoney(inv.balance, inv.currency_code)} due</p>
                    )}
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${invoiceStatusColor(inv.status)}`}>
                    {invoiceStatusLabel(inv.status)}
                  </span>
                  <button
                    onClick={() => viewInvoice(inv)}
                    disabled={openingId === inv.id}
                    className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-60"
                    title="Open PDF"
                  >
                    <ExternalLink size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
