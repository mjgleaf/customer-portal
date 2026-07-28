import apiClient from './client';

export interface LoadOutMobilization {
    mobilizationNo: string;
    jobNumber: string;
    created: string | null;
}

export interface LoadOutItem {
    id: string;
    mobilizationNo: string;
    jobNumber: string;
    serial: string;
    description: string;
    category: string;
    quantity: number;
    availableQty: number;
    serialized: boolean;
    unitWeight: number;
    totalWeight: number;
    boxNumber: string;
    assemblySN: string;
    status: string;
    created: string | null;
    hasCertificate: boolean;
}

export async function fetchLoadOutMobilizations(): Promise<LoadOutMobilization[]> {
    const { data } = await apiClient.get<LoadOutMobilization[]>('/ops/loadouts');
    return data;
}

export async function fetchLoadOutItems(mobilizationNo: string): Promise<LoadOutItem[]> {
    const { data } = await apiClient.get<LoadOutItem[]>(
        `/ops/loadouts/${encodeURIComponent(mobilizationNo)}/items`,
    );
    return data;
}
