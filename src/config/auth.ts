import { type Configuration, LogLevel } from '@azure/msal-browser';

const tenantName = import.meta.env.VITE_AZURE_B2C_TENANT_NAME;
const clientId = import.meta.env.VITE_AZURE_B2C_CLIENT_ID;
const signUpSignInPolicy = import.meta.env.VITE_AZURE_B2C_SIGNUP_SIGNIN_POLICY;
const redirectUri = import.meta.env.VITE_AZURE_B2C_REDIRECT_URI;

const b2cAuthority = `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${signUpSignInPolicy}`;

export const msalConfig: Configuration = {
    auth: {
        clientId,
        authority: b2cAuthority,
        knownAuthorities: [`${tenantName}.b2clogin.com`],
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
