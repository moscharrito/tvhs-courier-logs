/* Project settings.
 *
 *   GET   /api/projects/:pid/settings    admin, courier
 *   PATCH /api/projects/:pid/settings    admin
 *
 * GET returns the resolved settings and the contract defaults side by side,
 * so a screen can mark which values a person changed.
 *
 * PATCH is a partial merge, section by section: sending { pricing: { ... } }
 * leaves the sla section alone. Only leaves that actually moved are written
 * to the audit trail, with their new values. That is a deliberate exception
 * to the "field names only" rule in core/audit: these are contract
 * parameters, not PHI, and an invoice dispute turns on who changed the
 * after-hours window and when.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Client } from '@libsql/client';
import { requireProjectRole } from './middleware';
import {
    SettingsPatch, DEFAULT_PROJECT_SETTINGS, resolveSettings, mergeSettings,
    changedPaths, settingValue, dueTimesFor, type ServiceType,
} from './settings';
import {
    validateTemplate, windowText, segmentsFor, STAGES, STAGE_NAMES, type Stage,
} from '../notify/sms-template';

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function createProjectSettingsRouter({ client }: { client: Client }): Router {
    const router = Router({ mergeParams: true });
    const manage = requireProjectRole('admin');
    /* The courier app reads business hours from here, so a courier reads it
     * too. A client viewer does not: these are the operating parameters of the
     * contract, including the internal goal we hold ourselves to above the
     * 85% University Health measures us against, and a pharmacy contact
     * reading that learns what our own target is. Open to any member until
     * the access matrix in ticket 4.2 made the question explicit. */
    const readers = requireProjectRole('admin', 'courier');

    function present(timezone: string, stored: Record<string, unknown>, canManage: boolean) {
        const settings = resolveSettings(stored);
        const at = new Date();
        return {
            timezone,
            settings,
            defaults: DEFAULT_PROJECT_SETTINGS,
            /** Leaves that differ from the contract default, so the UI can mark them. */
            overridden: changedPaths(DEFAULT_PROJECT_SETTINGS, settings),
            canManage,
            /* What the current rules mean for an order received right now.
               A due time is easier to sanity-check than four numbers. */
            example: (['scheduled', 'stat', 'adhoc'] as ServiceType[]).map((serviceType) => {
                const d = dueTimesFor({ serviceType, receivedAt: at }, settings);
                return {
                    serviceType,
                    receivedAt: at.toISOString(),
                    dueAt: d.dueAt ? d.dueAt.toISOString() : null,
                    minutes: d.minutes,
                    from: d.from,
                    pending: d.pending,
                    basis: d.basis,
                };
            }),
        };
    }

    async function storedFor(projectId: number): Promise<{ timezone: string; settings: Record<string, unknown> }> {
        const rs = await client.execute({ sql: 'SELECT timezone, settings FROM projects WHERE id = ?', args: [projectId] });
        const row = rs.rows[0];
        let parsed: Record<string, unknown> = {};
        try {
            const v: unknown = JSON.parse(String(row?.['settings'] ?? '{}'));
            if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
        } catch { /* a corrupt blob resolves to the defaults rather than failing the read */ }
        return { timezone: String(row?.['timezone'] ?? 'America/Chicago'), settings: parsed };
    }

    router.get('/', readers, wrap(async (req, res) => {
        const role = req.membership?.role;
        const { timezone, settings } = await storedFor(req.project!.id);
        res.json(present(timezone, settings, role === 'admin'));
    }));

    /**
     * What the patient text would actually say.
     *
     *   POST /api/projects/:pid/settings/patient-sms/preview
     *
     * A template is a sentence with holes in it, and nobody can reliably read
     * one and know what arrives on a phone: the window and the call time come
     * from other fields, and the length decides whether it is one text or
     * three. So this renders a candidate without storing it.
     *
     * Deliberately not a GET with query parameters. The wording is edited in a
     * textarea and would have to be URL-encoded into a query string, where it
     * would also land in the access log of anything in front of this.
     *
     * Refusals come back as 200 with `ok: false`, not 400. Somebody typing in
     * a box has not made a bad request; they are mid-sentence, and a preview
     * pane should say what is wrong rather than look broken.
     */
    router.post('/patient-sms/preview', manage, wrap(async (req, res) => {
        const { settings: stored } = await storedFor(req.project!.id);
        const current = resolveSettings(stored).patientSms;
        const body = (req.body ?? {}) as Record<string, unknown>;

        const stage = STAGE_NAMES.includes(body['stage'] as Stage) ? body['stage'] as Stage : 'delivery_today';
        const template = typeof body['template'] === 'string' ? body['template'] : current.stages[stage].template;
        const start = typeof body['windowStart'] === 'string' ? body['windowStart'] : current.windowStart;
        const end = typeof body['windowEnd'] === 'string' ? body['windowEnd'] : current.windowEnd;
        const minutes = typeof body['callMinutes'] === 'number' ? body['callMinutes'] : current.callMinutes;
        const company = typeof body['company'] === 'string' ? body['company'] : current.company;

        const vars = {
            company,
            window: windowText(start, end),
            callMinutes: String(minutes),
            /* A fixed sample rather than the clock, so a preview taken twice
               reads the same and a screenshot of it stays true. */
            time: '2:15 PM',
        };
        try {
            const text = validateTemplate(template, vars, stage);
            const { encoding, segments, units } = segmentsFor(text);
            res.json({
                ok: true,
                text,
                encoding,
                segments,
                characters: units,
                /* Said plainly, because the cost of a campaign is per segment
                   and a sentence that tips over 160 characters doubles it. */
                note: segments === 1
                    ? 'One text message.'
                    : `${segments} text messages, so each person costs ${segments} times as much.`,
                stage,
                placeholders: STAGES[stage].placeholders,
            });
        } catch (err) {
            res.json({
                ok: false, error: (err as Error).message, stage, placeholders: STAGES[stage].placeholders,
            });
        }
    }));

    /**
     * Every stage there is, what it is for, and what it currently says.
     *
     *   GET /api/projects/:pid/settings/patient-sms
     *
     * So a settings screen can list them without hard-coding six names that
     * would then have to be kept in step with the server's six.
     */
    router.get('/patient-sms', manage, wrap(async (req, res) => {
        const { settings: stored } = await storedFor(req.project!.id);
        const current = resolveSettings(stored).patientSms;
        res.json({
            windowStart: current.windowStart,
            windowEnd: current.windowEnd,
            callMinutes: current.callMinutes,
            company: current.company,
            stages: STAGE_NAMES.map((name) => {
                const spec = STAGES[name];
                const saved = current.stages[name];
                let text = '';
                let error: string | null = null;
                try {
                    text = validateTemplate(saved.template, {
                        company: current.company,
                        window: windowText(current.windowStart, current.windowEnd),
                        callMinutes: String(current.callMinutes),
                        time: '2:15 PM',
                    }, name);
                } catch (err) {
                    /* Stored wording that would now be refused. Shown rather
                       than hidden: it is the screen's job to say so, and a
                       stage whose text cannot render is one that will fail at
                       send time instead. */
                    error = (err as Error).message;
                }
                return {
                    stage: name,
                    label: spec.label,
                    when: spec.when,
                    placeholders: spec.placeholders,
                    enabled: saved.enabled,
                    template: saved.template,
                    preview: text,
                    segments: text ? segmentsFor(text).segments : 0,
                    error,
                };
            }),
        });
    }));

    router.patch('/', manage, wrap(async (req, res) => {
        const parsed = SettingsPatch.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: 'Invalid request',
                details: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
            });
            return;
        }
        const patch = parsed.data;

        const { timezone: currentTz, settings: stored } = await storedFor(req.project!.id);
        const before = resolveSettings(stored);
        const merged = mergeSettings(stored, patch);
        const after = resolveSettings(merged);

        const nextTz = patch.timezone ?? currentTz;
        const paths = changedPaths(before, after);
        const tzChanged = nextTz !== currentTz;

        if (paths.length === 0 && !tzChanged) {
            res.json(present(currentTz, stored, true));
            return;
        }

        await client.execute({
            sql: 'UPDATE projects SET settings = ?, timezone = ? WHERE id = ?',
            args: [JSON.stringify(merged), nextTz, req.project!.id],
        });

        await req.audit('project.settings.update', 'project', req.project!.code, {
            changed: [...paths, ...(tzChanged ? ['timezone'] : [])],
            to: [
                ...paths.map((p) => `${p}=${settingValue(after, p)}`),
                ...(tzChanged ? [`timezone="${nextTz}"`] : []),
            ],
        });

        res.json(present(nextTz, merged, true));
    }));

    return router;
}
