import { createContext, useContext, useState, type ReactNode } from 'react';
import type { CustomerProfile } from '../types';

interface AuthContextValue {
    customer: CustomerProfile | null;
    isAuthenticated: boolean;
    login: (email: string, password: string) => Promise<void>;
    logout: () => void;
    loading: boolean;
    error: string | null;
}

const AuthContext = createContext<AuthContextValue>({
    customer: null,
    isAuthenticated: false,
    login: async () => {},
    logout: () => {},
    loading: false,
    error: null,
});

export function useAuth() {
    return useContext(AuthContext);
}

/**
 * For now, this uses a simple demo auth flow.
 * In production this would integrate with Azure AD B2C or similar
 * to authenticate external customers.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
    const [customer, setCustomer] = useState<CustomerProfile | null>(() => {
        const saved = sessionStorage.getItem('portal-customer');
        return saved ? JSON.parse(saved) : null;
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const login = async (email: string, _password: string) => {
        setLoading(true);
        setError(null);
        try {
            // Demo: derive company from email domain
            const domain = email.split('@')[1]?.split('.')[0] || 'Customer';
            const companyName = domain.charAt(0).toUpperCase() + domain.slice(1);
            const profile: CustomerProfile = {
                companyName,
                contactName: email.split('@')[0].replace(/[._]/g, ' '),
                contactEmail: email,
            };
            sessionStorage.setItem('portal-customer', JSON.stringify(profile));
            setCustomer(profile);
        } catch (err: any) {
            setError(err.message || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    const logout = () => {
        sessionStorage.removeItem('portal-customer');
        setCustomer(null);
    };

    return (
        <AuthContext.Provider value={{
            customer,
            isAuthenticated: !!customer,
            login,
            logout,
            loading,
            error,
        }}>
            {children}
        </AuthContext.Provider>
    );
}
