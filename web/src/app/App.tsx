import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, courierOnlyProject } from './auth';
import { Layout } from './Layout';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Users } from '../pages/Users';
import { UserDetail } from '../pages/UserDetail';
import { Devices } from '../pages/Devices';
import { Audit } from '../pages/Audit';
import { LegacyTvhs } from '../pages/LegacyTvhs';

function AdminOnly({ children }: { children: JSX.Element }) {
    const { user } = useAuth();
    return user?.role === 'admin' ? children : <Navigate to="/" replace />;
}

export function App() {
    const { loading, user, projects } = useAuth();
    const location = useLocation();

    if (loading) return <div className="izy-login"><div className="izy-muted">Loading...</div></div>;
    if (!user) return <Login />;

    // Couriers with one project land in that project's app, no shell chrome.
    const courier = courierOnlyProject(user, projects);
    if (courier && location.pathname === '/') {
        return <Navigate to={`/projects/${courier.code}/${courier.code}`} replace />;
    }

    return (
        <Routes>
            <Route path="/projects/tvhs/tvhs/*" element={<LegacyTvhs />} />
            <Route element={<Layout />}>
                <Route path="/" element={<Home />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
                <Route path="/users/:username" element={<AdminOnly><UserDetail /></AdminOnly>} />
                <Route path="/audit" element={<AdminOnly><Audit /></AdminOnly>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
