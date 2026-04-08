import { useState } from 'react';
import { Truck, MapPin, RotateCcw, CheckCircle2, Clock, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { useCustomerProjects } from '../hooks/useCustomerProjects';
import { useAuth } from '../context/AuthContext';
import type { ProjectGroup, ProjectLifecycle, Shipment } from '../types';

const LIFECYCLE_CONFIG: Record<ProjectLifecycle, { label: string; icon: typeof Truck; className: string }> = {
    deploying: { label: 'Deploying', icon: Truck, className: 'status--deploying' },
    'on-site': { label: 'On Site', icon: MapPin, className: 'status--onsite' },
    returning: { label: 'Returning', icon: RotateCcw, className: 'status--returning' },
    completed: { label: 'Completed', icon: CheckCircle2, className: 'status--completed' },
};

function ShipmentCard({ shipment, label }: { shipment: Shipment; label: string }) {
    return (
        <div className="shipment-card">
            <div className="shipment-card-header">
                <span className="shipment-label">{label}</span>
                <span className={`shipment-status shipment-status--${shipment.status.toLowerCase().replace('_', '-')}`}>
                    {shipment.status.replace('_', ' ')}
                </span>
            </div>
            <div className="shipment-details">
                <div className="shipment-route">
                    <span>{shipment.origin}</span>
                    <span className="route-arrow">&rarr;</span>
                    <span>{shipment.destination}</span>
                </div>
                <div className="shipment-meta">
                    <span>Carrier: {shipment.carrier}</span>
                    {shipment.etaDate && <span>ETA: {new Date(shipment.etaDate).toLocaleDateString()}</span>}
                    {shipment.currentLocation && <span>Current: {shipment.currentLocation}</span>}
                </div>
                {shipment.carrierTrackingLink && (
                    <a href={shipment.carrierTrackingLink} target="_blank" rel="noopener noreferrer" className="tracking-link">
                        <ExternalLink size={14} /> Track Shipment
                    </a>
                )}
            </div>
        </div>
    );
}

function ProjectCard({ project }: { project: ProjectGroup }) {
    const [expanded, setExpanded] = useState(false);
    const config = LIFECYCLE_CONFIG[project.lifecycle];
    const Icon = config.icon;

    return (
        <div className={`project-card ${config.className}`}>
            <div className="project-card-header" onClick={() => setExpanded(!expanded)}>
                <div className="project-card-left">
                    <span className={`lifecycle-badge ${config.className}`}>
                        <Icon size={14} />
                        {config.label}
                    </span>
                    <h3 className="project-number">{project.projectNumber}</h3>
                </div>
                <div className="project-card-right">
                    <div className="project-site">
                        <MapPin size={14} />
                        {project.jobSite}
                    </div>
                    {project.daysOnSite !== null && (
                        <div className="project-days">
                            <Clock size={14} />
                            {project.daysOnSite} days on site
                        </div>
                    )}
                    {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </div>
            </div>

            {expanded && (
                <div className="project-card-body">
                    {project.outbound && <ShipmentCard shipment={project.outbound} label="Outbound Shipment" />}
                    {project.return && <ShipmentCard shipment={project.return} label="Return Shipment" />}
                    {!project.outbound && !project.return && (
                        <p className="no-shipments">No shipment information available.</p>
                    )}
                </div>
            )}
        </div>
    );
}

export default function ProjectsPage() {
    const { customer } = useAuth();
    const { projects, counts, loading, error } = useCustomerProjects();
    const [filter, setFilter] = useState<ProjectLifecycle | 'all'>('all');

    const filtered = filter === 'all' ? projects : projects.filter(p => p.lifecycle === filter);

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Your Projects</h1>
                    <p className="page-subtitle">Track deployments and shipments for {customer?.companyName}</p>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="kpi-row">
                {(Object.entries(LIFECYCLE_CONFIG) as [ProjectLifecycle, typeof LIFECYCLE_CONFIG[ProjectLifecycle]][]).map(([key, cfg]) => {
                    const Icon = cfg.icon;
                    const count = counts[key] || 0;
                    return (
                        <button
                            key={key}
                            className={`kpi-card ${filter === key ? 'kpi-card--active' : ''} ${cfg.className}`}
                            onClick={() => setFilter(filter === key ? 'all' : key)}
                        >
                            <Icon size={20} />
                            <span className="kpi-count">{count}</span>
                            <span className="kpi-label">{cfg.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* Project List */}
            {loading ? (
                <div className="loading-state">Loading projects...</div>
            ) : error ? (
                <div className="error-state">{error}</div>
            ) : filtered.length === 0 ? (
                <div className="empty-state">
                    <p>No {filter === 'all' ? '' : filter} projects found.</p>
                </div>
            ) : (
                <div className="project-list">
                    {filtered.map((p) => (
                        <ProjectCard key={p.projectNumber} project={p} />
                    ))}
                </div>
            )}
        </div>
    );
}
