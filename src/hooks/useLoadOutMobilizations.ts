import { useCallback, useEffect, useState } from 'react';
import { fetchLoadOutMobilizations, type LoadOutMobilization } from '../api/opsApi';

export function useLoadOutMobilizations(autoRefreshMs = 60_000) {
    const [items, setItems] = useState<LoadOutMobilization[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const data = await fetchLoadOutMobilizations();
            setItems(data);
            setError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load mobilizations';
            setError(message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, autoRefreshMs);
        return () => clearInterval(id);
    }, [load, autoRefreshMs]);

    return { items, loading, error, refresh: load };
}
