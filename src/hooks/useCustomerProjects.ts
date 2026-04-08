import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import type { ProjectGroup, ProjectLifecycle } from '../types';

// Demo data — in production this calls the Aftermath API scoped to the customer
const DEMO_PROJECTS: ProjectGroup[] = [
    {
        projectNumber: 'QT-2026-0041',
        lifecycle: 'on-site',
        outbound: {
            id: 'SH-88201', status: 'DELIVERED', origin: 'Houston, TX', destination: 'Midland, TX',
            carrier: 'ESTES Express', etaDate: '2026-03-28', etaTime: '14:00',
            pickupDate: '2026-03-26', deliveryDate: '2026-03-28', lastUpdateTime: '2026-03-28T14:22:00Z',
            mode: 'LTL',
        },
        return: null,
        jobSite: 'Midland, TX',
        daysOnSite: 11,
        customerName: 'Demo Customer',
    },
    {
        projectNumber: 'QT-2026-0038',
        lifecycle: 'deploying',
        outbound: {
            id: 'SH-88195', status: 'IN_TRANSIT', origin: 'Houston, TX', destination: 'Bakersfield, CA',
            carrier: 'XPO Logistics', etaDate: '2026-04-10', etaTime: '09:00',
            pickupDate: '2026-04-07', deliveryDate: null, lastUpdateTime: '2026-04-08T06:15:00Z',
            mode: 'TL', currentLocation: 'El Paso, TX',
        },
        return: null,
        jobSite: 'Bakersfield, CA',
        daysOnSite: null,
        customerName: 'Demo Customer',
    },
    {
        projectNumber: 'QT-2026-0029',
        lifecycle: 'completed',
        outbound: {
            id: 'SH-88140', status: 'DELIVERED', origin: 'Houston, TX', destination: 'Odessa, TX',
            carrier: 'ESTES Express', etaDate: '2026-02-14', etaTime: '11:00',
            pickupDate: '2026-02-12', deliveryDate: '2026-02-14', lastUpdateTime: '2026-02-14T11:30:00Z',
            mode: 'LTL',
        },
        return: {
            id: 'SH-88165', status: 'DELIVERED', origin: 'Odessa, TX', destination: 'Houston, TX',
            carrier: 'ESTES Express', etaDate: '2026-03-10', etaTime: '16:00',
            pickupDate: '2026-03-08', deliveryDate: '2026-03-10', lastUpdateTime: '2026-03-10T16:05:00Z',
            mode: 'LTL',
        },
        jobSite: 'Odessa, TX',
        daysOnSite: 22,
        customerName: 'Demo Customer',
    },
];

export function useCustomerProjects(autoRefreshMs = 120_000) {
    const { customer } = useAuth();
    const [projects, setProjects] = useState<ProjectGroup[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!customer) return;
        try {
            setLoading(true);
            // TODO: Replace with real API call — GET /api/portal/projects?customer={companyName}
            await new Promise(r => setTimeout(r, 600)); // simulate network
            setProjects(DEMO_PROJECTS);
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load projects');
        } finally {
            setLoading(false);
        }
    }, [customer]);

    useEffect(() => {
        load();
        const interval = setInterval(load, autoRefreshMs);
        return () => clearInterval(interval);
    }, [load, autoRefreshMs]);

    const counts: Record<ProjectLifecycle, number> = {
        deploying: projects.filter(p => p.lifecycle === 'deploying').length,
        'on-site': projects.filter(p => p.lifecycle === 'on-site').length,
        returning: projects.filter(p => p.lifecycle === 'returning').length,
        completed: projects.filter(p => p.lifecycle === 'completed').length,
    };

    return { projects, counts, loading, error, refresh: load };
}
