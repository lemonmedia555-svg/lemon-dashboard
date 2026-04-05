/**
 * handler.js — Точка входа Yandex Cloud Function.
 *
 * Принимает GET-запросы от фронтенда (через API Gateway),
 * запрашивает данные из AmoCRM API, считает метрики воронки
 * и возвращает JSON с агрегированными показателями.
 *
 * Параметры запроса:
 *   period      — day | yesterday | week | month (обязательный)
 *   date_from   — начало произвольного периода (ISO 8601)
 *   date_to     — конец произвольного периода (ISO 8601)
 *   manager_id  — ID ответственного менеджера
 *   pipeline_id — ID воронки
 */
'use strict';

const { fetchAllLeads, getUsers, getPipelines, getCustomFields } = require('./amocrm');
const { computeMetrics, computeDiff } = require('./metrics');

// ── Кеш ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

let cachedMeta = null;
let metaCachedAt = 0;
const META_CACHE_TTL = 60 * 60 * 1000; // 1 час

function getCacheKey(params) {
    return `${params.period}|${params.date_from}|${params.date_to}|${params.manager_id}|${params.pipeline_id}`;
}

// Московское время (UTC+3) — AmoCRM работает по MSK
const MSK_OFFSET = 3 * 60 * 60 * 1000;

function getMskToday() {
    const now = new Date();
    const mskNow = new Date(now.getTime() + MSK_OFFSET);
    // Полночь по MSK = начало дня в UTC+3
    return new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate()) - MSK_OFFSET);
}

// Валидация обязательных переменных окружения
const REQUIRED_ENV = ['AMO_DOMAIN', 'AMO_CLIENT_ID', 'AMO_CLIENT_SECRET', 'AMO_ACCESS_TOKEN', 'AMO_REFRESH_TOKEN'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
    }
}

function getDateRange(period, dateFrom, dateTo) {
    const today = getMskToday();

    if (dateFrom && dateTo) {
        // Пользовательские даты интерпретируем как MSK
        const from = new Date(dateFrom + 'T00:00:00+03:00');
        const to = new Date(dateTo + 'T23:59:59.999+03:00');
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
            throw new Error('Invalid date format');
        }
        if (from > to) {
            throw new Error('date_from must be before date_to');
        }
        return { from, to };
    }

    switch (period) {
        case 'day': {
            return { from: today, to: new Date(today.getTime() + 86400000 - 1) };
        }
        case 'yesterday': {
            const yesterday = new Date(today.getTime() - 86400000);
            return { from: yesterday, to: new Date(today.getTime() - 1) };
        }
        case 'week': {
            const dayOfWeek = today.getUTCDay() || 7;
            const monday = new Date(today.getTime() - (dayOfWeek - 1) * 86400000);
            const sunday = new Date(monday.getTime() + 7 * 86400000 - 1);
            return { from: monday, to: sunday };
        }
        case 'month': {
            const mskNow = new Date(today.getTime() + MSK_OFFSET);
            const firstDay = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), 1) - MSK_OFFSET);
            const lastDay = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth() + 1, 1) - MSK_OFFSET - 1);
            return { from: firstDay, to: lastDay };
        }
        default:
            return { from: today, to: new Date(today.getTime() + 86400000 - 1) };
    }
}

function getPreviousDateRange(period, range) {
    const duration = range.to.getTime() - range.from.getTime();

    switch (period) {
        case 'day':
            return {
                from: new Date(range.from.getTime() - 86400000),
                to: new Date(range.to.getTime() - 86400000),
            };
        case 'week':
            return {
                from: new Date(range.from.getTime() - 7 * 86400000),
                to: new Date(range.to.getTime() - 7 * 86400000),
            };
        case 'month': {
            const prevFrom = new Date(range.from);
            prevFrom.setMonth(prevFrom.getMonth() - 1);
            const prevTo = new Date(prevFrom.getFullYear(), prevFrom.getMonth() + 1, 0, 23, 59, 59, 999);
            return { from: prevFrom, to: prevTo };
        }
        default:
            return {
                from: new Date(range.from.getTime() - duration - 1),
                to: new Date(range.from.getTime() - 1),
            };
    }
}

function toUnix(date) {
    return Math.floor(date.getTime() / 1000);
}

