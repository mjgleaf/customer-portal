import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
    useMsal,
    useIsAuthenticated,
    MsalProvider,
} from '@azure/msal-react';
import {
    PublicClientApplication,
    type AccountInfo,
    InteractionStatus,
} from '@azure/msal-browser';
import { msalConfig, loginRequest } from '../config/auth';
import type { CustomerProfile } from '../types';

interface AuthContextValue {
    customer: CustomerProfile | null;
    isAuthenticated: boolean;
    login: () => Promise<void>;
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

export const msalInstance = new PublicClientApplication(msalConfig);

function accountToProfile(account: AccountInfo): CustomerProfile {
    const claims = account.idTokenClaims as Record<string, unknown> | undefined;

    return {
        companyName:
            (claims?.extension_CompanyName as string) ??
            (claims?.company as string) ??
            account.tenantId,
        contactName: account.name ?? account.username,
        contactEmail: account.username,
    };
}

function AuthContextInner({ children }: { children: ReactNode }) {
    const { instance, inProgress, accounts } = useMsal();
    const isAuthenticated = useIsAuthenticated();

    const customer = useMemo<CustomerProfile | null>(() => {
        const account = accounts[0];
        if (!account) return null;
        return accountToProfile(account);
    }, [accounts]);

    const loading = inProgress !== InteractionStatus.None;

    const login = async () => {
        await instance.loginRedirect(loginRequest);
    };

    const logout = () => {
        instance.logoutRedirect({ postLogoutRedirectUri: msalConfig.auth.redirectUri });
    };

    return (
        <AuthContext.Provider
            value={{
                customer,
                isAuthenticated,
                login,
                logout,
                loading,
                error: null,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function AuthProvider({ children }: { children: ReactNode }) {
    return (
        <MsalProvider instance={msalInstance}>
            <AuthContextInner>{children}</AuthContextInner>
        </MsalProvider>
    );
}
