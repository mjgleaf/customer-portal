import { type Configuration, LogLevel } from '@azure/msal-browser';

const clientId = import.meta.env.VITE_AZURE_CLIENT_ID;
const tenantId = import.meta.env.VITE_AZURE_TENANT_ID;
const redirectUri = import.meta.env.VITE_AZURE_REDIRECT_URI;

export const msalConfig: Configuration = {
    auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri,
        postLogoutRedirectUri: redirectUri,
    },
    cache: {
        cacheLocation: 'sessionStorage',
    },
    system: {
        loggerOptions: {
            logLevel: LogLevel.Warning,
            loggerCallback: (_level, message, containsPii) => {
                if (!containsPii) {
                    console.debug('[MSAL]', message);
                }
            },
        },
    },
};

export const loginRequest = {
    scopes: ['openid', 'profile', 'email'],
};
