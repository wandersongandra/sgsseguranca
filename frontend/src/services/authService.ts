import api, { refreshCsrfToken } from "@/lib/api";
import type { User } from "./usersService";

const APR_DRAFT_KEY_PREFIXES = [
  "gst.apr.wizard.draft.",
  "compliancex.apr.wizard.draft.",
];

function clearAprDraftsOnLogout() {
  if (typeof window === "undefined") {
    return;
  }

  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (
      key &&
      APR_DRAFT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      window.localStorage.removeItem(key);
    }
  }
}

export interface AuthMeResponse {
  user?: User;
  roles?: string[];
  permissions?: string[];
  isAdminGeral: boolean;
}

export interface AuthLoginResponse extends AuthMeResponse {
  accessToken: string;
}

export interface AuthMfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
  methods: string[];
}

export interface AuthMfaBootstrapResponse {
  mfaEnrollRequired: true;
  challengeToken: string;
  expiresIn: number;
  otpAuthUrl: string;
  manualEntryKey: string;
  recoveryCodes: string[];
}

export type AuthLoginResult =
  | AuthLoginResponse
  | AuthMfaChallengeResponse
  | AuthMfaBootstrapResponse;

let refreshInFlight: Promise<RefreshAccessTokenResponse> | null = null;
let logoutInFlight: Promise<void> | null = null;

export interface RefreshAccessTokenResponse {
  accessToken: string;
}

export const authService = {
  login: async (
    cpf: string,
    password: string,
    turnstileToken?: string,
  ): Promise<AuthLoginResult> => {
    const response = await api.post<AuthLoginResult>("/auth/login", {
      cpf,
      password,
      turnstileToken,
    });
    return response.data;
  },

  verifyLoginMfa: async (
    challengeToken: string,
    code: string,
  ): Promise<AuthLoginResponse> => {
    const response = await api.post<AuthLoginResponse>(
      "/auth/login/mfa/verify",
      {
        challengeToken,
        code,
      },
    );
    return response.data;
  },

  activateBootstrapMfa: async (
    challengeToken: string,
    code: string,
  ): Promise<AuthLoginResponse> => {
    const response = await api.post<AuthLoginResponse>(
      "/auth/login/mfa/bootstrap/activate",
      {
        challengeToken,
        code,
      },
    );
    return response.data;
  },

  verifyStepUp: async (payload: {
    reason: string;
    code?: string;
    password?: string;
  }): Promise<{ stepUpToken: string; expiresIn: number }> => {
    const response = await api.post<{ stepUpToken: string; expiresIn: number }>(
      "/auth/step-up/verify",
      payload,
    );
    return response.data;
  },

  getCurrentSession: async (): Promise<AuthMeResponse> => {
    const response = await api.get<AuthMeResponse>("/auth/me");
    return response.data;
  },

  refreshAccessToken: async (): Promise<RefreshAccessTokenResponse> => {
    if (!refreshInFlight) {
      refreshInFlight = api
        .post<RefreshAccessTokenResponse>("/auth/refresh")
        .then((response) => response.data)
        .finally(() => {
          refreshInFlight = null;
        });
    }

    return refreshInFlight;
  },

  logout: async (): Promise<void> => {
    if (!logoutInFlight) {
      logoutInFlight = (async () => {
        try {
          await api.post("/auth/logout");
        } finally {
          clearAprDraftsOnLogout();
        }
      })().finally(() => {
        logoutInFlight = null;
      });
    }

    return logoutInFlight;
  },

  getCsrfToken: async (): Promise<void> => {
    await refreshCsrfToken();
  },
};
