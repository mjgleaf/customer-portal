import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Package, RefreshCw, X, Truck, Trash2, Pencil, FileCheck } from 'lucide-react';
import { useLoadOutItems } from '../../hooks/useLoadOutItems';
import type { LoadOutItem } from '../../api/opsApi';

function formatWeight(n: number): string {
    if (!n) return '—';
    return `${n.toLocaleString()} lb`;
}

export default function LoadOutDetailPage() {
    const { mobilizationNo = '' } = useParams();
    const { items, loading, error, refresh } = useLoadOutItems(mobilizationNo);
    const [selected, setSelected] = useState<LoadOutItem | null>(null);

    useEffect(() => {
        if (!selected) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSelected(null);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selected]);

    const summary = useMemo(() => {
        const jobNumber = items[0]?.jobNumber || '';
        const totalQty = items.reduce((sum, r) => sum + (r.quantity || 0), 0);
        const totalWeight = items.reduce((sum, r) => sum + (r.totalWeight || 0), 0);
        return { jobNumber, totalQty, totalWeight, count: items.length };
    }, [items]);

    const handleAction = (action: 'load' | 'delete' | 'change') => {
        if (!selected) return;
        // TODO: wire up actions
        console.log(`[${action}]`, selected.id, selected.description);
        setSelected(null);
    };

    const handleViewCertificate = () => {
        if (!selected?.serial) return;
        window.open(`/api/ops/inventory/${encodeURIComponent(selected.serial)}/certificate`, '_blank');
    };

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <Link to="/ops/load-out" className="loadout-back">
                        <ArrowLeft size={14} /> All mobilizations
                    </Link>
                    <h1>
                        <Package size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />
                        {mobilizationNo}
                    </h1>
                    <p className="page-subtitle">
                        {summary.jobNumber && <>Job <strong>{summary.jobNumber}</strong> · </>}
                        {summary.count} item{summary.count === 1 ? '' : 's'}
                        {summary.totalQty > 0 && <> · {summary.totalQty.toLocaleString()} total qty</>}
                        {summary.totalWeight > 0 && <> · {formatWeight(summary.totalWeight)} total</>}
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
                    Failed to load items: {error}
                </div>
            )}

            {loading && items.length === 0 ? (
                <div className="skeleton-grid">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="skeleton-card" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <div className="empty-state">
                    No items found for mobilization {mobilizationNo}.
                </div>
            ) : (
                <div className="loadout-table-wrap">
                    <table className="loadout-table">
                        <thead>
                            <tr>
                                <th>Description</th>
                                <th>Category</th>
                                <th>Serial</th>
                                <th>Qty</th>
                                <th>Weight</th>
                                <th>Box</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((row) => (
                                <tr
                                    key={row.id}
                                    className="loadout-row-clickable"
                                    onClick={() => setSelected(row)}
                                >
                                    <td>{row.description || '—'}</td>
                                    <td>{row.category || '—'}</td>
                                    <td className="mono">{row.serial || '—'}</td>
                                    <td>{row.quantity || 0}</td>
                                    <td>{formatWeight(row.totalWeight)}</td>
                                    <td>{row.boxNumber || '—'}</td>
                                    <td>{row.status || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="loadout-table-footer">
                        {items.length} item{items.length === 1 ? '' : 's'}
                    </div>
                </div>
            )}

            {selected && (
                <div className="modal-overlay" onClick={() => setSelected(null)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>{selected.description || selected.serial || 'Item'}</h2>
                            <button className="modal-close" onClick={() => setSelected(null)}>
                                <X size={20} />
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="item-meta">
                                {selected.serial && <div><span className="meta-label">Serial</span><span className="mono">{selected.serial}</span></div>}
                                {selected.category && <div><span className="meta-label">Category</span><span>{selected.category}</span></div>}
                                <div><span className="meta-label">Qty</span><span>{selected.quantity}</span></div>
                                {selected.status && <div><span className="meta-label">Status</span><span>{selected.status}</span></div>}
                            </div>
                            <div className="item-actions">
                                <button className="item-action-btn item-action-btn--primary" onClick={() => handleAction('load')}>
                                    <Truck size={18} />
                                    <span>Load Item</span>
                                </button>
                                <button className="item-action-btn" onClick={() => handleAction('change')}>
                                    <Pencil size={18} />
                                    <span>Change Item</span>
                                </button>
                                {selected.hasCertificate && (
                                    <button className="item-action-btn" onClick={handleViewCertificate}>
                                        <FileCheck size={18} />
                                        <span>View Certificate</span>
                                    </button>
                                )}
                                <button className="item-action-btn item-action-btn--danger" onClick={() => handleAction('delete')}>
                                    <Trash2 size={18} />
                                    <span>Delete Item</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
