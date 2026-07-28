import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useCustomerEquipment } from '../hooks/useCustomerEquipment';
import { useCustomerProjects } from '../hooks/useCustomerProjects';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface PortalNotification {
    id: string;
    title: string;
    message: string;
    severity: NotificationSeverity;
    timestamp: Date;
    timeAgo: string;
    read: boolean;
    category: 'calibration' | 'shipment' | 'document' | 'system';
    link?: string;
}

interface NotificationsContextValue {
    notifications: PortalNotification[];
    unreadCount: number;
    markRead: (id: string) => void;
    markAllRead: () => void;
    dismiss: (id: string) => void;
}

const NotificationsContext = createContext<NotificationsContextValue>({
    notifications: [],
    unreadCount: 0,
    markRead: () => {},
    markAllRead: () => {},
    dismiss: () => {},
});

export function useNotifications() {
    return useContext(NotificationsContext);
}

function timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
    const { equipment } = useCustomerEquipment();
    const { projects } = useCustomerProjects();
    const [notifications, setNotifications] = useState<PortalNotification[]>([]);
    const [dismissed, setDismissed] = useState<Set<string>>(() => {
        const saved = sessionStorage.getItem('portal-dismissed-notifications');
        return saved ? new Set(JSON.parse(saved)) : new Set();
    });
    const [readIds, setReadIds] = useState<Set<string>>(() => {
        const saved = sessionStorage.getItem('portal-read-notifications');
        return saved ? new Set(JSON.parse(saved)) : new Set();
    });

    // Generate notifications from data
    useEffect(() => {
        const notifs: PortalNotification[] = [];

        // Calibration alerts
        equipment.forEach((eq) => {
            if (eq.urgency === 'EXPIRED') {
                notifs.push({
                    id: `cal-expired-${eq.serialNumber}`,
                    title: `Calibration expired: ${eq.serialNumber}`,
                    message: `${eq.description} calibration expired on ${new Date(eq.expirationDate).toLocaleDateString()}. Equipment must not be used until recalibrated.`,
                    severity: 'critical',
                    timestamp: new Date(eq.expirationDate),
                    timeAgo: timeAgo(new Date(eq.expirationDate)),
                    read: false,
                    category: 'calibration',
                    link: '/equipment',
                });
            } else if (eq.urgency === 'CRITICAL') {
                notifs.push({
                    id: `cal-critical-${eq.serialNumber}`,
                    title: `Calibration critical: ${eq.serialNumber}`,
                    message: `${eq.description} calibration expires in ${eq.daysUntilExpiry} days. Schedule recalibration now.`,
                    severity: 'critical',
                    timestamp: new Date(),
                    timeAgo: 'Now',
                    read: false,
                    category: 'calibration',
                    link: '/equipment',
                });
            } else if (eq.urgency === 'WARNING' || eq.urgency === 'NOTICE') {
                notifs.push({
                    id: `cal-notice-${eq.serialNumber}`,
                    title: `Calibration expiring: ${eq.serialNumber}`,
                    message: `${eq.description} calibration expires in ${eq.daysUntilExpiry} days.`,
                    severity: 'warning',
                    timestamp: new Date(),
                    timeAgo: 'Now',
                    read: false,
                    category: 'calibration',
                    link: '/equipment',
                });
            }
        });

        // Shipment alerts
        projects.forEach((proj) => {
            const shipments = [
                { s: proj.outbound, label: 'Outbound' },
                { s: proj.return, label: 'Return' },
            ];
            shipments.forEach(({ s, label }) => {
                if (!s) return;
                if (s.status === 'IN_TRANSIT') {
                    notifs.push({
                        id: `ship-transit-${s.id}`,
                        title: `${label} shipment in transit: ${proj.projectNumber}`,
                        message: `${s.carrier} shipping from ${s.origin} to ${s.destination}. ETA: ${new Date(s.etaDate).toLocaleDateString()}`,
                        severity: 'info',
                        timestamp: new Date(s.lastUpdateTime),
                        timeAgo: timeAgo(new Date(s.lastUpdateTime)),
                        read: false,
                        category: 'shipment',
                        link: '/projects',
                    });
                } else if (s.status === 'EXCEPTION') {
                    notifs.push({
                        id: `ship-exception-${s.id}`,
                        title: `Shipment exception: ${proj.projectNumber}`,
                        message: `${label} shipment via ${s.carrier} has an exception. Contact support if needed.`,
                        severity: 'critical',
                        timestamp: new Date(s.lastUpdateTime),
                        timeAgo: timeAgo(new Date(s.lastUpdateTime)),
                        read: false,
                        category: 'shipment',
                        link: '/projects',
                    });
                } else if (s.status === 'DELIVERED' && s.deliveryDate) {
                    const deliveredDate = new Date(s.deliveryDate);
                    const daysSince = Math.floor((Date.now() - deliveredDate.getTime()) / 86400000);
                    if (daysSince <= 7) {
                        notifs.push({
                            id: `ship-delivered-${s.id}`,
                            title: `${label} delivered: ${proj.projectNumber}`,
                            message: `Delivered to ${s.destination} on ${deliveredDate.toLocaleDateString()}.`,
                            severity: 'info',
                            timestamp: deliveredDate,
                            timeAgo: timeAgo(deliveredDate),
                            read: false,
                            category: 'shipment',
                            link: '/projects',
                        });
                    }
                }
            });
        });

        // Sort by severity then timestamp
        const severityOrder: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };
        notifs.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.timestamp.getTime() - a.timestamp.getTime());

        // Apply read/dismissed state
        const final = notifs
            .filter(n => !dismissed.has(n.id))
            .map(n => ({ ...n, read: readIds.has(n.id) }));

        setNotifications(final);
    }, [equipment, projects, dismissed, readIds]);

    const markRead = useCallback((id: string) => {
        setReadIds(prev => {
            const next = new Set(prev);
            next.add(id);
            sessionStorage.setItem('portal-read-notifications', JSON.stringify([...next]));
            return next;
        });
    }, []);

    const markAllRead = useCallback(() => {
        setReadIds(prev => {
            const next = new Set(prev);
            notifications.forEach(n => next.add(n.id));
            sessionStorage.setItem('portal-read-notifications', JSON.stringify([...next]));
            return next;
        });
    }, [notifications]);

    const dismiss = useCallback((id: string) => {
        setDismissed(prev => {
            const next = new Set(prev);
            next.add(id);
            sessionStorage.setItem('portal-dismissed-notifications', JSON.stringify([...next]));
            return next;
        });
    }, []);

    const unreadCount = notifications.filter(n => !n.read).length;

    return (
        <NotificationsContext.Provider value={{ notifications, unreadCount, markRead, markAllRead, dismiss }}>
            {children}
        </NotificationsContext.Provider>
    );
}
