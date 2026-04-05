/**
 * amocrm.js — Модуль для работы с AmoCRM API v4.
 *
 * Содержит функции для запросов к API, пагинацию,
 * авто-обновление токена и retry при 429/500 ошибках.
 */
'use strict';

const fetch = require('node-fetch');

const AMO_DOMAIN = process.env.AMO_DOMAIN;
const AMO_CLIENT_ID = process.env.AMO_CLIENT_ID;
const AMO_CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;

let accessToken = process.env.AMO_ACCESS_TOKEN;
let refreshToken = process.env.AMO_REFRESH_TOKEN;

const BASE_URL = `https://${AMO_DOMAIN}`;

// Защита от параллельных рефрешей токена
let refreshPromise = null;

async function refreshAccessToken() {
    // Если уже идёт рефреш — ждём его результат
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        const res = await fetch(`${BASE_URL}/oauth2/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: AMO_CLIENT_ID,
                client_secret: AMO_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                redirect_uri: `https://${AMO_DOMAIN}`,
            }),
        });

        if (!res.ok) {
            throw new Error(`Failed to refresh token: ${res.status} ${await res.text()}`);
        }

        const data = await res.json();
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        return accessToken;
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function amoRequest(path, params = {}, retries = 3) {
    const url = new URL(`${BASE_URL}${path}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) {
            url.searchParams.set(k, v);
        }
    });

    for (let attempt = 0; attempt < retries; attempt++) {
        let res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.status === 401) {
            await refreshAccessToken();
            res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        }

        if (res.status === 429) {
            const wait = parseInt(res.headers.get('Retry-After') || '3', 10) * 1000;
            await sleep(wait);
            continue;
        }

        if (res.status >= 500 && attempt < retries - 1) {
            console.log(`AmoCRM 500 on ${path}, retry ${attempt + 1}/${retries}`);
            await sleep(1000 * (attempt + 1));
            continue;
        }

        if (res.status === 204) return null;

        if (!res.ok) {
            throw new Error(`AmoCRM API error: ${res.status} ${await res.text()}`);
        }

        return res.json();
    }

    throw new Error(`AmoCRM API failed after ${retries} retries on ${path}`);
}

async function fetchAllLeads(filterParams) {
    const leads = [];
    let page = 1;
    const limit = 250;

    while (true) {
        const params = { ...filterParams, limit, page };
        const data = await amoRequest('/api/v4/leads', params);

        if (!data || !data._embedded || !data._embedded.leads) break;

        leads.push(...data._embedded.leads);

        if (data._embedded.leads.length < limit) break;
        page++;
        await sleep(200); // Пауза между страницами
    }

    return leads;
}

async function getUsers() {
    const users = [];
    let page = 1;
    while (true) {
        const data = await amoRequest('/api/v4/users', { page, limit: 250 });
        if (!data || !data._embedded || !data._embedded.users) break;
        users.push(...data._embedded.users);
        if (data._embedded.users.length < 250) break;
        page++;
    }
    return users
        .filter(u => u.rights && u.rights.is_active === true)
        .map(u => ({ id: u.id, name: u.name }));
}

async function getPipelines() {
    const data = await amoRequest('/api/v4/leads/pipelines');
    if (!data || !data._embedded || !data._embedded.pipelines) return [];
    return data._embedded.pipelines.map(p => ({
        id: p.id,
        name: p.name,
        statuses: (p._embedded && p._embedded.statuses || []).map(s => ({
            id: s.id,
            name: s.name,
            sort: s.sort,
            type: s.type,
        })),
    }));
}

async function getCustomFields() {
    const data = await amoRequest('/api/v4/leads/custom_fields');
    if (!data || !data._embedded || !data._embedded.custom_fields) return [];
    return data._embedded.custom_fields;
}

module.exports = {
    fetchAllLeads,
    getUsers,
    getPipelines,
    getCustomFields,
    amoRequest,
};
