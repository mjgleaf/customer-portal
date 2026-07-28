import axios from 'axios';

/**
 * Axios instance configured for the portal API.
 *
 * In development, Vite proxies /api → http://localhost:3001 (see vite.config.ts).
 * In production, set VITE_API_BASE_URL to the real backend URL.
 * When the backend server is not running, hooks fall back to demo data.
 */
const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
});

// Attach auth token if present
apiClient.interceptors.request.use((config) => {
    const token = sessionStorage.getItem('portal-token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Global error handling
apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            sessionStorage.removeItem('portal-customer');
            sessionStorage.removeItem('portal-token');
            window.location.href = '/login';
        }
        return Promise.reject(error);
    },
);

export default apiClient;

/**
 * Check whether the backend API server is reachable.
 * Used by hooks to decide between real API and demo data.
 */
let _apiAvailable: boolean | null = null;

export async function isApiAvailable(): Promise<boolean> {
    if (_apiAvailable !== null) return _apiAvailable;
    try {
        await apiClient.get('/health', { timeout: 2000 });
        _apiAvailable = true;
    } catch {
        _apiAvailable = false;
        // Re-check every 30 seconds in case server starts later
        setTimeout(() => { _apiAvailable = null; }, 30_000);
    }
    return _apiAvailable;
}
