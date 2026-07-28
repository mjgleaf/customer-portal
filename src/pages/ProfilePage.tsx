import { useState } from 'react';
import { User, Mail, Phone, Bell, Save, Shield } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function ProfilePage() {
    const { customer } = useAuth();
    const { addToast } = useToast();

    const [contactName, setContactName] = useState(customer?.contactName || '');
    const [contactEmail, setContactEmail] = useState(customer?.contactEmail || '');
    const [phone, setPhone] = useState('');
    const [notifyShipments, setNotifyShipments] = useState(true);
    const [notifyCalibration, setNotifyCalibration] = useState(true);
    const [notifyDocuments, setNotifyDocuments] = useState(true);
    const [saving, setSaving] = useState(false);

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        // Simulate save
        await new Promise(r => setTimeout(r, 800));
        setSaving(false);
        addToast('success', 'Profile settings saved successfully.');
    };

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Profile & Settings</h1>
                    <p className="page-subtitle">Manage your account preferences</p>
                </div>
            </div>

            <div className="profile-layout">
                {/* Profile Card */}
                <div className="profile-card">
                    <div className="profile-avatar">
                        <User size={32} />
                    </div>
                    <h2 className="profile-name">{customer?.contactName}</h2>
                    <p className="profile-company">{customer?.companyName}</p>
                    <p className="profile-email">{customer?.contactEmail}</p>
                    <div className="profile-badge">
                        <Shield size={14} />
                        Active Account
                    </div>
                </div>

                {/* Settings Form */}
                <form className="settings-card" onSubmit={handleSave}>
                    <h2 className="settings-section-title">Contact Information</h2>
                    <div className="settings-fields">
                        <div className="form-field">
                            <label><User size={14} /> Full Name</label>
                            <input
                                type="text"
                                value={contactName}
                                onChange={(e) => setContactName(e.target.value)}
                                placeholder="Your name"
                            />
                        </div>
                        <div className="form-field">
                            <label><Mail size={14} /> Email</label>
                            <input
                                type="email"
                                value={contactEmail}
                                onChange={(e) => setContactEmail(e.target.value)}
                                placeholder="your@email.com"
                            />
                        </div>
                        <div className="form-field">
                            <label><Phone size={14} /> Phone</label>
                            <input
                                type="tel"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                placeholder="(555) 000-0000"
                            />
                        </div>
                    </div>

                    <h2 className="settings-section-title">
                        <Bell size={16} />
                        Email Notifications
                    </h2>
                    <div className="settings-toggles">
                        <label className="toggle-row">
                            <div className="toggle-info">
                                <span className="toggle-label">Shipment Updates</span>
                                <span className="toggle-desc">Get notified when equipment ships or is delivered</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle-input"
                                checked={notifyShipments}
                                onChange={(e) => setNotifyShipments(e.target.checked)}
                            />
                            <span className="toggle-switch" />
                        </label>
                        <label className="toggle-row">
                            <div className="toggle-info">
                                <span className="toggle-label">Calibration Alerts</span>
                                <span className="toggle-desc">Warnings when equipment calibration is expiring</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle-input"
                                checked={notifyCalibration}
                                onChange={(e) => setNotifyCalibration(e.target.checked)}
                            />
                            <span className="toggle-switch" />
                        </label>
                        <label className="toggle-row">
                            <div className="toggle-info">
                                <span className="toggle-label">New Documents</span>
                                <span className="toggle-desc">Get notified when new documents are available</span>
                            </div>
                            <input
                                type="checkbox"
                                className="toggle-input"
                                checked={notifyDocuments}
                                onChange={(e) => setNotifyDocuments(e.target.checked)}
                            />
                            <span className="toggle-switch" />
                        </label>
                    </div>

                    <button type="submit" className="btn btn--primary" disabled={saving}>
                        <Save size={16} />
                        {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                </form>
            </div>
        </div>
    );
}
