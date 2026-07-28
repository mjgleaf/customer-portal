import { Router } from 'express';
import { getListItems } from '../graph.js';

export const projectsRouter = Router();

/**
 * Projects / Jobs come from two SharePoint lists:
 *
 * 1. "Project Register Sharepoint V2" — project-level metadata
 * 2. "Load Out List" — individual equipment deployments per job
 *
 *    Load Out List columns:
 *    ─────────────────────────────────────────────────────
 *    Title              → equipment serial (e.g. 20C-JWA-004)
 *    Job Number         → project number (e.g. HWI-25-001)
 *    MobilizationNo     → mobilization reference (e.g. HWI-25-001-03)
 *    Status             → deployment status (In Progress, Completed, etc.)
 *    Description        → equipment description (e.g. 20 Te Waterbag)
 *    AssemblySN         → assembly serial number
 *    CartQty            → quantity loaded
 *    CartAvailQty       → available quantity
 *    CartEqCateg        → equipment category (Waterbag, Sling, etc.)
 *    CartSerializedYN   → whether item is serialized
 *    CartSingleShipWeight → unit weight
 *    CartTotalShipWeight  → total weight
 *    BoxNoLoaded        → box/container number
 *    Checked-InStatus   → check-in status
 *    Returned Quantity  → items returned
 *    Status_NeedsCleaning, Status_Recalibration, Status_Damaged, etc.
 *
 * Shipment data comes from CHRobinson via the Aftermath API.
 */

// ── SharePoint data fetching ──────────────────────────────────────

async function getProjectRegister() {
    try {
        const items = await getListItems('Project Register Sharepoint V2');
        return items.map(item => {
            const f = item.fields;
            return {
                id: item.id,
                projectNumber: f.Title || f.ProjectNumber || '',
                description: f.Description || f.ProjectDescription || '',
                client: f.Client || f.CustomerName || '',
                status: f.Status || f.ProjectStatus || 'active',
                jobSite: f.JobSite || f.Location || '',
                startDate: f.StartDate || null,
                endDate: f.EndDate || null,
                contactName: f.ContactName || '',
                contactEmail: f.ContactEmail || '',
            };
        });
    } catch (err) {
        console.warn('Project Register list unavailable:', err.message);
        return [];
    }
}

async function getLoadOutList() {
    try {
        const items = await getListItems('Load Out List');
        return items.map(item => {
            const f = item.fields;
            return {
                id: item.id,
                equipmentSerial: f.Title || '',
                jobNumber: f.Job_x0020_Number || f.JobNumber || '',
                mobilizationNo: f.MobilizationNo || '',
                status: f.Status || '',
                description: f.Description || '',
                assemblySN: f.AssemblySN || '',
                quantity: Number(f.CartQty) || 0,
                availableQty: Number(f.CartAvailQty) || 0,
                category: f.CartEqCateg || '',
                serialized: f.CartSerializedYN === 'Yes',
                unitWeight: Number(f.CartSingleShipWeight) || 0,
                totalWeight: Number(f.CartTotalShipWeight) || 0,
                boxNumber: f.BoxNoLoaded || '',
                checkedInStatus: f['Checked_x002d_InStatus'] || f.Checked_InStatus || '',
                returnedQty: Number(f['Returned_x0020_Quantity'] || f.ReturnedQuantity) || 0,
                needsCleaning: f.Status_NeedsCleaning || false,
                needsRecalibration: f.Status_Recalibration || false,
                isDamaged: f.Status_Damaged || false,
                created: f.Created || null,
                modified: f.Modified || null,
            };
        });
    } catch (err) {
        console.warn('Load Out List unavailable:', err.message);
        return [];
    }
}

// ── Aftermath/CHRobinson shipment integration ─────────────────────

async function getShipmentData(projectNumber) {
    const aftermathUrl = process.env.AFTERMATH_API_URL;
    if (!aftermathUrl) return { outbound: null, return: null };

    try {
        const response = await fetch(`${aftermathUrl}/shipments?project=${projectNumber}`);
        if (!response.ok) return { outbound: null, return: null };
        const data = await response.json();

        return {
            outbound: data.outbound ? mapShipment(data.outbound) : null,
            return: data.return ? mapShipment(data.return) : null,
        };
    } catch (err) {
        console.warn(`Failed to fetch shipment for ${projectNumber}:`, err.message);
        return { outbound: null, return: null };
    }
}

