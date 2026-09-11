import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './Layout';
import { Loading } from './Loading';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Users } from '../pages/Users';
import { UserDetail } from '../pages/UserDetail';
import { Devices } from '../pages/Devices';
import { Audit } from '../pages/Audit';
import { LegacyTvhs } from '../pages/LegacyTvhs';
import { ProjectHome } from '../pages/ProjectHome';

function AdminOnly({ children }: { children: JSX.Element }) {
    const { user } = useAuth();
    return user?.role === 'admin' ? children : <Navigate to="/" replace />;
}

export function App() {
    const { loading, user } = useAuth();

    if (loading) return <Loading full />;
    if (!user) return <Login />;

    // Everyone lands on the project picker after sign-in and chooses where to go.
    return (
        <Routes>
            <Route path="/projects/tvhs/tvhs/*" element={<LegacyTvhs />} />
            <Route element={<Layout />}>
                <Route path="/" element={<Home />} />
                <Route path="/projects/:code/*" element={<ProjectHome />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
                <Route path="/users/:username" element={<AdminOnly><UserDetail /></AdminOnly>} />
                <Route path="/audit" element={<AdminOnly><Audit /></AdminOnly>} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
        </Routes>
    );
}
