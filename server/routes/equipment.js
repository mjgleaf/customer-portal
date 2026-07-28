import { Router } from 'express';
import { getListItems } from '../graph.js';

export const equipmentRouter = Router();

/**
 * Column mapping: SharePoint "Hydro-Wates Inventory" → Portal Equipment type
 *
 * SharePoint Column              → Portal Field
 * ──────────────────────────────────────────────────
 * Title                          → serialNumber (primary identifier)
 * AssemblySerialNumber           → assemblySerial
 * Description                    → description
 * EqCategory                     → category
 * EqSubCategory                  → subCategory
 * Location                       → location
 * JobNumber                      → jobId
 * Calibration_Date               → calibrationDate
 * Calc_TimeToExpiration_Days     → daysUntilExpiry
 * EquipmentStatus                → status
 * WorkingLoadLimit               → workingLoadLimit
 * WLL_x0020_Unit                 → wllUnit
 * ShippingWeight                 → shippingWeight
 * NomLength                      → nomLength
 * NomLengthUnit                  → nomLengthUnit
 * FolderPath                     → folderPath
 * Attachments                    → hasAttachments
 * Image                          → imageUrl
 * PurchaseDate                   → purchaseDate
 * Serialized                     → serialized
 * ValueAtPurchase                → valueAtPurchase
 * Status_JobReady                → statusJobReady
 * Status_CheckedOut              → statusCheckedOut
 * Status_NeedsCleaning           → statusNeedsCleaning
 * Status_Recalibration           → statusRecalibration
 * Status_Damaged                 → statusDamaged
 * LoadTestRequired               → loadTestRequired
 * LoadTestFreqYr                 → loadTestFreqYr
 * LoadTestLastDate               → loadTestLastDate
 * LoadTestCalcExp                → loadTestCalcExp
 * Checkin_Date                   → checkinDate
 * Loadout_Date                   → loadoutDate
 * ID                             → id
 */

function mapCalibrationUrgency(daysUntilExpiry, calDate) {
    if (!calDate || calDate === 'N/A') return 'OK'; // non-calibrated items
    if (daysUntilExpiry === null || daysUntilExpiry === undefined) return 'OK';
    const days = Number(daysUntilExpiry);
    if (isNaN(days)) return 'OK';
    if (days <= 0) return 'EXPIRED';
    if (days <= 30) return 'CRITICAL';
    if (days <= 60) return 'WARNING';
    if (days <= 90) return 'NOTICE';
    return 'OK';
}

function mapEquipment(item) {
    const f = item.fields;
    const daysUntilExpiry = f.Calc_TimeToExpiration_Days ?? null;
    const calDate = f.Calibration_Date ?? null;

    return {
        id: item.id,
        serialNumber: f.Title || '',
        assemblySerial: f.AssemblySerialNumber || '',
        description: f.Description || '',
        category: f.EqCategory || '',
        subCategory: f.EqSubCategory || '',
        location: f.Location || '',
        jobId: f.JobNumber || null,
        calibrationDate: calDate,
        expirationDate: calDate ? calculateExpiration(calDate) : null,
        daysUntilExpiry: daysUntilExpiry !== null ? Number(daysUntilExpiry) : null,
        urgency: mapCalibrationUrgency(daysUntilExpiry, calDate),
        status: f.EquipmentStatus || 'Unknown',
        workingLoadLimit: f.WorkingLoadLimit || null,
        wllUnit: f.WLL_x0020_Unit || '',
        shippingWeight: f.ShippingWeight || null,
        nomLength: f.NomLength || null,
        nomLengthUnit: f.NomLengthUnit || '',
        folderPath: f.FolderPath || '',
        imageUrl: f.Image ? extractImageUrl(f.Image) : null,
        purchaseDate: f.PurchaseDate || null,
        serialized: f.Serialized === 'Yes',
        loadTestRequired: f.LoadTestRequired || false,
        loadTestLastDate: f.LoadTestLastDate || null,
        loadTestCalcExp: f.LoadTestCalcExp || null,
        checkinDate: f.Checkin_Date || null,
        loadoutDate: f.Loadout_Date || null,
    };
}

function calculateExpiration(calDate) {
    try {
        const d = new Date(calDate);
        d.setFullYear(d.getFullYear() + 1); // default 1-year calibration cycle
        return d.toISOString();
    } catch {
        return null;
    }
}

function extractImageUrl(imageField) {
    // SharePoint image fields can be JSON strings or URLs
    if (typeof imageField === 'string') {
        try {
            const parsed = JSON.parse(imageField);
            return parsed.serverRelativeUrl || parsed.serverUrl + parsed.serverRelativeUrl || imageField;
        } catch {
            return imageField;
        }
    }
    return null;
}

// ── Routes ────────────────────────────────────────────────────────

equipmentRouter.get('/', async (req, res) => {
    try {
        const { customer, jobNumber, category, status } = req.query;

        const items = await getListItems('2e6b51db-a23f-4144-8a3d-ca44b1abda9e');
        let equipment = items.map(mapEquipment);

        // Filter by job number if provided
        if (jobNumber) {
            equipment = equipment.filter(e => e.jobId === jobNumber);
        }

        // Filter by category
        if (category) {
            equipment = equipment.filter(e => e.category === category);
        }

        // Filter by status
        if (status) {
            equipment = equipment.filter(e => e.status === status);
        }

        // Filter by customer/location if needed
        if (customer) {
            equipment = equipment.filter(e =>
                e.location?.toLowerCase().includes(customer.toLowerCase()) ||
                e.jobId?.toLowerCase().includes(customer.toLowerCase())
            );
        }

        res.json(equipment);
    } catch (err) {
        console.error('Error fetching equipment:', err);
        res.status(500).json({ error: err.message });
    }
});

equipmentRouter.get('/:id', async (req, res) => {
    try {
        const items = await getListItems('2e6b51db-a23f-4144-8a3d-ca44b1abda9e');
        const item = items.find(i => i.id === req.params.id || i.fields.Title === req.params.id);
        if (!item) return res.status(404).json({ error: 'Equipment not found' });
        res.json(mapEquipment(item));
    } catch (err) {
        console.error('Error fetching equipment detail:', err);
        res.status(500).json({ error: err.message });
    }
});