function mapShipment(s) {
    return {
        id: s.shipmentId || s.id || '',
        status: (s.status || 'TENDERED').toUpperCase(),
        origin: s.origin || '',
        destination: s.destination || '',
        carrier: s.carrier || s.carrierName || '',
        etaDate: s.estimatedDelivery || s.etaDate || '',
        etaTime: s.etaTime || '',
        pickupDate: s.pickupDate || '',
        deliveryDate: s.deliveryDate || null,
        lastUpdateTime: s.lastUpdate || new Date().toISOString(),
        mode: s.mode || 'TL',
        currentLocation: s.currentLocation || '',
        carrierTrackingLink: s.trackingUrl || '',
    };
}

function determineLifecycle(project, shipments) {
    if (shipments.return?.status === 'DELIVERED') return 'completed';
    if (shipments.return?.status === 'IN_TRANSIT') return 'returning';
    if (shipments.outbound?.status === 'DELIVERED') return 'on-site';
    if (shipments.outbound?.status === 'IN_TRANSIT') return 'deploying';
    const st = (project.status || '').toLowerCase();
    if (st === 'completed' || st === 'closed') return 'completed';
    if (st === 'in progress') return 'on-site';
    return 'on-site';
}

// ── Routes ────────────────────────────────────────────────────────

/**
 * GET /api/portal/projects?customer=Lockheed&year=2026
 * Returns projects enriched with equipment loadout data and shipments.
 */
projectsRouter.get('/', async (req, res) => {
    try {
        const { customer } = req.query;

        // Fetch project register and load-out data in parallel
        const [projects, loadOuts] = await Promise.all([
            getProjectRegister(),
            getLoadOutList(),
        ]);

        // Group load-outs by job number
        const loadOutsByJob = loadOuts.reduce((acc, lo) => {
            const key = lo.jobNumber;
            if (!key) return acc;
            (acc[key] ??= []).push(lo);
            return acc;
        }, {});

        // If we have project register data, enrich with load-out counts
        let enrichedProjects = projects.map(p => {
            const jobLoadOuts = loadOutsByJob[p.projectNumber] || [];
            const totalEquipment = jobLoadOuts.reduce((sum, lo) => sum + lo.quantity, 0);
            const inProgress = jobLoadOuts.filter(lo => lo.status === 'In Progress').length;
            return {
                ...p,
                equipmentCount: totalEquipment,
                activeLoadOuts: inProgress,
                loadOuts: jobLoadOuts,
            };
        });

        // Also include jobs that exist in Load Out List but not in Project Register
        const projectNumbers = new Set(projects.map(p => p.projectNumber));
        const additionalJobs = Object.entries(loadOutsByJob)
            .filter(([jobNum]) => !projectNumbers.has(jobNum))
            .map(([jobNum, items]) => ({
                projectNumber: jobNum,
                description: items[0]?.description || '',
                client: '',
                status: items[0]?.status || 'active',
                jobSite: '',
                equipmentCount: items.reduce((sum, lo) => sum + lo.quantity, 0),
                activeLoadOuts: items.filter(lo => lo.status === 'In Progress').length,
                loadOuts: items,
            }));

        enrichedProjects = [...enrichedProjects, ...additionalJobs];

        // Filter by customer if specified
        if (customer) {
            const q = customer.toLowerCase();
            enrichedProjects = enrichedProjects.filter(p =>
                (p.client || '').toLowerCase().includes(q) ||
                (p.projectNumber || '').toLowerCase().includes(q)
            );
        }

        // Enrich with shipment data from Aftermath/CHRobinson
        const result = await Promise.all(
            enrichedProjects.map(async (p) => {
                const shipments = await getShipmentData(p.projectNumber);
                return {
                    projectNumber: p.projectNumber,
                    lifecycle: determineLifecycle(p, shipments),
                    outbound: shipments.outbound,
                    return: shipments.return,
                    jobSite: p.jobSite || '',
                    daysOnSite: p.startDate ? Math.floor((Date.now() - new Date(p.startDate).getTime()) / 86400000) : null,
                    customerName: p.client,
                    description: p.description,
                    equipmentCount: p.equipmentCount || 0,
                    activeLoadOuts: p.activeLoadOuts || 0,
                };
            })
        );

        res.json(result);
    } catch (err) {
        console.error('Error fetching projects:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/portal/projects/:projectNumber/loadout
 * Returns the full load-out detail for a specific project.
 */
projectsRouter.get('/:projectNumber/loadout', async (req, res) => {
    try {
        const loadOuts = await getLoadOutList();
        const filtered = loadOuts.filter(lo => lo.jobNumber === req.params.projectNumber);
        res.json(filtered);
    } catch (err) {
        console.error('Error fetching loadout:', err);
        res.status(500).json({ error: err.message });
    }
});
