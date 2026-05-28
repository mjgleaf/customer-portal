export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  company: string | null
  role: 'customer' | 'admin'
  created_at: string
}

export interface Project {
  id: string
  name: string
  description: string | null
  status: 'active' | 'completed' | 'on-hold'
  created_at: string
  updated_at: string
  started_on?: string | null
  customer_id?: string | null
  customer?: { company: string | null; name: string | null } | null
}

export interface ProjectFile {
  id: string
  project_id: string
  name: string
  storage_path: string
  size: number | null
  mime_type: string | null
  uploaded_by: string | null
  created_at: string
  kind?: string
  document_request_id?: string | null
}

export interface DocumentRequest {
  id: string
  project_id: string
  label: string
  created_at: string
}

export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  created_at: string
  profile?: Profile
}

export interface Customer {
  id: string
  zoho_contact_id: string
  name: string | null
  email: string | null
  company: string | null
  created_at: string
  updated_at: string
}

export interface Invoice {
  id: string
  zoho_invoice_id: string
  customer_id: string | null
  project_id: string | null
  invoice_number: string | null
  status: string | null
  total: number | null
  balance: number | null
  currency_code: string | null
  invoice_date: string | null
  due_date: string | null
  created_at: string
}
