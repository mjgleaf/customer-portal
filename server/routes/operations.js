import { Router } from 'express';
import { getListItems, getSiteLists, resolveListId, getGraphClient, getSiteId } from '../graph.js';

export const operationsRouter = Router();

const TARGET_STATUSES = new Set(['initial quote', 'in progress']);
const INVENTORY_LIST = 'HydroWates Inventory';

// ── Inventory cert-map cache ──────────────────────────────────────
//
// Maps equipment serial (inventory Title) → { itemId, hasAttachments }.
// Refreshed every 5 minutes; avoids re-fetching the full inventory list
// for every detail-page load.

let _certMap = null;
let _certMapFetchedAt = 0;
const CERT_MAP_TTL_MS = 5 * 60 * 1000;

async function getInventoryCertMap() {
    const now = Date.now();
    if (_certMap && now - _certMapFetchedAt < CERT_MAP_TTL_MS) return _certMap;

    const listId = await resolveListId(INVENTORY_LIST);
    const items = await getListItems(listId);
    const map = {};
    for (const item of items) {
        const f = item.fields || {};
        const serial = f.Title;
        if (!serial) continue;
        map[serial] = {
            itemId: item.id,
            hasAttachments: f.Attachments === true || f.Attachments === 'true',
        };
    }
    _certMap = map;
    _certMapFetchedAt = now;
    return map;
}

