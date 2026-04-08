// ── Project Status ──────────────────────────────────────────────────

export type ProjectLifecycle = 'deploying' | 'on-site' | 'returning' | 'completed';

export type ShipmentStatus =
    | 'TENDERED'
    | 'ACCEPTED'
    | 'IN_TRANSIT'
    | 'AT_PICKUP'
    | 'AT_DELIVERY'
    | 'DELIVERED'
    | 'CANCELLED'
    | 'EXCEPTION';

export interface ShipmentEvent {
    type: string;
    time: string;
    detail: string;
    location: string;
}

export interface Shipment {
    id: string;
    status: ShipmentStatus;
    origin: string;
    destination: string;
    carrier: string;
    etaDate: string;
    etaTime: string;
    pickupDate: string;
    deliveryDate: string | null;
    lastUpdateTime: string;
    mode: 'TL' | 'LTL' | 'INTERMODAL' | 'OTHER';
    currentLocation?: string;
    carrierTrackingLink?: string;
    events?: ShipmentEvent[];
}

export interface ProjectGroup {
    projectNumber: string;
    lifecycle: ProjectLifecycle;
    outbound: Shipment | null;
    return: Shipment | null;
    jobSite: string;
    daysOnSite: number | null;
    customerName?: string;
}

// ── Equipment ───────────────────────────────────────────────────────

export type CalibrationUrgency = 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'NOTICE' | 'OK' | 'IN_CALIBRATION';

export interface Equipment {
    id: number;
    serialNumber: string;
    description: string;
    category: string;
    subCategory: string;
    calibrationDate: string;
    expirationDate: string;
    daysUntilExpiry: number;
    urgency: CalibrationUrgency;
    status: string;
    location: string;
    jobId: string | null;
}

// ── Documents ───────────────────────────────────────────────────────

export type DocumentType = 'calibration-cert' | 'delivery-note' | 'risk-assessment' | 'method-statement' | 'invoice';

export interface PortalDocument {
    id: string;
    name: string;
    type: DocumentType;
    projectNumber?: string;
    equipmentSerial?: string;
    date: string;
    downloadUrl: string;
}

// ── Auth ────────────────────────────────────────────────────────────

export interface CustomerProfile {
    companyName: string;
    contactName: string;
    contactEmail: string;
}
