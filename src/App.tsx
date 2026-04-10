import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import PortalLayout from './components/PortalLayout';
import LoginPage from './pages/LoginPage';
import ProjectsPage from './pages/ProjectsPage';
import EquipmentPage from './pages/EquipmentPage';
import DocumentsPage from './pages/DocumentsPage';
import ContactPage from './pages/ContactPage';
import './index.css';

function ProtectedRoutes() {
    const { isAuthenticated, loading } = useAuth();
    if (loading) return null;
    if (!isAuthenticated) return <Navigate to="/login" replace />;

    return (
        <PortalLayout>
            <Routes>
                <Route index element={<ProjectsPage />} />
                <Route path="equipment" element={<EquipmentPage />} />
                <Route path="documents" element={<DocumentsPage />} />
                <Route path="contact" element={<ContactPage />} />
            </Routes>
        </PortalLayout>
    );
}

function AppRoutes() {
    const { isAuthenticated, loading } = useAuth();

    if (loading) return null;

    return (
        <Routes>
            <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />} />
            <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </BrowserRouter>
    );
}