// Debug: list all SharePoint lists on the site (useful for finding the
// correct display/internal name).
operationsRouter.get('/_debug/lists', async (_req, res) => {
    try {
        const lists = await getSiteLists();
        res.json(lists.map(l => ({ id: l.id, name: l.name, displayName: l.displayName, webUrl: l.webUrl })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debug: sample rows from any list to inspect the field shape.
operationsRouter.get('/_debug/sample/:listName', async (req, res) => {
    try {
        const listId = await resolveListId(req.params.listName);
        const items = await getListItems(listId);
        res.json({ count: items.length, sample: items.slice(0, 5).map(i => ({ id: i.id, fields: i.fields })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debug: list columns (schema) for a given list
operationsRouter.get('/_debug/columns/:listName', async (req, res) => {
    try {
        const listId = await resolveListId(req.params.listName);
        const client = getGraphClient();
        const siteId = await getSiteId();
        const result = await client.api(`/sites/${siteId}/lists/${listId}/columns`).get();
        res.json((result.value || []).map(c => ({
            name: c.name,
            displayName: c.displayName,
            type: Object.keys(c).find(k => c[k] && typeof c[k] === 'object' && ['text','choice','dateTime','number','boolean','lookup','personOrGroup'].includes(k)) || 'unknown',
            required: c.required,
            hidden: c.hidden,
            readOnly: c.readOnly,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// One-shot: create the columns on INSPECTION ANSWERS for the inspection
// workflow. Idempotent — skips columns that already exist.
operationsRouter.post('/_admin/inspection-answers/ensure-columns', async (_req, res) => {
    try {
        const listId = await resolveListId('INSPECTION ANSWERS');
        const client = getGraphClient();
        const siteId = await getSiteId();

        const existing = await client.api(`/sites/${siteId}/lists/${listId}/columns`).get();
        const existingNames = new Set((existing.value || []).map(c => c.name));

        const definitions = [
            { name: 'MobilizationNo', displayName: 'Mobilization Number', text: {} },
            { name: 'LoadOutItemId', displayName: 'Load Out Item ID', text: {} },
            { name: 'Serial', displayName: 'Serial', text: {} },
            { name: 'Category', displayName: 'Category', text: {} },
            { name: 'Direction', displayName: 'Direction', choice: { choices: ['Outgoing', 'Incoming'], displayAs: 'dropDownMenu' } },
            { name: 'Status', displayName: 'Status', choice: { choices: ['In Progress', 'Complete', 'Failed'], displayAs: 'dropDownMenu' } },
            { name: 'Responses', displayName: 'Responses', text: { allowMultipleLines: true, maxLength: 63999, textType: 'plain' } },
            { name: 'InspectorName', displayName: 'Inspector Name', text: {} },
            { name: 'CompletedAt', displayName: 'Completed At', dateTime: { displayAs: 'default', format: 'dateTime' } },
        ];

        const results = [];
        for (const def of definitions) {
            if (existingNames.has(def.name)) {
                results.push({ name: def.name, status: 'exists' });
                continue;
            }
            try {
                await client.api(`/sites/${siteId}/lists/${listId}/columns`).post(def);
                results.push({ name: def.name, status: 'created' });
            } catch (err) {
                results.push({ name: def.name, status: 'failed', error: err.message || String(err) });
            }
        }
        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Debug: distinct CartEqCateg values from the Load Out List
operationsRouter.get('/_debug/categories', async (_req, res) => {
    try {
        const items = await getListItems('Load Out List');
        const counts = {};
        for (const item of items) {
            const cat = item.fields?.CartEqCateg || '(empty)';
            counts[cat] = (counts[cat] || 0) + 1;
        }
        res.json(counts);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/ops/loadouts/:mobilizationNo/items
 *
 * Returns all Load Out List rows for a given mobilization, enriched with a
 * `hasCertificate` flag indicating whether the matching HydroWates Inventory
 * item has any PDF attachment.
 */
operationsRouter.get('/loadouts/:mobilizationNo/items', async (req, res) => {
    try {
        const targetMob = req.params.mobilizationNo;
        const [items, certMap] = await Promise.all([
            getListItems('Load Out List'),
            getInventoryCertMap().catch(err => {
                console.warn('Inventory cert map unavailable:', err.message);
                return {};
            }),
        ]);

        const rows = items
            .map(item => {
                const f = item.fields || {};
                const serial = f.Title || '';
                const certEntry = certMap[serial];
                return {
                    id: item.id,
                    mobilizationNo: f.MobilizationNo || '',
                    jobNumber: f.Job_x0020_Number || f.JobNumber || '',
                    serial,
                    description: f.Description || '',
                    category: f.CartEqCateg || '',
                    quantity: Number(f.CartQty) || 0,
                    availableQty: Number(f.CartAvailQty) || 0,
                    serialized: f.CartSerializedYN === 'Yes',
                    unitWeight: Number(f.CartSingleShipWeight) || 0,
                    totalWeight: Number(f.CartTotalShipWeight) || 0,
                    boxNumber: f.BoxNoLoaded || '',
                    assemblySN: f.AssemblySN || '',
                    status: f.Status || '',
                    created: f.Created || item.createdDateTime || null,
                    hasCertificate: !!certEntry?.hasAttachments,
                };
            })
            .filter(r => r.mobilizationNo === targetMob)
            .sort((a, b) => {
                const cat = (a.category || '').localeCompare(b.category || '');
                if (cat !== 0) return cat;
                return (a.description || '').localeCompare(b.description || '');
            });

        res.json(rows);
    } catch (err) {
        console.error('Error fetching mobilization items:', err);
        res.status(500).json({ error: err.message });
    }
});

operationsRouter.get('/loadouts', async (_req, res) => {
    try {
        const items = await getListItems('Load Out List');

        const byMob = new Map();
        for (const item of items) {
            const f = item.fields || {};
            const mob = f.MobilizationNo || '';
            if (!mob) continue;

            const status = String(f.Status || '').trim().toLowerCase();
            const jobNumber = f.Job_x0020_Number || f.JobNumber || '';
            const created = f.Created || item.createdDateTime || null;

            const existing = byMob.get(mob);
            if (existing) {
                if (TARGET_STATUSES.has(status)) existing.hasTargetStatus = true;
                if (created && (!existing.created || new Date(created) < new Date(existing.created))) {
                    existing.created = created;
                }
                if (!existing.jobNumber && jobNumber) existing.jobNumber = jobNumber;
            } else {
                byMob.set(mob, {
                    mobilizationNo: mob,
                    jobNumber,
                    created,
                    hasTargetStatus: TARGET_STATUSES.has(status),
                });
            }
        }

        const result = [...byMob.values()]
            .filter(m => m.hasTargetStatus)
            .map(({ hasTargetStatus: _drop, ...m }) => m)
            .sort((a, b) => {
                if (!a.created) return 1;
                if (!b.created) return -1;
                return new Date(b.created) - new Date(a.created);
            });

        res.json(result);
    } catch (err) {
        console.error('Error fetching load-out mobilizations:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/ops/inventory/:serial/certificate
 *
 * Redirects to the SharePoint display form for the matching HydroWates
 * Inventory item. Classic list attachments aren't accessible via Graph or
 * the SharePoint REST API (under app-only auth on the current registration),
 * so we send the user to the SharePoint item page — their browser session
 * is authenticated and they can click the attached PDF from there.
 */
operationsRouter.get('/inventory/:serial/certificate', async (req, res) => {
    try {
        const serial = req.params.serial;
        const certMap = await getInventoryCertMap();
        const entry = certMap[serial];
        if (!entry) return res.status(404).json({ error: `No inventory item for serial ${serial}` });
        if (!entry.hasAttachments) return res.status(404).json({ error: 'No attachments on inventory item' });

        const dispForm = `https://hydrowates.sharepoint.com/sites/Hydro-WatesFiles/Lists/HydroWates%20Inventory/DispForm.aspx?ID=${entry.itemId}`;
        res.redirect(302, dispForm);
    } catch (err) {
        console.error('Error redirecting to certificate:', err);
        res.status(500).json({ error: err.message });
    }
});
