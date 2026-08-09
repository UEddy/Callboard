import { createCookie } from "react-router";

export const submitSession = createCookie("cb_submit", {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 30,
  secrets: ["callboard-dev-secret-change-me"],
});

export type SubmitSession = {
  participantId?: string;
  submissionId?: string;
};

export async function readSession(request: Request): Promise<SubmitSession> {
  const parsed = await submitSession.parse(request.headers.get("Cookie"));
  return (parsed as SubmitSession) ?? {};
}

export async function writeSession(data: SubmitSession) {
  return await submitSession.serialize(data);
}

export const portalSession = createCookie("cb_portal", {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 60,
  secrets: ["callboard-dev-secret-change-me"],
});

export async function readPortal(request: Request): Promise<{ participantId?: string }> {
  const parsed = await portalSession.parse(request.headers.get("Cookie"));
  return (parsed as { participantId?: string }) ?? {};
}

export async function writePortal(data: { participantId?: string }) {
  return await portalSession.serialize(data);
}