import type { ProjectFile } from '../types'

// Equipment certs synced from SharePoint accumulate every historical
// calibration cert sitting in the asset's folder (the folder the
// Hydro-Wates Inventory list's FolderPath points at). Only the newest one
// is current — it mirrors the cert attached on the Inventory list item —
// so collapse each asset folder down to its latest cert by SharePoint
// created date. Certs uploaded manually through the portal (no
// sharepoint_path) are always kept.
export function latestEquipmentCerts<T extends ProjectFile>(certs: T[]): T[] {
  const kept: T[] = []
  const newestByFolder = new Map<string, T>()
  for (const f of certs) {
    if (!f.sharepoint_path || !f.sharepoint_source_id) {
      kept.push(f) // manually uploaded — not part of the synced history
      continue
    }
    // sharepoint_path is the file's webUrl; strip the filename to get the
    // asset folder. Scope by project so the same asset shipped on two jobs
    // still shows its cert on both projects.
    const folder = f.sharepoint_path.slice(0, f.sharepoint_path.lastIndexOf('/'))
    const key = `${f.project_id}|${folder}`
    const prev = newestByFolder.get(key)
    const date = f.source_created_at || f.created_at
    const prevDate = prev ? (prev.source_created_at || prev.created_at) : ''
    if (!prev || date > prevDate) newestByFolder.set(key, f)
  }
  return [...kept, ...newestByFolder.values()]
}
