/**
 * metrics.js — Расчёт метрик воронки продаж.
 *
 * Считает лиды, квалы, КП, счета, оплаты по этапам воронки.
 * Группирует данные по источникам (кастомное поле «Источник»).
 * Вычисляет разницу с предыдущим периодом.
 */
'use strict';

function getSourceFromLead(lead, sourceFieldId) {
    if (!lead.custom_fields_values) return 'Неизвестно';

    // Ищем по ID если есть, иначе по имени "Источник"
    let field = null;
    if (sourceFieldId) {
        field = lead.custom_fields_values.find(f => f.field_id === sourceFieldId);
    }
    if (!field) {
        field = lead.custom_fields_values.find(f =>
            f.field_name && f.field_name.toLowerCase() === 'источник'
        );
    }
    if (!field || !field.values || !field.values[0]) return 'Неизвестно';

    return field.values[0].value;
}

const SOURCE_KEY_MAP = {
    'яндекс': 'yandex',
    'яндекс.директ': 'yandex',
    'яндекс директ': 'yandex',
    'yandex': 'yandex',
    'вк': 'vk',
    'vk': 'vk',
    'вконтакте': 'vk',
    'лидформа вк': 'vk',
    'инст': 'inst',
    'instagram': 'inst',
    'инстаграм': 'inst',
    'инстаграм смм': 'inst',
    'инстаграм на квиз': 'inst',
    'органика': 'organic',
    'organic': 'organic',
    'telegram': 'telegram',
    'телеграм': 'telegram',
    'whatsapp': 'whatsapp',
    'ватсап': 'whatsapp',
    'рекомендация': 'recom',
    'партнерка': 'recom',
    'повторный': 'repeat',
    'повторный клиент': 'repeat',
    'повторные продажи': 'repeat',
    'прочее': 'organic',
    'почта': 'organic',
};

function getSourceKey(sourceName) {
    const lower = (sourceName || '').toLowerCase().trim();
    return SOURCE_KEY_MAP[lower] || lower.replace(/\s+/g, '_');
}

function computeMetrics(leads, pipelineStatuses, sourceFieldId) {
    const statusesSorted = [...pipelineStatuses].sort((a, b) => a.sort - b.sort);

    // В AmoCRM: type=1 — "Неразобранное", type=0 — все остальные (включая обычные этапы!)
    // Успешно = id 142, Закрыто = id 143 — определяются по id, не по type

    // Ищем ключевые этапы по имени
    let qualStatusSort = null;
    let kpStatusSort = null;
    let invoiceStatusSort = null;

    for (const s of statusesSorted) {
        const name = (s.name || '').toLowerCase();
        if (name.includes('квалиф')) qualStatusSort = s.sort;
        if (name.includes('кп отправлено') || name.includes('отправлено кп') || name.includes('4. кп')) kpStatusSort = s.sort;
        if (name.includes('договор') || name.includes('счёт') || name.includes('счет') || name.includes('6. договор')) invoiceStatusSort = s.sort;
    }

    // Fallback: по позиции если имена не нашлись
    // Обычные этапы (не неразобранное, не успешно/закрыто)
    const workStatuses = statusesSorted.filter(s => s.type !== 1 && s.id !== 142 && s.id !== 143);
    if (!qualStatusSort && workStatuses.length >= 3) qualStatusSort = workStatuses[2].sort;
    if (!kpStatusSort && workStatuses.length >= 4) kpStatusSort = workStatuses[3].sort;
    if (!invoiceStatusSort && workStatuses.length >= 5) invoiceStatusSort = workStatuses[5] ? workStatuses[5].sort : null;

    const totals = {
        leads: 0,
        quals: 0,
        kp: 0,
        invoices: 0,
        invoices_sum: 0,
        payments: 0,
        payments_sum: 0,
    };

    const bySourceMap = {};

    for (const lead of leads) {
        const sourceName = getSourceFromLead(lead, sourceFieldId);
        const sourceKey = getSourceKey(sourceName);

        if (!bySourceMap[sourceKey]) {
            bySourceMap[sourceKey] = {
                source: sourceName,
                source_key: sourceKey,
                leads: 0, quals: 0, kp: 0,
                invoices: 0, invoices_sum: 0,
                payments: 0, payments_sum: 0,
            };
        }
        const src = bySourceMap[sourceKey];

        // Lead count (all leads in the period)
        totals.leads++;
        src.leads++;

        const leadStatus = statusesSorted.find(s => s.id === lead.status_id);
        const leadSort = leadStatus ? leadStatus.sort : 0;
        // Успешно реализовано = id 142, Закрыто = id 143
        const isSuccess = lead.status_id === 142;
        const isClosed = lead.status_id === 143;
        const price = lead.price || 0;

        // Не считаем закрытые/проигранные сделки в воронке
        if (isClosed) continue;

        // Quals: текущий этап >= "Квалификация" (или успешно)
        if (qualStatusSort !== null && (leadSort >= qualStatusSort || isSuccess)) {
            totals.quals++;
            src.quals++;
        }

        // KP: текущий этап >= "КП отправлено" (или успешно)
        if (kpStatusSort !== null && (leadSort >= kpStatusSort || isSuccess)) {
            totals.kp++;
            src.kp++;
        }

        // Invoices: текущий этап >= "Договор/Счёт" (или успешно)
        if (invoiceStatusSort !== null && (leadSort >= invoiceStatusSort || isSuccess)) {
            totals.invoices++;
            src.invoices++;
            totals.invoices_sum += price;
            src.invoices_sum += price;
        }

        // Payments: только "Успешно реализовано"
        if (isSuccess) {
            totals.payments++;
            src.payments++;
            totals.payments_sum += price;
            src.payments_sum += price;
        }
    }

    return {
        totals,
        by_source: Object.values(bySourceMap).sort((a, b) => b.leads - a.leads),
    };
}

function computeDiff(current, previous) {
    return {
        leads: current.leads,
        leads_diff: current.leads - previous.leads,
        quals: current.quals,
        quals_diff: current.quals - previous.quals,
        kp: current.kp,
        kp_diff: current.kp - previous.kp,
        invoices: current.invoices,
        invoices_diff: current.invoices - previous.invoices,
        invoices_sum: current.invoices_sum,
        invoices_sum_diff: current.invoices_sum - previous.invoices_sum,
        payments: current.payments,
        payments_diff: current.payments - previous.payments,
        payments_sum: current.payments_sum,
        payments_sum_diff: current.payments_sum - previous.payments_sum,
    };
}

module.exports = { computeMetrics, computeDiff, getSourceKey };
