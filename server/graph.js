import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';

let _client = null;

/**
 * Get a Microsoft Graph client authenticated via app-only (client credentials).
 * Requires AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env
 */
export function getGraphClient() {
    if (_client) return _client;

    const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;

    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
        throw new Error(
            'Missing Azure credentials. Set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET in .env'
        );
    }

    const credential = new ClientSecretCredential(
        AZURE_TENANT_ID,
        AZURE_CLIENT_ID,
        AZURE_CLIENT_SECRET,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default'],
    });

    _client = Client.initWithMiddleware({ authProvider });
    return _client;
}

// ── SharePoint helpers ─────────────────────────────────────────────

const SITE_HOST = 'hydrowates.sharepoint.com';
const SITE_PATH = '/sites/Hydro-WatesFiles';

/** Cache the site ID after first lookup */
let _siteId = null;

export async function getSiteId() {
    if (_siteId) return _siteId;
    const client = getGraphClient();
    const site = await client.api(`/sites/${SITE_HOST}:${SITE_PATH}`).get();
    _siteId = site.id;
    return _siteId;
}

/** Cache the full list directory so we can resolve display names/IDs */
let _listsByName = null;
let _listsFetchedAt = 0;
const LISTS_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getSiteLists() {
    const now = Date.now();
    if (_listsByName && now - _listsFetchedAt < LISTS_CACHE_TTL_MS) return _listsByName;
    const client = getGraphClient();
    const siteId = await getSiteId();
    const res = await client.api(`/sites/${siteId}/lists?$select=id,name,displayName,webUrl`).get();
    _listsByName = (res.value || []);
    _listsFetchedAt = now;
    return _listsByName;
}

/** Resolve a list by a name that might be its display name or internal name. */
export async function resolveListId(nameOrId) {
    const lists = await getSiteLists();
    const lower = nameOrId.toLowerCase();
    const byName = lists.find(l => l.displayName?.toLowerCase() === lower || l.name?.toLowerCase() === lower);
    return byName?.id || nameOrId;
}

/**
 * Fetch all items from a SharePoint list by display name.
 * Automatically handles paging via @odata.nextLink.
 */
export async function getListItems(listName, selectFields, expandFields) {
    const client = getGraphClient();
    const siteId = await getSiteId();

    let url = `/sites/${siteId}/lists/${listName}/items?$expand=fields`;
    if (selectFields) {
        url += `($select=${selectFields})`;
    }

    const allItems = [];
    let response = await client.api(url).header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly').top(500).get();

    allItems.push(...(response.value || []));

    while (response['@odata.nextLink']) {
        response = await client.api(response['@odata.nextLink']).get();
        allItems.push(...(response.value || []));
    }

    return allItems;
}

/**
 * Get a list item's attachments.
 */
export async function getItemAttachments(listName, itemId) {
    const client = getGraphClient();
    const siteId = await getSiteId();
    const response = await client
        .api(`/sites/${siteId}/lists/${listName}/items/${itemId}/driveItem/children`)
        .get();
    return response.value || [];
}

/**
 * Fetch list item attachments. Tries Graph v1.0 first, falls back to Graph
 * beta, then to SharePoint REST. Returns [{ fileName, absoluteUrl }].
 *
 * Note: classic SharePoint list attachments require either Graph beta's
 * `expand=attachments` or SharePoint REST. Graph v1.0 doesn't expose them
 * directly, so the first attempt may fall through.
 */
export async function getSharePointAttachments(listNameOrId, itemId) {
    const client = getGraphClient();
    const siteId = await getSiteId();

    // Attempt 1: Graph beta expand=attachments
    try {
        const res = await client
            .api(`/sites/${siteId}/lists/${listNameOrId}/items/${itemId}`)
            .version('beta')
            .expand('attachments')
            .get();
        const attachments = res?.attachments || [];
        if (attachments.length) {
            return attachments.map(a => ({
                fileName: a.name,
                absoluteUrl: a.contentLocation || a['@microsoft.graph.downloadUrl'] || '',
            }));
        }
    } catch (err) {
        console.warn('Graph beta attachments fetch failed:', err.message);
    }

    // Attempt 2: SharePoint REST (requires SharePoint API permissions on the app registration)
    const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
    if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) return [];

    const host = SITE_HOST;
    const sitePath = SITE_PATH;

    try {
        const credential = new ClientSecretCredential(AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET);
        const tokenRes = await credential.getToken(`https://${host}/.default`);
        if (!tokenRes?.token) return [];

        const endpoint = `https://${host}${sitePath}/_api/web/lists(guid'${listNameOrId}')/items(${itemId})/AttachmentFiles`;
        const res = await fetch(endpoint, {
            headers: {
                Authorization: `Bearer ${tokenRes.token}`,
                Accept: 'application/json;odata=verbose',
            },
        });
        if (!res.ok) {
            console.warn(`SharePoint REST attachments fetch failed (${res.status})`);
            return [];
        }
        const body = await res.json();
        const rows = body?.d?.results || [];
        return rows.map(r => ({
            fileName: r.FileName,
            absoluteUrl: `https://${host}${r.ServerRelativeUrl}`,
        }));
    } catch (err) {
        console.warn('SharePoint REST attachments fetch error:', err.message);
        return [];
    }
}
