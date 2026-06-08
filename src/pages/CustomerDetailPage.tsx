import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FolderOpen, Mail, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Customer, Project } from '../types'

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [invited, setInvited] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return
    if (profile.role !== 'admin') { navigate('/'); return }
    if (id) fetchData()
  }, [id, profile])

  async function fetchData() {
    setLoading(true)
    const { data: cust } = await supabase.from('cportal_customers').select('*').eq('id', id).single()
    if (!cust) { navigate('/customers'); return }
    setCustomer(cust as Customer)
    const { data: projs } = await supabase
      .from('cportal_projects').select('*').eq('customer_id', id).order('name', { ascending: true })
    setProjects((projs ?? []) as Project[])
    if (cust.email) {
      const { data: prof } = await supabase.from('cportal_profiles').select('id').ilike('email', cust.email).maybeSingle()
      setInvited(!!prof)
    }
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }
  if (!customer) return null

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link to="/customers" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back to Customers
      </Link>

      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">{customer.company || customer.name || 'Unnamed customer'}</h1>
            {customer.name && customer.company && <p className="text-gray-500 mt-0.5">{customer.name}</p>}
            <p className="text-gray-400 text-sm mt-1">{customer.email || 'No email on file'}</p>
          </div>
          {customer.email && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${invited ? 'text-green-700 bg-green-100' : 'text-gray-600 bg-gray-100'}`}>
              {invited ? <><Check size={12} /> Has portal access</> : <><Mail size={12} /> Not invited</>}
            </span>
          )}
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Projects ({projects.length})</h2>
        </div>
        {projects.length === 0 ? (
          <div className="text-center py-14">
            <FolderOpen className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">No projects for this customer</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {projects.map(p => (
              <Link key={p.id} to={`/projects/${p.id}`} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FolderOpen size={16} className="text-blue-600" />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
