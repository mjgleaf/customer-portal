import { useState } from 'react';
import { FileText, Download, Search, Filter } from 'lucide-react';
import type { PortalDocument, DocumentType } from '../types';

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
    'calibration-cert': 'Calibration Certificate',
    'delivery-note': 'Delivery Note',
    'risk-assessment': 'Risk Assessment',
    'method-statement': 'Method Statement',
    'invoice': 'Invoice',
};

// Demo documents
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

export default function DocumentsPage() {
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<DocumentType | 'all'>('all');

    const filtered = DEMO_DOCS.filter(doc => {
        if (typeFilter !== 'all' && doc.type !== typeFilter) return false;
        if (search) {
            const q = search.toLowerCase();
            return [doc.name, doc.projectNumber, doc.equipmentSerial]
                .filter(Boolean).join(' ').toLowerCase().includes(q);
        }
        return true;
    });

    // Group by project
    const grouped = filtered.reduce<Record<string, PortalDocument[]>>((acc, doc) => {
        const key = doc.projectNumber || 'General';
        (acc[key] ??= []).push(doc);
        return acc;
    }, {});

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Documents</h1>
                    <p className="page-subtitle">Calibration certificates, delivery notes, and project documents</p>
                </div>
            </div>

            <div className="filters-row">
                <div className="search-input">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="Search documents..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
                <div className="filter-pills">
                    <button
                        className={`filter-pill ${typeFilter === 'all' ? 'filter-pill--active' : ''}`}
                        onClick={() => setTypeFilter('all')}
                    >
                        All
                    </button>
                    {(Object.entries(DOC_TYPE_LABELS) as [DocumentType, string][]).map(([type, label]) => (
                        <button
                            key={type}
                            className={`filter-pill ${typeFilter === type ? 'filter-pill--active' : ''}`}
                            onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {Object.keys(grouped).length === 0 ? (
                <div className="empty-state"><p>No documents found.</p></div>
            ) : (
                Object.entries(grouped).map(([projectNumber, docs]) => (
                    <div key={projectNumber} className="doc-group">
                        <h3 className="doc-group-title">{projectNumber}</h3>
                        <div className="doc-list">
                            {docs.map(doc => (
                                <div key={doc.id} className="doc-row">
                                    <div className="doc-row-left">
                                        <FileText size={18} className="doc-icon" />
                                        <div>
                                            <div className="doc-name">{doc.name}</div>
                                            <div className="doc-meta">
                                                <span className="doc-type-badge">{DOC_TYPE_LABELS[doc.type]}</span>
                                                <span>{new Date(doc.date).toLocaleDateString()}</span>
                                                {doc.equipmentSerial && <span>S/N: {doc.equipmentSerial}</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <a href={doc.downloadUrl} className="download-btn" title="Download">
                                        <Download size={16} />
                                    </a>
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
