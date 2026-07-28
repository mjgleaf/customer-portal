import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { isApiAvailable } from '../api/client';
import { fetchDocuments } from '../api/portalApi';
import type { PortalDocument } from '../types';

const DEMO_DOCS: PortalDocument[] = [
    { id: '1', name: 'Cal Cert - LC-4021', type: 'calibration-cert', projectNumber: 'QT-2026-0041', equipmentSerial: 'LC-4021', date: '2025-09-15', downloadUrl: '#' },
    { id: '2', name: 'Cal Cert - LC-4022', type: 'calibration-cert', projectNumber: 'QT-2026-0041', equipmentSerial: 'LC-4022', date: '2025-09-15', downloadUrl: '#' },
    { id: '3', name: 'Cal Cert - LL-2015', type: 'calibration-cert', projectNumber: 'QT-2026-0041', equipmentSerial: 'LL-2015', date: '2025-11-20', downloadUrl: '#' },
    { id: '4', name: 'Cal Cert - PG-1008', type: 'calibration-cert', projectNumber: 'QT-2026-0041', equipmentSerial: 'PG-1008', date: '2026-01-10', downloadUrl: '#' },
    { id: '5', name: 'Delivery Note - QT-2026-0041', type: 'delivery-note', projectNumber: 'QT-2026-0041', date: '2026-03-28', downloadUrl: '#' },
    { id: '6', name: 'Risk Assessment - Midland TX Site', type: 'risk-assessment', projectNumber: 'QT-2026-0041', date: '2026-03-25', downloadUrl: '#' },
    { id: '7', name: 'Method Statement - Load Testing', type: 'method-statement', projectNumber: 'QT-2026-0041', date: '2026-03-25', downloadUrl: '#' },
    { id: '8', name: 'Invoice INV-2026-0188', type: 'invoice', projectNumber: 'QT-2026-0029', date: '2026-03-15', downloadUrl: '#' },
    { id: '9', name: 'Delivery Note - QT-2026-0029', type: 'delivery-note', projectNumber: 'QT-2026-0029', date: '2026-02-14', downloadUrl: '#' },
];

export function useDocuments() {
    const { customer } = useAuth();
    const [documents, setDocuments] = useState<PortalDocument[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [usingLiveData, setUsingLiveData] = useState(false);

    const load = useCallback(async () => {
        if (!customer) return;
        try {
            setLoading(true);
            const apiUp = await isApiAvailable();
            if (apiUp) {
                const data = await fetchDocuments(customer.companyName);
                setDocuments(data);
                setUsingLiveData(true);
            } else {
                await new Promise(r => setTimeout(r, 300));
                setDocuments(DEMO_DOCS);
                setUsingLiveData(false);
            }
            setError(null);
        } catch (err: any) {
            console.warn('Falling back to demo documents:', err.message);
            setDocuments(DEMO_DOCS);
            setUsingLiveData(false);
            setError(null);
        } finally {
            setLoading(false);
        }
    }, [customer]);

    useEffect(() => { load(); }, [load]);

    return { documents, loading, error, refresh: load, usingLiveData };
}
