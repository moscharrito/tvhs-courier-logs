/* Landing page for a project that has no module screens yet (UH until the
   dispatch module ships in Phases 1 and 2). Members see the project and
   their role; the TVHS project never lands here because its route mounts
   the legacy app directly. */

import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../app/auth';
import { Sites } from './uh/Sites';
import { Pricing } from './uh/Pricing';
import { ListImport } from './uh/ListImport';
import { NewOrder } from './uh/NewOrder';
import { ProjectSettings } from './ProjectSettings';

const ROLE_LABEL: Record<string, string> = {
    admin: 'Admin', ops_manager: 'Ops manager', dispatcher: 'Dispatcher', courier: 'Courier', client_viewer: 'Client viewer',
};

export function ProjectHome() {
    const { code = '' } = useParams();
    const { projects } = useAuth();
    const project = projects.find((p) => p.code === code);

    if (!project) {
        return (
            <>
                <h1>Project not available</h1>
                <p className="izy-sub">You are not a member of <code>{code}</code>, or it does not exist.</p>
                <Link className="izy-btn secondary" to="/">Back to projects</Link>
            </>
        );
    }

    const canManage = project.role === 'admin' || project.role === 'ops_manager';
    const canImport = canManage || project.role === 'dispatcher';

    /* A courier gets their run and nothing else. The rest of this page is
       sites, pricing, settings and the whole day's list of patient addresses,
       none of which is theirs to see. */
    if (project.role === 'courier') return <Navigate to={`/projects/${project.code}/my-run`} replace />;

    /* A client viewer gets their own deliveries and nothing else. This page is
       our sites, our rate card, our settings and every pharmacy's patients;
       none of it is theirs. */
    if (project.role === 'client_viewer') return <Navigate to={`/projects/${project.code}/deliveries`} replace />;

    return (
        <>
            <h1>{project.name}</h1>
            <p className="izy-sub"><code>{project.code}</code> · {project.timezone} · your role: {ROLE_LABEL[project.role] ?? project.role}</p>
            <NewOrder projectCode={project.code} canCreate={canImport} />
            <ListImport projectCode={project.code} canImport={canImport} />
            <Sites projectCode={project.code} canManage={canManage} />
            <Pricing projectCode={project.code} />
            <ProjectSettings projectCode={project.code} />
            <div className="izy-card">
                <h2>Dispatch</h2>
                <p>The board is today's wave: what is waiting, who is carrying what, and what is running late. Orders is the searchable record behind it.</p>
                <div className="izy-row">
                    <Link className="izy-btn" to={`/projects/${project.code}/board`}>Open the board</Link>
                    <Link className="izy-btn secondary" to={`/projects/${project.code}/orders`}>Search orders</Link>
                    {/* Staff see exactly what the client sees. A portal nobody
                        on our side ever looks at is a portal nobody can answer
                        a question about. */}
                    <Link className="izy-btn secondary" to={`/projects/${project.code}/deliveries`}>The client&apos;s view</Link>
                </div>
            </div>
            <div className="izy-card">
                <h2>Coming next</h2>
                <p>Address lookup, then the dispatch board and the courier app. Admins can enrol staff and couriers from <Link to="/users">Users</Link>.</p>
            </div>
        </>
    );
}
