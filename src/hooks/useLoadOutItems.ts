import { useCallback, useEffect, useState } from 'react';
import { fetchLoadOutItems, type LoadOutItem } from '../api/opsApi';

export function useLoadOutItems(mobilizationNo: string | undefined) {
    const [items, setItems] = useState<LoadOutItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!mobilizationNo) return;
        try {
            setLoading(true);
            const data = await fetchLoadOutItems(mobilizationNo);
            setItems(data);
            setError(null);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load items';
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [mobilizationNo]);

    useEffect(() => {
        load();
    }, [load]);

    return { items, loading, error, refresh: load };
}
