import { useState } from 'react';
import { Search, Shield, AlertTriangle, Clock } from 'lucide-react';
import { useCustomerEquipment } from '../hooks/useCustomerEquipment';
import type { CalibrationUrgency } from '../types';

const URGENCY_CONFIG: Record<CalibrationUrgency, { label: string; className: string }> = {
    EXPIRED: { label: 'Expired', className: 'urgency--expired' },
    CRITICAL: { label: 'Critical', className: 'urgency--critical' },
    WARNING: { label: 'Warning', className: 'urgency--warning' },
    NOTICE: { label: 'Notice', className: 'urgency--notice' },
    OK: { label: 'Valid', className: 'urgency--ok' },
    IN_CALIBRATION: { label: 'In Calibration', className: 'urgency--in-cal' },
};

export default function EquipmentPage() {
    const { equipment, loading, error } = useCustomerEquipment();
    const [search, setSearch] = useState('');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');

    const categories = ['all', ...new Set(equipment.map(e => e.category))];

    const filtered = equipment.filter(e => {
        if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
        if (search) {
            const q = search.toLowerCase();
            return [e.serialNumber, e.description, e.location, e.jobId]
                .filter(Boolean).join(' ').toLowerCase().includes(q);
        }
        return true;
    });

    // Group by project
    const grouped = filtered.reduce<Record<string, typeof filtered>>((acc, e) => {
        const key = e.jobId || 'Unassigned';
        (acc[key] ??= []).push(e);
        return acc;
    }, {});

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Equipment On Site</h1>
                    <p className="page-subtitle">Equipment currently deployed to your job sites</p>
                </div>
            </div>

            {/* Filters */}
            <div className="filters-row">
                <div className="search-input">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search serial, description, location..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="filter-pills">
                    {categories.map(cat => (
                        <button
                            key={cat}
                            className={`filter-pill ${categoryFilter === cat ? 'filter-pill--active' : ''}`}
                            onClick={() => setCategoryFilter(cat)}
                        >
                            {cat === 'all' ? 'All' : cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Equipment Table */}
            {loading ? (
                <div className="loading-state">Loading equipment...</div>
            ) : error ? (
                <div className="error-state">{error}</div>
            ) : filtered.length === 0 ? (
                <div className="empty-state"><p>No equipment found.</p></div>
            ) : (
                Object.entries(grouped).map(([jobId, items]) => (
                    <div key={jobId} className="equipment-group">
                        <h3 className="equipment-group-title">{jobId}</h3>
                        <div className="equipment-table-wrap">
                            <table className="equipment-table">
                                <thead>
                                    <tr>
                                        <th>Serial #</th>
                                        <th>Description</th>
                                        <th>Category</th>
                                        <th>Location</th>
                                        <th>Calibration</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map(eq => {
                                        const urgCfg = URGENCY_CONFIG[eq.urgency];
                                        return (
                                            <tr key={eq.id}>
                                                <td className="cell-mono">{eq.serialNumber}</td>
                                                <td>{eq.description}</td>
                                                <td>{eq.category}</td>
                                                <td>{eq.location}</td>
                                                <td>
                                                    <span className={`urgency-badge ${urgCfg.className}`}>
                                                        {eq.urgency === 'OK' ? <Shield size={12} /> :
                                                         eq.urgency === 'NOTICE' ? <Clock size={12} /> :
                                                         <AlertTriangle size={12} />}
                                                        {urgCfg.label}
                                                    </span>
                                                    <span className="cal-date">
                                                        Exp: {new Date(eq.expirationDate).toLocaleDateString()}
                                                    </span>
                                                </td>
                                                <td>{eq.status}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
