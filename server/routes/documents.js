import { Router } from 'express';
import { readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';

export const documentsRouter = Router();

/**
 * Documents come from the local OneDrive-synced folder:
 * C:\Users\green\OneDrive - Hydro-Wates\Commercial Proposals
 *
 * Folder structure:
 *   {year} Commercial Proposals/
 *     {HWI-YY-NNN}, {description}, {client}, {date}/
 *       ├── Correspondence/
 *       ├── Inspection Documents/
 *       ├── Invoice/
 *       ├── Photos/
 *       ├── Purchase Order/
 *       └── Quote/
 *
 * Each subfolder may contain .pdf, .docx, .xlsx files
 */

const PROPOSALS_ROOT = process.env.PROPOSALS_PATH
    || 'C:\\Users\\green\\OneDrive - Hydro-Wates\\Commercial Proposals';

const DOC_TYPE_MAP = {
    'Inspection Documents': 'calibration-cert',
    'Invoice': 'invoice',
    'Quote': 'delivery-note',         // maps to quote/proposal
    'Correspondence': 'method-statement',
    'Purchase Order': 'risk-assessment',
    'Photos': 'method-statement',
};

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.jpg', '.jpeg', '.png']);

/**
 * Parse a project folder name like:
 * "HWI-26-001, 2 Te Water Bag Purchase, SGRE CVOW , 01-02-2026"
 * → { projectNumber: 'HWI-26-001', description: '2 Te Water Bag Purchase', client: 'SGRE CVOW', date: '01-02-2026' }
 */
function parseProjectFolder(folderName) {
    const parts = folderName.split(',').map(s => s.trim());
    return {
        projectNumber: parts[0] || folderName,
        description: parts[1] || '',
        client: parts[2] || '',
        date: parts[3] || '',
    };
}

async function safeReaddir(dirPath) {
    try {
        return await readdir(dirPath);
    } catch {
        return [];
    }
}

async function isDirectory(path) {
    try {
        const s = await stat(path);
        return s.isDirectory();
    } catch {
        return false;
    }
}

// ── Routes ────────────────────────────────────────────────────────

/**
 * GET /api/portal/documents?customer=SGRE&year=2026&projectNumber=HWI-26-001
 * Scans the proposals folder and returns matching documents.
 */
documentsRouter.get('/', async (req, res) => {
    try {
        const { customer, year, projectNumber } = req.query;
        const targetYear = year || new Date().getFullYear().toString();

        const yearFolder = join(PROPOSALS_ROOT, `${targetYear} Commercial Proposals`);
        const projectFolders = await safeReaddir(yearFolder);

        const documents = [];
        let docId = 0;

        for (const projFolder of projectFolders) {
            const projPath = join(yearFolder, projFolder);
            if (!(await isDirectory(projPath))) continue;

            const parsed = parseProjectFolder(projFolder);

            // Filter by project number if specified
            if (projectNumber && parsed.projectNumber !== projectNumber) continue;

            // Filter by customer name if specified
            if (customer && !parsed.client.toLowerCase().includes(customer.toLowerCase())) continue;

            // Scan each document subfolder
            const subfolders = await safeReaddir(projPath);
            for (const sub of subfolders) {
                const subPath = join(projPath, sub);
                if (!(await isDirectory(subPath))) continue;

                const docType = DOC_TYPE_MAP[sub] || 'method-statement';
                const files = await safeReaddir(subPath);

                for (const file of files) {
                    const ext = extname(file).toLowerCase();
                    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

                    const filePath = join(subPath, file);
                    let fileSize = 0;
                    try {
                        const s = await stat(filePath);
                        fileSize = s.size;
                    } catch { /* ignore */ }

                    documents.push({
                        id: String(++docId),
                        name: basename(file, ext),
                        fileName: file,
                        type: docType,
                        category: sub,
                        projectNumber: parsed.projectNumber,
                        projectDescription: parsed.description,
                        client: parsed.client,
                        date: parsed.date || new Date().toISOString().split('T')[0],
                        downloadUrl: `/api/portal/documents/${docId}/download?path=${encodeURIComponent(filePath)}`,
                        fileSize,
                        extension: ext.replace('.', ''),
                    });
                }
            }
        }

        res.json(documents);
    } catch (err) {
        console.error('Error listing documents:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/portal/documents/:id/download?path=...
 * Serves the actual file for download.
 */
documentsRouter.get('/:id/download', async (req, res) => {
    try {
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });

        // Security: ensure the path is within the proposals root
        const normalizedPath = join(filePath);
        if (!normalizedPath.startsWith(PROPOSALS_ROOT.replace(/\\\\/g, '\\'))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.download(normalizedPath);
    } catch (err) {
        console.error('Error downloading document:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/portal/documents/years
 * Returns available year folders for the client to browse.
 */
documentsRouter.get('/years', async (_req, res) => {
    try {
        const entries = await safeReaddir(PROPOSALS_ROOT);
        const years = entries
            .filter(e => e.match(/^\d{4} Commercial Proposals$/))
            .map(e => e.split(' ')[0])
            .sort((a, b) => Number(b) - Number(a));
        res.json(years);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
