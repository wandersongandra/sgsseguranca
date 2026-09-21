'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { notificationsService, type AppNotification } from '@/services/notificationsService';
import { tokenStore } from '@/lib/tokenStore';
import { getApiBaseUrl } from '@/lib/api';
import { selectedTenantStore } from '@/lib/selectedTenantStore';
import { sessionStore } from '@/lib/sessionStore';

const ACTIVE_INTERVAL_MS   = 15_000;
const INACTIVE_INTERVAL_MS = 60_000;
const DEBOUNCE_MS          = 500;
const MAX_WS_RETRIES       = 3;
const WS_RETRY_BACKOFF     = [1_000, 2_000, 4_000] as const;

export interface UseRealtimeNotificationsResult {
  notifications: AppNotification[];
  unreadCount: number;
  markAllRead: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  refresh: () => void;
}

export function notificationBelongsToTenant(
  notification: AppNotification,
  companyId: string | null,
): boolean {
  return Boolean(companyId && notification.company_id === companyId);
}

export function prependUniqueNotification(
  current: AppNotification[],
  incoming: AppNotification,
): AppNotification[] {
  if (current.some((notification) => notification.id === incoming.id)) {
    return current;
  }

  return [incoming, ...current];
}

function resolveActiveTenantId(): string | null {
  return (
    selectedTenantStore.get()?.companyId || sessionStore.get()?.companyId || null
  );
}