function formatDate(date) {
    // Форматируем в MSK
    const msk = new Date(date.getTime() + MSK_OFFSET);
    return msk.toISOString().split('T')[0];
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

async function getMeta() {
    const now = Date.now();
    if (cachedMeta && now - metaCachedAt < META_CACHE_TTL) {
        return cachedMeta;
    }

    const [users, pipelines, customFields] = await Promise.all([
        getUsers(),
        getPipelines(),
        getCustomFields(),
    ]);

    // Ищем поле "Источник"
    const sourceField = customFields.find(f => {
        const name = (f.name || '').toLowerCase();
        return name.includes('источник') || name === 'source' || name === 'utm_source';
    });

    cachedMeta = {
        users,
        pipelines,
        sourceFieldId: sourceField ? sourceField.id : null,
    };
    metaCachedAt = now;

    return cachedMeta;
}

async function fetchLeadsForRange(range, managerId, pipelineId) {
    const params = {
        'filter[created_at][from]': toUnix(range.from),
        'filter[created_at][to]': toUnix(range.to),
        with: 'contacts',
    };

    if (managerId) {
        params['filter[responsible_user_id]'] = managerId;
    }
    if (pipelineId) {
        params['filter[pipeline_id][]'] = pipelineId;
    }

    return fetchAllLeads(params);
}

module.exports.handler = async function (event) {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders(),
            body: '',
        };
    }

    try {
        const qs = event.queryStringParameters || {};
        const period = qs.period || 'day';
        const dateFrom = qs.date_from || null;
        const dateTo = qs.date_to || null;
        const managerId = qs.manager_id ? Number(qs.manager_id) : null;
        const pipelineId = qs.pipeline_id ? Number(qs.pipeline_id) : null;

        // Проверка кеша
        const cacheKey = getCacheKey({ period, date_from: dateFrom, date_to: dateTo, manager_id: managerId, pipeline_id: pipelineId });
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json', ...corsHeaders() },
                body: JSON.stringify(cached.data),
            };
        }

        // Получаем мета-данные
        const meta = await getMeta();

        // Определяем диапазон дат
        const range = getDateRange(period, dateFrom, dateTo);
        const prevRange = getPreviousDateRange(period, range);

        // Определяем статусы воронки
        let pipelineStatuses = [];
        if (pipelineId) {
            const pipeline = meta.pipelines.find(p => p.id === pipelineId);
            if (pipeline) pipelineStatuses = pipeline.statuses;
        } else if (meta.pipelines.length > 0) {
            pipelineStatuses = meta.pipelines[0].statuses;
        }

        // Запрашиваем сделки за текущий период
        const currentLeads = await fetchLeadsForRange(range, managerId, pipelineId);
        const currentMetrics = computeMetrics(currentLeads, pipelineStatuses, meta.sourceFieldId);

        // Предыдущий период — опционально, при ошибке возвращаем без diff
        let totals;
        try {
            const previousLeads = await fetchLeadsForRange(prevRange, managerId, pipelineId);
            const previousMetrics = computeMetrics(previousLeads, pipelineStatuses, meta.sourceFieldId);
            totals = computeDiff(currentMetrics.totals, previousMetrics.totals);
        } catch (prevErr) {
            console.log('Previous period failed, returning without diff:', prevErr.message);
            const t = currentMetrics.totals;
            totals = {
                leads: t.leads, leads_diff: 0,
                quals: t.quals, quals_diff: 0,
                kp: t.kp, kp_diff: 0,
                invoices: t.invoices, invoices_diff: 0,
                invoices_sum: t.invoices_sum, invoices_sum_diff: 0,
                payments: t.payments, payments_diff: 0,
                payments_sum: t.payments_sum, payments_sum_diff: 0,
            };
        }

        const responseData = {
            period,
            date_from: formatDate(range.from),
            date_to: formatDate(range.to),
            managers: meta.users.map(u => ({ id: u.id, name: u.name })),
            pipelines: meta.pipelines.map(p => ({ id: p.id, name: p.name })),
            totals,
            by_source: currentMetrics.by_source,
        };

        // Сохраняем в кеш
        cache.set(cacheKey, { data: responseData, timestamp: Date.now() });

        // Очищаем старые записи кеша
        for (const [key, val] of cache.entries()) {
            if (Date.now() - val.timestamp > CACHE_TTL) cache.delete(key);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() },
            body: JSON.stringify(responseData),
        };

    } catch (err) {
        console.error('Handler error:', err);

        if (err.message === 'Invalid date format' || err.message === 'date_from must be before date_to') {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders() },
                body: JSON.stringify({ error: err.message }),
            };
        }

        if (err.statusCode === 429) {
            return {
                statusCode: 503,
                headers: { 'Content-Type': 'application/json', 'Retry-After': err.retryAfter || '5', ...corsHeaders() },
                body: JSON.stringify({ error: 'AmoCRM rate limit, retry later' }),
            };
        }

        return {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() },
            body: JSON.stringify({ error: 'AmoCRM API unavailable' }),
        };
    }
};
