import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, RefreshCw } from 'lucide-react';
import { useLoadOutMobilizations } from '../../hooks/useLoadOutMobilizations';

type SortKey = 'mobilizationNo' | 'created';
type SortDir = 'asc' | 'desc';

function formatDate(value: string | null): string {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function LoadOutJobPage() {
    const { items, loading, error, refresh } = useLoadOutMobilizations();
    const navigate = useNavigate();
    const [sortKey, setSortKey] = useState<SortKey>('created');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const sorted = useMemo(() => {
        const copy = [...items];
        copy.sort((a, b) => {
            let cmp = 0;
            if (sortKey === 'created') {
                const av = a.created ? new Date(a.created).getTime() : 0;
                const bv = b.created ? new Date(b.created).getTime() : 0;
                cmp = av - bv;
            } else {
                cmp = a.mobilizationNo.localeCompare(b.mobilizationNo);
            }
            return sortDir === 'asc' ? cmp : -cmp;
        });
        return copy;
    }, [items, sortKey, sortDir]);

    const toggleSort = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir(key === 'created' ? 'desc' : 'asc');
        }
    };

    const sortIndicator = (key: SortKey) => {
        if (sortKey !== key) return '';
        return sortDir === 'asc' ? ' ▲' : ' ▼';
    };

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1><Truck size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />Load Out a Job</h1>
                    <p className="page-subtitle">
                        Mobilizations in the Load Out List with status “Initial Quote” or “In Progress”
                    </p>
                </div>
                <button
                    className="portal-nav-btn"
                    onClick={refresh}
                    disabled={loading}
                    style={{ width: 'auto', padding: '8px 14px' }}
                >
                    <RefreshCw size={16} />
                    <span>Refresh</span>
                </button>
            </div>

            {error && (
                <div className="error-state" style={{ marginBottom: 16 }}>
                    Failed to load mobilizations: {error}
                </div>
            )}

            {loading && items.length === 0 ? (
                <div className="skeleton-grid">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="skeleton-card" />
                    ))}
                </div>
            ) : sorted.length === 0 ? (
                <div className="empty-state">
                    No mobilizations currently in “Initial Quote” or “In Progress” status.
                </div>
            ) : (
                <div className="loadout-table-wrap">
                    <table className="loadout-table">
                        <thead>
                            <tr>
                                <th onClick={() => toggleSort('mobilizationNo')} role="button">
                                    Mobilization #{sortIndicator('mobilizationNo')}
                                </th>
                                <th onClick={() => toggleSort('created')} role="button">
                                    Created{sortIndicator('created')}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map((row) => (
                                <tr
                                    key={row.mobilizationNo}
                                    className="loadout-row-clickable"
                                    onClick={() => navigate(`/ops/load-out/${encodeURIComponent(row.mobilizationNo)}`)}
                                >
                                    <td className="mono">{row.mobilizationNo}</td>
                                    <td>{formatDate(row.created)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="loadout-table-footer">
                        {sorted.length} mobilization{sorted.length === 1 ? '' : 's'}
                    </div>
                </div>
            )}
        </div>
    );
}
