import { useState } from 'react';
import { Phone, Mail, Clock, Send, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function ContactPage() {
    const { customer } = useAuth();
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [category, setCategory] = useState('general');
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        // TODO: POST to /api/portal/support
        setSubmitted(true);
        setTimeout(() => {
            setSubmitted(false);
            setSubject('');
            setMessage('');
            setCategory('general');
        }, 3000);
    };

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Support & Contact</h1>
                    <p className="page-subtitle">Get in touch with your Hydro-Wates team</p>
                </div>
            </div>

            <div className="contact-grid">
                {/* Contact Cards */}
                <div className="contact-cards">
                    <div className="contact-card">
                        <Phone size={24} />
                        <h3>Phone</h3>
                        <a href="tel:+17135551234" className="contact-value">(713) 555-1234</a>
                        <p className="contact-note">Mon-Fri, 7am - 5pm CST</p>
                    </div>
                    <div className="contact-card">
                        <Mail size={24} />
                        <h3>Email</h3>
                        <a href="mailto:support@hydro-wates.com" className="contact-value">support@hydro-wates.com</a>
                        <p className="contact-note">We respond within 4 business hours</p>
                    </div>
                    <div className="contact-card">
                        <Clock size={24} />
                        <h3>Emergency</h3>
                        <a href="tel:+17135559999" className="contact-value">(713) 555-9999</a>
                        <p className="contact-note">24/7 for on-site emergencies</p>
                    </div>
                </div>

                {/* Support Form */}
                <div className="support-form-card">
                    <h2>Send a Message</h2>
                    {submitted ? (
                        <div className="form-success">
                            <CheckCircle2 size={40} />
                            <h3>Message Sent</h3>
                            <p>We'll get back to you shortly at {customer?.contactEmail}</p>
                        </div>
                    ) : (
                        <form onSubmit={handleSubmit} className="support-form">
                            <div className="form-field">
                                <label>Category</label>
                                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                                    <option value="general">General Inquiry</option>
                                    <option value="scheduling">Scheduling / Delivery</option>
                                    <option value="equipment">Equipment Issue</option>
                                    <option value="billing">Billing</option>
                                    <option value="extension">Hire Extension</option>
                                    <option value="quote">New Quote Request</option>
                                </select>
                            </div>
                            <div className="form-field">
                                <label>Subject</label>
                                <input
                                    type="text"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                    placeholder="Brief description"
                                    required
                                />
                            </div>
                            <div className="form-field">
                                <label>Message</label>
                                <textarea
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    placeholder="How can we help?"
                                    rows={5}
                                    required
                                />
                            </div>
                            <button type="submit" className="btn btn--primary">
                                <Send size={16} />
                                Send Message
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
