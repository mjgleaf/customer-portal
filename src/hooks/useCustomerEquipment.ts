import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import type { Equipment } from '../types';

const DEMO_EQUIPMENT: Equipment[] = [
    {
        id: 1, serialNumber: 'LC-4021', description: '100T Wireless Load Cell',
        category: 'Load Cell', subCategory: 'Wireless',
        calibrationDate: '2025-09-15', expirationDate: '2026-09-15',
        daysUntilExpiry: 160, urgency: 'OK', status: 'On Rent',
        location: 'Midland, TX', jobId: 'QT-2026-0041',
    },
    {
        id: 2, serialNumber: 'LC-4022', description: '100T Wireless Load Cell',
        category: 'Load Cell', subCategory: 'Wireless',
        calibrationDate: '2025-09-15', expirationDate: '2026-09-15',
        daysUntilExpiry: 160, urgency: 'OK', status: 'On Rent',
        location: 'Midland, TX', jobId: 'QT-2026-0041',
    },
    {
        id: 3, serialNumber: 'LL-2015', description: '50T Load Link',
        category: 'Load Link', subCategory: 'Standard',
        calibrationDate: '2025-11-20', expirationDate: '2026-11-20',
        daysUntilExpiry: 226, urgency: 'OK', status: 'On Rent',
        location: 'Midland, TX', jobId: 'QT-2026-0041',
    },
    {
        id: 4, serialNumber: 'PG-1008', description: '10K PSI Pressure Gauge',
        category: 'Pressure Gauge', subCategory: 'Digital',
        calibrationDate: '2026-01-10', expirationDate: '2027-01-10',
        daysUntilExpiry: 277, urgency: 'OK', status: 'On Rent',
        location: 'Midland, TX', jobId: 'QT-2026-0041',
    },
    {
        id: 5, serialNumber: 'LC-4030', description: '200T Wireless Load Cell',
        category: 'Load Cell', subCategory: 'Wireless',
        calibrationDate: '2025-07-02', expirationDate: '2026-07-02',
        daysUntilExpiry: 85, urgency: 'NOTICE', status: 'In Transit',
        location: 'El Paso, TX (in transit)', jobId: 'QT-2026-0038',
    },
    {
        id: 6, serialNumber: 'LC-4031', description: '200T Wireless Load Cell',
        category: 'Load Cell', subCategory: 'Wireless',
        calibrationDate: '2025-07-02', expirationDate: '2026-07-02',
        daysUntilExpiry: 85, urgency: 'NOTICE', status: 'In Transit',
        location: 'El Paso, TX (in transit)', jobId: 'QT-2026-0038',
    },
];

export function useCustomerEquipment(autoRefreshMs = 300_000) {
    const { customer } = useAuth();
    const [equipment, setEquipment] = useState<Equipment[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!customer) return;
        try {
            setLoading(true);
            // TODO: Replace with real API — GET /api/portal/equipment?customer={companyName}
            await new Promise(r => setTimeout(r, 400));
            setEquipment(DEMO_EQUIPMENT);
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load equipment');
        } finally {
            setLoading(false);
        }
    }, [customer]);

    useEffect(() => {
        load();
        const interval = setInterval(load, autoRefreshMs);
        return () => clearInterval(interval);
    }, [load, autoRefreshMs]);

    return { equipment, loading, error, refresh: load };
}