function wsBaseUrl(): string | null {
  const apiUrl = getApiBaseUrl();
  if (!apiUrl) return null;

  // Em produção o app conversa com o backend via proxy same-origin
  // (NEXT_PUBLIC_API_URL = a própria origem do app na Vercel). Essa origem NÃO
  // roda servidor socket.io, então uma conexão WebSocket para ela sempre falha e
  // só cai em polling depois de esgotar o timeout — poluindo o console e
  // atrasando as notificações. Se o WebSocket apontaria para a mesma origem da
  // página, pulamos o WS e usamos polling direto. Em dev a API fica em outra
  // porta (localhost:3011 ≠ 3000), então o WS continua sendo tentado normalmente.
  if (typeof window !== 'undefined') {
    try {
      if (new URL(apiUrl).host === window.location.host) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return apiUrl.replace(/^http/i, 'ws');
}

export function useRealtimeNotifications(): UseRealtimeNotificationsResult {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const socketRef     = useRef<Socket | null>(null);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isActiveRef   = useRef(true);
  const inflightRef   = useRef<Promise<void> | null>(null);
  const inflightTenantRef = useRef<string | null>(null);
  const isPollingRef  = useRef(false);
  const wsRetryCount  = useRef(0);
  const wsRetryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyedRef  = useRef(false);
  const activeTenantRef = useRef<string | null>(resolveActiveTenantId());
  const notificationsRef = useRef<AppNotification[]>(notifications);
  const unreadCountRef = useRef(unreadCount);

  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);
  useEffect(() => { unreadCountRef.current = unreadCount; }, [unreadCount]);

  const fetchAll = useCallback(async () => {
    const requestTenantId = activeTenantRef.current;
    if (
      inflightRef.current &&
      inflightTenantRef.current === requestTenantId
    ) {
      return inflightRef.current;
    }

    const req = (async () => {
      try {
        const [listRes, countRes] = await Promise.all([
          notificationsService.findAll(1, 20),
          notificationsService.getUnreadCount(),
        ]);
        if (
          destroyedRef.current ||
          activeTenantRef.current !== requestTenantId
        ) {
          return;
        }
        notificationsRef.current = listRes.items;
        unreadCountRef.current = countRes.count;
        setNotifications(listRes.items);
        setUnreadCount(countRes.count);
      } catch {
        // polling retentará no próximo ciclo
      } finally {
        if (inflightTenantRef.current === requestTenantId) {
          inflightRef.current = null;
          inflightTenantRef.current = null;
        }
      }
    })();

    inflightRef.current = req;
    inflightTenantRef.current = requestTenantId;
    return req;
  }, []);

  const schedule = useCallback(() => {
    if (destroyedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = isActiveRef.current ? ACTIVE_INTERVAL_MS : INACTIVE_INTERVAL_MS;
    timerRef.current = setTimeout(() => {
      if (destroyedRef.current) return;
      void fetchAll().then(schedule);
    }, delay);
  }, [fetchAll]);

  const debouncedFetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void fetchAll().then(schedule);
    }, DEBOUNCE_MS);
  }, [fetchAll, schedule]);

  const startPolling = useCallback(() => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    void fetchAll().then(schedule);
  }, [fetchAll, schedule]);

  const stopPolling = useCallback(() => {
    isPollingRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const wsConnectRef = useRef<() => void>(() => {});
  const wsRetryRef = useRef<() => void>(() => {});
  const wsDisconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
  }, []);

  wsConnectRef.current = () => {
    if (destroyedRef.current) return;

    const url = wsBaseUrl();
    const token = tokenStore.get();
    if (!url || !token) {
      startPolling();
      return;
    }

    const socket = io(url, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 10_000,
    });

    socketRef.current = socket;
    let connectedOnce = false;

    socket.on('connect', () => {
      connectedOnce = true;
      wsRetryCount.current = 0;
      stopPolling();
    });

    socket.on('notification', (data: AppNotification) => {
      if (!notificationBelongsToTenant(data, activeTenantRef.current)) {
        return;
      }

      if (
        notificationsRef.current.some(
          (notification) => notification.id === data.id,
        )
      ) {
        return;
      }

      notificationsRef.current = prependUniqueNotification(
        notificationsRef.current,
        data,
      );
      unreadCountRef.current += 1;
      setNotifications([...notificationsRef.current]);
      setUnreadCount(unreadCountRef.current);
    });

    socket.on('disconnect', () => {
      if (destroyedRef.current) return;
      if (connectedOnce) {
        wsRetryCount.current = 0;
        wsRetryRef.current();
      } else {
        startPolling();
      }
    });

    socket.on('connect_error', () => {
      if (destroyedRef.current) return;
      if (connectedOnce) {
        wsRetryRef.current();
      } else {
        startPolling();
      }
    });
  };

  wsRetryRef.current = () => {
    if (wsRetryTimer.current) clearTimeout(wsRetryTimer.current);
    if (wsRetryCount.current >= MAX_WS_RETRIES) {
      wsDisconnect();
      startPolling();
      return;
    }

    const delay = WS_RETRY_BACKOFF[wsRetryCount.current] ?? 4_000;
    wsRetryCount.current += 1;
    wsRetryTimer.current = setTimeout(() => {
      if (destroyedRef.current) return;
      wsDisconnect();
      wsConnectRef.current();
    }, delay);
  };

  useEffect(() => {
    const synchronizeTenant = () => {
      const nextTenantId = resolveActiveTenantId();
      if (nextTenantId === activeTenantRef.current) return;

      activeTenantRef.current = nextTenantId;
      notificationsRef.current = [];
      unreadCountRef.current = 0;
      setNotifications([]);
      setUnreadCount(0);
      stopPolling();
      wsDisconnect();
      if (wsRetryTimer.current) clearTimeout(wsRetryTimer.current);
      wsRetryCount.current = 0;

      void fetchAll().then(schedule);
      wsConnectRef.current();
    };

    const unsubscribeTenant = selectedTenantStore.subscribe(synchronizeTenant);
    const unsubscribeSession = sessionStore.subscribe(synchronizeTenant);

    return () => {
      unsubscribeTenant();
      unsubscribeSession();
    };
  }, [fetchAll, schedule, stopPolling, wsDisconnect]);

  useEffect(() => {
    destroyedRef.current = false;
    wsRetryCount.current = 0;
    wsConnectRef.current();
    return () => {
      destroyedRef.current = true;
      wsDisconnect();
      stopPolling();
      if (wsRetryTimer.current) clearTimeout(wsRetryTimer.current);
    };
    // wsDisconnect e stopPolling são estáveis (useCallback []), wsConnectRef e wsRetryRef são refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markAllRead = useCallback(async () => {
    const prevNotifications = notificationsRef.current;
    const prevCount = unreadCountRef.current;
    const tenantAtStart = activeTenantRef.current;

    if (prevCount === 0) return;

    const nextNotifications = prevNotifications.map((n) => ({ ...n, read: true }));
    notificationsRef.current = nextNotifications;
    unreadCountRef.current = 0;

    setUnreadCount(0);
    setNotifications(nextNotifications);

    try {
      await notificationsService.markAllAsRead();
      if (activeTenantRef.current === tenantAtStart) {
        await fetchAll();
      }
    } catch (error) {
      if (activeTenantRef.current === tenantAtStart) {
        await fetchAll();
      }
      throw error;
    }
  }, [fetchAll]);

  const markRead = useCallback(
    async (id: string) => {
      const prevNotifications = notificationsRef.current;
      const prevCount = unreadCountRef.current;
      const tenantAtStart = activeTenantRef.current;

      let changed = false;
      const nextNotifications = prevNotifications.map((n) => {
        if (n.id === id && !n.read) {
          changed = true;
          return { ...n, read: true };
        }
        return n;
      });

      if (!changed) return;

      const nextUnreadCount = Math.max(0, prevCount - 1);
      notificationsRef.current = nextNotifications;
      unreadCountRef.current = nextUnreadCount;

      setNotifications(nextNotifications);
      setUnreadCount(nextUnreadCount);

      try {
        await notificationsService.markAsRead(id);
        if (activeTenantRef.current === tenantAtStart) {
          await fetchAll();
        }
      } catch (error) {
        if (activeTenantRef.current === tenantAtStart) {
          await fetchAll();
        }
        throw error;
      }
    },
    [fetchAll],
  );

  const refresh = useCallback(() => {
    debouncedFetch();
  }, [debouncedFetch]);

  return { notifications, unreadCount, markAllRead, markRead, refresh };
}
