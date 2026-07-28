import { useNavigate } from 'react-router-dom';
import { Bell, AlertTriangle, Clock, CheckCheck, X, Truck, Shield, FileText } from 'lucide-react';
import { useNotifications, type PortalNotification } from '../context/NotificationsContext';

const CATEGORY_ICONS = {
    calibration: Shield,
    shipment: Truck,
    document: FileText,
    system: Bell,
};

function NotificationItem({ notification, onRead, onDismiss }: {
    notification: PortalNotification;
    onRead: () => void;
    onDismiss: () => void;
}) {
    const navigate = useNavigate();
    const CategoryIcon = CATEGORY_ICONS[notification.category];

    const handleClick = () => {
        onRead();
        if (notification.link) navigate(notification.link);
    };

    return (
        <div
            className={`notification-item ${!notification.read ? 'notification-item--unread' : ''} notification-item--${notification.severity}`}
            onClick={handleClick}
        >
            <div className={`notification-icon notification-icon--${notification.severity}`}>
                {notification.severity === 'critical' ? <AlertTriangle size={18} /> :
                 notification.severity === 'warning' ? <Clock size={18} /> :
                 <CategoryIcon size={18} />}
            </div>
            <div className="notification-content">
                <div className="notification-title">{notification.title}</div>
                <div className="notification-message">{notification.message}</div>
                <div className="notification-time">{notification.timeAgo}</div>
            </div>
            <button
                className="notification-dismiss"
                onClick={(e) => { e.stopPropagation(); onDismiss(); }}
                title="Dismiss"
            >
                <X size={16} />
            </button>
        </div>
    );
}

export default function NotificationsPage() {
    const { notifications, unreadCount, markRead, markAllRead, dismiss } = useNotifications();

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1>Notifications</h1>
                    <p className="page-subtitle">
                        {unreadCount > 0 ? `${unreadCount} unread alert${unreadCount !== 1 ? 's' : ''}` : 'All caught up'}
                    </p>
                </div>
                {unreadCount > 0 && (
                    <button className="btn btn--ghost" onClick={markAllRead}>
                        <CheckCheck size={16} />
                        Mark all read
                    </button>
                )}
            </div>

            {notifications.length === 0 ? (
                <div className="empty-state">
                    <Bell size={40} />
                    <p>No notifications right now.</p>
                </div>
            ) : (
                <div className="notification-list">
                    {notifications.map((n) => (
                        <NotificationItem
                            key={n.id}
                            notification={n}
                            onRead={() => markRead(n.id)}
                            onDismiss={() => dismiss(n.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
