# Project handoff

## Purpose

This is an internal decision-support dashboard for IBOX sales operations. Its goal is to reveal marketing lead quality, Sales execution problems, stage overload, response SLA, channel quality, manager workload, lost reasons and completed sales without unfairly blaming sellers or overstating performance.

The dashboard is not the system of record. Bitrix24 is the source of truth. D1 is a synchronized analytics cache plus app settings.

## Current production scope

- Primary focus: IBOX Sales.
- Matching outcome funnel: IBOX Обучение/Сопровождение.
- Optional second project: SD Sales + SD Обучение/Сопровождение.
- Excluded: call-center and unrelated pipelines.
- Time zone: `Asia/Tashkent`.
- One currency is expected across the analyzed project.

Pipeline and field IDs are selected in the dashboard settings and stored in D1. Do not hard-code IDs from screenshots or old conversations.

## Key concepts

- **Live inventory:** all currently open deals in selected Sales funnels. No creation-date restriction.
- **Historical cohort:** deals created in a selected date range, enriched with later outcome and history where synchronized.
- **Qualified / SQL:** accepted into the configured SQL stage, normally Обработка. Lost and won deals are also treated as quality accepted if incomplete history prevents direct SQL detection.
- **Low quality:** current/final `Not Relevant`; always attributed to Marketing quality.
- **Sales loss:** closed and not realized after acceptance; reported separately from low quality.
- **Won:** payment reached or card moved to the matching post-sale funnel.
- **Project lead:** one unique Bitrix deal ID across Sales and matching post-sale movement.

## Where to change behavior

| Requirement | Primary code |
| --- | --- |
| Low-quality, lost and won classification | `lib/sales-logic.ts` |
| SQL, seller attribution, calls and stage timeline | `lib/analytics.ts` |
| Funnel discovery and pairing | `lib/pipelines.ts` |
| Historical sync scope and batching | `lib/sync.ts` |
| Current open-stage snapshot | `app/api/current-stages/route.ts`, `lib/current-stages.ts` |
| Date/filter semantics and UI metrics | `app/dashboard-client.tsx` |
| Persistence and settings | `lib/storage.ts`, `db/schema.ts` |

## Accuracy discipline

For every metric change, explicitly answer:

1. What is the numerator?
2. What is the denominator?
3. Is the population live inventory or a historical cohort?
4. Which date controls membership: creation, qualification, payment, closing, or current state?
5. Is one deal ID counted once?
6. Which manager attribution timestamp is used?
7. What happens when history, calls or a custom field are missing?

Never merge a change when these answers are unclear.

## Known limitations

- Bitrix field names and enum values are tenant-specific and must be discovered/configured.
- Call outcome completeness depends on Bitrix telephony permissions and provider records.
- Duplicate diagnostics use Contact ID first and Company ID second; they are a signal, not automatic deletion.
- Historical completeness depends on sync range. Current-stage inventory is intentionally independent of that range.
- GitHub does not contain the production D1 data, Sites access policy or runtime secret.

## Safe first task for a new maintainer

1. Run `npm ci`.
2. Run `npm run verify` without a production secret.
3. Read the existing tests as executable business examples.
4. Make one fixture-only change before touching sync or attribution.
5. For production validation, compare one visible Bitrix stage count with the dashboard reconciliation panel.

## Emergency continuity

If the original ChatGPT account is unavailable:

- continue code work in the private GitHub repository;
- use pull requests so changes remain reviewable;
- do not paste the production webhook into Claude, ChatGPT or GitHub;
- either wait for the owner account to publish the approved commit, or create a replacement Site and configure a new server-side webhook secret;
- on a replacement Site, run a fresh selected-funnel full sync to rebuild D1 analytics.
