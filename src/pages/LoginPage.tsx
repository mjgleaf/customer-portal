import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
    const { login, loading, error } = useAuth();

    const handleSignIn = () => {
        login();
    };

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-brand">
                    <span className="brand-mark brand-mark--lg">HW</span>
                    <h1>Client Portal</h1>
                    <p>Sign in to track your projects, equipment, and documents.</p>
                </div>

                {error && <div className="form-error">{error}</div>}

                <button
                    type="button"
                    className="btn btn--primary btn--full"
                    disabled={loading}
                    onClick={handleSignIn}
                >
                    {loading ? 'Redirecting...' : 'Sign in with Azure AD'}
                </button>

                <p className="login-footer">
                    Need access? Contact <a href="mailto:support@hydro-wates.com">support@hydro-wates.com</a>
                </p>
            </div>
        </div>
    );
}
