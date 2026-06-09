export interface Profile {
  id: string
  email: string | null
  full_name: string | null
  company: string | null
  phone: string | null
  role: 'customer' | 'admin' | 'service_tech'
  created_at: string
  email_notifications?: boolean
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
  site_contact?: string | null
  site_contact_phone?: string | null
  customer?: {
    company: string | null
    name: string | null
    email?: string | null
    shipping_address?: string | null
    shipping_city?: string | null
    shipping_state?: string | null
    shipping_zip?: string | null
    shipping_country?: string | null
    billing_address?: string | null
    billing_city?: string | null
    billing_state?: string | null
    billing_zip?: string | null
    billing_country?: string | null
  } | null
  lead_comments?: string | null
  ship_to_address?: string | null
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
  retest_due?: string | null
  sharepoint_synced_at?: string | null
  sharepoint_path?: string | null
  sharepoint_error?: string | null
  // SharePoint source item id, used to dedupe files synced from SharePoint.
  sharepoint_source_id?: string | null
  // For SharePoint-synced files, the createdDateTime from OneDrive — i.e.
  // when the file was first added to SharePoint. Null for files uploaded
  // directly through the portal (use created_at instead).
  source_created_at?: string | null
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
