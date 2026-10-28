import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

import { db } from "~/server/db";
import * as schema from "~/server/db/schema";
import { env } from "~/shared/config/env";
import { sendEmail as defaultSendEmail, type EmailSender } from "./email";

/** Login codes stay valid for 10 minutes (spec 0001, scenario B1). */
export const LOGIN_CODE_TTL_SECONDS = 600;

const DEV_SECRET = "development-only-insecure-secret-0123456789abcdef";

/**
 * The server secret. Falls back to an insecure dev default outside production
 * so tests and local development need no secret; production refuses to start
 * without `BETTER_AUTH_SECRET`.
 */
export function serverSecret(): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }
  return DEV_SECRET;
}

/**
 * Build a Better Auth instance. Tests pass a fake `sendEmail` to capture login
 * codes; production code uses the default `auth` export.
 */
export function createAuthInstance({ sendEmail }: { sendEmail: EmailSender }) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: serverSecret(),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verification: schema.verification,
        organizations: schema.organizations,
        members: schema.members,
        invitations: schema.invitations,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
        jwks: schema.jwks,
      },
    }),
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verification" },
    plugins: [
      emailOTP({
        expiresIn: LOGIN_CODE_TTL_SECONDS,
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") return;
          await sendEmail(
            email,
            "Your RipCord login code",
            `Your RipCord login code is: ${otp}\nIt expires in 10 minutes.`,
          );
        },
      }),
      organization({
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
        },
        sendInvitationEmail: async (data) => {
          await sendEmail(
            data.email,
            `Join ${data.organization.name} on RipCord`,
            `${data.inviter.user.name} invited you to join ${data.organization.name} on RipCord.\nAccept it here: ${env.BETTER_AUTH_URL}/accept-invitation/${data.id}`,
          );
        },
      }),
      admin(),
      // Required by oauthProvider; holds its signing keys.
      jwt(),
      // Spec 0006: the MCP authorization server. The installed plugin
      // (1.7.14) has no `validAudiences` option; the equivalent is the
      // `resources` entry below, which seeds the `oauthResource` row that
      // access-token audiences must resolve to. Keep the identifier in step
      // with `mcpResourceUrl` in `~/features/chat`.
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access", "ripcord"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        resources: [`${env.APP_URL}/api/mcp`],
        clientRegistrationDefaultResources: [`${env.APP_URL}/api/mcp`],
      }),
    ],
  });
}

export const auth = createAuthInstance({ sendEmail: defaultSendEmail });

export type Auth = typeof auth;
