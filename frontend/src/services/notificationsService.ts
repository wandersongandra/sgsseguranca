import api from "@/lib/api";
import { AxiosError } from "axios";

export interface AppNotification {
  id: string;
  company_id?: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
  readAt?: string | null;
}

interface FindAllResponse {
  items: AppNotification[];
  total: number;
  page: number;
  limit: number;
}

type UnreadCountResponse = number | { count?: number | string | null };

export function normalizeUnreadCountResponse(
  payload: UnreadCountResponse,
): { count: number } {
  const countValue = typeof payload === "number" ? payload : payload?.count;
  const rawCount =
    typeof countValue === "number" ? countValue : Number(countValue ?? 0);

  return {
    count:
      Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : 0,
  };
}

function readRetryAfterHeader(
  error: AxiosError,
): string | number | string[] | undefined {
  const headers = error.response?.headers;

  if (!headers) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    const headerValue = headers.get("retry-after");
    return typeof headerValue === "string" ? headerValue : undefined;
  }

  const headerValue = headers["retry-after"];

  if (
    typeof headerValue === "string" ||
    typeof headerValue === "number" ||
    Array.isArray(headerValue)
  ) {
    return headerValue;
  }

  return undefined;
}

export function getRetryAfterMsFromError(
  error: unknown,
  fallbackMs = 60_000,
): number | null {
  if (!(error instanceof AxiosError) || error.response?.status !== 429) {
    return null;
  }

  const headerValue = readRetryAfterHeader(error);
  const retryAfterSeconds = Array.isArray(headerValue)
    ? Number.parseInt(headerValue[0] || "", 10)
    : Number.parseInt(String(headerValue || ""), 10);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  return fallbackMs;
}

export const notificationsService = {
  async findAll(page = 1, limit = 20): Promise<FindAllResponse> {
    const res = await api.get<FindAllResponse>("/notifications", {
      params: { page, limit },
    });
    return res.data;
  },

  async getUnreadCount(): Promise<{ count: number }> {
    const res = await api.get<UnreadCountResponse>(
      "/notifications/unread-count",
    );
    return normalizeUnreadCountResponse(res.data);
  },

  async markAsRead(id: string): Promise<void> {
    await api.patch(`/notifications/${id}/read`);
  },

  async markAllAsRead(): Promise<void> {
    await api.post("/notifications/read-all");
  },
};
