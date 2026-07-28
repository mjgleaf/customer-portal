import apiClient from './client';
import type { ProjectGroup, Equipment, PortalDocument } from '../types';

// ── Projects ──────────────────────────────────────────────────────────

export async function fetchProjects(companyName: string): Promise<ProjectGroup[]> {
    const { data } = await apiClient.get<ProjectGroup[]>('/portal/projects', {
        params: { customer: companyName },
    });
    return data;
}

// ── Equipment ─────────────────────────────────────────────────────────

export async function fetchEquipment(companyName: string): Promise<Equipment[]> {
    const { data } = await apiClient.get<Equipment[]>('/portal/equipment', {
        params: { customer: companyName },
    });
    return data;
}

// ── Documents ─────────────────────────────────────────────────────────

export async function fetchDocuments(companyName: string): Promise<PortalDocument[]> {
    const { data } = await apiClient.get<PortalDocument[]>('/portal/documents', {
        params: { customer: companyName },
    });
    return data;
}

export async function uploadDocument(file: File, metadata: {
    projectNumber?: string;
    equipmentSerial?: string;
    type: string;
}): Promise<PortalDocument> {
    const form = new FormData();
    form.append('file', file);
    form.append('metadata', JSON.stringify(metadata));
    const { data } = await apiClient.post<PortalDocument>('/portal/documents/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
}

export async function getDocumentDownloadUrl(docId: string): Promise<string> {
    const { data } = await apiClient.get<{ url: string }>(`/portal/documents/${docId}/download`);
    return data.url;
}

// ── Support ───────────────────────────────────────────────────────────

export interface SupportTicket {
    category: string;
    subject: string;
    message: string;
    contactEmail: string;
}

export async function submitSupportTicket(ticket: SupportTicket): Promise<{ ticketId: string }> {
    const { data } = await apiClient.post<{ ticketId: string }>('/portal/support', ticket);
    return data;
}

// ── Profile ───────────────────────────────────────────────────────────

export interface ProfileUpdatePayload {
    contactName: string;
    contactEmail: string;
    phone?: string;
    notifyShipments: boolean;
    notifyCalibration: boolean;
    notifyDocuments: boolean;
}

export async function updateProfile(payload: ProfileUpdatePayload): Promise<void> {
    await apiClient.put('/portal/profile', payload);
}
