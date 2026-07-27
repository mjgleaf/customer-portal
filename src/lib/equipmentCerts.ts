import type { ProjectFile } from '../types'

// Equipment certs synced from SharePoint can accumulate several historical
// calibration certs for the same unit (the sync now keeps one per unit,
// but rows synced by earlier versions linger until the next sync's cleanup
// deletes them). Collapse each asset down to a single cert client-side.
//
// Grouping key: the serial number in the filename ("..., SN 16831), ...")
// when present — rows synced in different eras store different
// sharepoint_path shapes (webUrl vs raw folder path), so the path alone
// can split one unit into several groups. Falls back to the parent folder
// of sharepoint_path. Certs uploaded manually through the portal (no
// SharePoint linkage) are always kept.
function assetKey(f: ProjectFile): string | null {
  const sn = f.name.match(/\bSN[ .:,#]*([A-Za-z0-9-]+)/i)
  if (sn) return `sn:${sn[1].toUpperCase()}`
  if (f.sharepoint_path) {
    return `path:${f.sharepoint_path.slice(0, f.sharepoint_path.lastIndexOf('/'))}`
  }
  return null
}

export function latestEquipmentCerts<T extends ProjectFile>(certs: T[]): T[] {
  const kept: T[] = []
  const newestByAsset = new Map<string, T>()
  for (const f of certs) {
    if (!f.sharepoint_path || !f.sharepoint_source_id) {
      kept.push(f) // manually uploaded — not part of the synced history
      continue
    }
    // Scope by project so the same asset shipped on two jobs still shows
    // its cert on both projects.
    const asset = assetKey(f)
    if (!asset) {
      kept.push(f)
      continue
    }
    const key = `${f.project_id}|${asset}`
    const prev = newestByAsset.get(key)
    const date = f.source_created_at || f.created_at
    const prevDate = prev ? (prev.source_created_at || prev.created_at) : ''
    if (!prev || date > prevDate) newestByAsset.set(key, f)
  }
  return [...kept, ...newestByAsset.values()]
}
