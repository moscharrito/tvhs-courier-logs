/* Landing page for a project that has no module screens yet (UH until the
   dispatch module ships in Phases 1 and 2). Members see the project and
   their role; the TVHS project never lands here because its route mounts
   the legacy app directly. */

import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../app/auth';
import { Sites } from './uh/Sites';
import { Pricing } from './uh/Pricing';
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

    return (
        <>
            <h1>{project.name}</h1>
            <p className="izy-sub"><code>{project.code}</code> · {project.timezone} · your role: {ROLE_LABEL[project.role] ?? project.role}</p>
            <Sites projectCode={project.code} canManage={canManage} />
            <Pricing projectCode={project.code} />
            <ProjectSettings projectCode={project.code} />
            <div className="izy-card">
                <h2>Coming next</h2>
                <p>Daily list intake and address lookup, then the dispatch board and the courier app. Admins can enrol staff and couriers from <Link to="/users">Users</Link>.</p>
            </div>
        </>
    );
}
